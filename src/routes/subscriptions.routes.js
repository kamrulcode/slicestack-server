import { Router } from "express";
import { collections } from "../config/db.js";
import { requireAuth, requireVendor } from "../middleware/auth.js";
import { ApiError, asyncHandler, serialize } from "../utils/http.js";
import { planForShop } from "./menu.routes.js";
import {
  getStripe,
  getWebhookSecret,
  isStripeConfigured,
  premiumUntilFromNow,
} from "../services/stripe.js";

const router = Router();

const FREE_PLAN_ITEM_LIMIT = 3;

const PLANS = {
  free: {
    id: "free",
    name: "Free",
    price: 0,
    currency: "usd",
    interval: "month",
    itemLimit: FREE_PLAN_ITEM_LIMIT,
    features: [
      `Up to ${FREE_PLAN_ITEM_LIMIT} active menu items`,
      "Vendor dashboard and order management",
      "Customer reviews and order tracking",
    ],
  },
  premium: {
    id: "premium",
    name: "Premium",
    price: Number(process.env.STRIPE_PREMIUM_PRICE || 19),
    currency: "usd",
    interval: "month",
    itemLimit: null,
    features: [
      "Unlimited active menu items",
      "Premium vendor badge",
      "Featured menu placement",
      "All Free plan features",
    ],
  },
};

// VENDOR: current plan, usage and upgrade state.
router.get(
  "/vendor/subscription",
  requireAuth,
  requireVendor,
  asyncHandler(async (req, res) => {
    const plan = planForShop(req.shop);
    const activeItems = await collections.menus.countDocuments({
      ownerId: req.user.id,
      status: { $ne: "rejected" },
    });

    const recent = await collections.transactions
      .find({ vendorId: req.user.id })
      .sort({ createdAt: -1 })
      .limit(10)
      .toArray();

    res.status(200).json(
      serialize({
        plan,
        plans: PLANS,
        premiumUntil: req.shop.premiumUntil ?? null,
        activeItems,
        itemLimit: plan === "premium" ? null : FREE_PLAN_ITEM_LIMIT,
        paymentsEnabled: isStripeConfigured(),
        transactions: recent,
      }),
    );
  }),
);

// VENDOR: create a Stripe Checkout session for the signed-in shop only.
router.post(
  "/vendor/subscription/checkout",
  requireAuth,
  requireVendor,
  asyncHandler(async (req, res) => {
    if (!isStripeConfigured()) {
      throw new ApiError(
        503,
        "Payments are not configured yet. Add STRIPE_SECRET_KEY and STRIPE_PRICE_ID to the server environment.",
      );
    }

    if (planForShop(req.shop) === "premium") {
      throw new ApiError(409, "Your shop already has an active Premium plan.");
    }

    const stripe = getStripe();
    const clientUrl = (process.env.CLIENT_URL || "http://localhost:3000").replace(
      /\/$/,
      "",
    );

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      customer_email: req.user.email,
      client_reference_id: req.user.id,
      metadata: {
        vendorId: req.user.id,
        shopId: req.shop._id.toString(),
        plan: "premium",
      },
      success_url: `${clientUrl}/dashboard/vendor/subscription?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${clientUrl}/dashboard/vendor/subscription?payment=cancelled`,
    });

    await collections.transactions.insertOne({
      stripeSessionId: session.id,
      vendorId: req.user.id,
      shopId: req.shop._id.toString(),
      vendorName: req.shop.name,
      vendorEmail: req.user.email,
      plan: "premium",
      amount: (session.amount_total ?? 0) / 100,
      amountMinor: session.amount_total ?? 0,
      currency: session.currency ?? "usd",
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    res.status(201).json({ ok: true, url: session.url });
  }),
);

async function activatePremium(session) {
  const vendorId = session.metadata?.vendorId || session.client_reference_id;
  if (!vendorId) return;

  const now = new Date();
  const transaction = await collections.transactions.findOne({
    stripeSessionId: session.id,
  });

  // Idempotent: a replayed webhook must not extend the plan twice.
  if (transaction?.status === "succeeded") return;

  const premiumUntil = premiumUntilFromNow(now);

  await collections.transactions.updateOne(
    { stripeSessionId: session.id },
    {
      $set: {
        status: "succeeded",
        stripePaymentIntentId:
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : session.payment_intent?.id ?? null,
        paidAt: now,
        updatedAt: now,
      },
    },
    { upsert: false },
  );

  await collections.shops.updateOne(
    { ownerId: vendorId },
    { $set: { plan: "premium", premiumUntil, updatedAt: now } },
  );
}

async function markTransaction(session, status, extra = {}) {
  await collections.transactions.updateOne(
    { stripeSessionId: session.id },
    { $set: { status, updatedAt: new Date(), ...extra } },
  );
}

/**
 * Stripe webhook. Mounted before express.json so the raw body is available for
 * signature verification. Premium is granted only here, never from a redirect.
 */
export async function stripeWebhookHandler(req, res) {
  let event;

  try {
    const stripe = getStripe();
    const signature = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      getWebhookSecret(),
    );
  } catch (error) {
    res.status(400).json({ error: `Webhook signature verification failed: ${error.message}` });
    return;
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        if (session.payment_status === "paid") {
          await activatePremium(session);
        }
        break;
      }
      case "checkout.session.async_payment_failed":
      case "checkout.session.expired": {
        await markTransaction(event.data.object, "failed");
        break;
      }
      default:
        break;
    }
  } catch (error) {
    console.error("Stripe webhook handling failed:", error);
    res.status(500).json({ error: "Webhook handling failed." });
    return;
  }

  res.status(200).json({ received: true });
}

export default router;
