import { Router } from "express";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collections } from "../config/db.js";
import { requireAuth, requireVendor } from "../middleware/auth.js";
import { ApiError, asyncHandler, serialize } from "../utils/http.js";
import { planForShop } from "./menu.routes.js";
import {
  getStripe,
  getWebhookSecret,
  isStripeConfigured,
} from "../services/stripe.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

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
    console.log("SUBSCRIPTION ROUTE HIT");

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

// VENDOR: create a recurring Stripe Checkout session for the signed-in shop.
router.post(
  "/vendor/subscription/checkout",
  requireAuth,
  requireVendor,
  asyncHandler(async (req, res) => {
    if (!isStripeConfigured()) {
      throw new ApiError(
        503,
        "Payments are not configured yet. Add STRIPE_SECRET_KEY and a recurring STRIPE_PRICE_ID to the server environment.",
      );
    }

    if (planForShop(req.shop) === "premium") {
      throw new ApiError(409, "Your shop already has an active Premium plan.");
    }

    const stripe = getStripe();
    const clientUrl = (
      process.env.CLIENT_URL || "http://localhost:3000"
    ).replace(/\/$/, "");

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      customer_email: req.user.email,
      client_reference_id: req.user.id,
      metadata: {
        vendorId: req.user.id,
        shopId: req.shop._id.toString(),
        shopName: req.shop.name,
        vendorEmail: req.user.email,
        plan: "premium",
      },
      subscription_data: {
        metadata: {
          vendorId: req.user.id,
          shopId: req.shop._id.toString(),
          shopName: req.shop.name,
          vendorEmail: req.user.email,
          plan: "premium",
        },
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
      stripeSubscriptionId:
        typeof session.subscription === "string"
          ? session.subscription
          : (session.subscription?.id ?? null),
      stripeCustomerId:
        typeof session.customer === "string"
          ? session.customer
          : (session.customer?.id ?? null),
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

// VENDOR: verify a completed Stripe Checkout session and activate premium.
// This is the primary activation path: after the user is redirected back from
// Stripe Checkout the client calls this endpoint with the session_id. It
// retrieves the session from Stripe, checks the payment status, and upgrades
// the shop if the payment succeeded. This works with or without webhooks.
router.post(
  "/vendor/subscription/verify",
  requireAuth,
  requireVendor,
  asyncHandler(async (req, res) => {
    const sessionId = req.body?.session_id;
    if (!sessionId || typeof sessionId !== "string") {
      throw new ApiError(400, "A valid session_id is required.");
    }

    if (!isStripeConfigured()) {
      throw new ApiError(503, "Payments are not configured yet.");
    }

    const stripe = getStripe();

    // Retrieve the full checkout session from Stripe.
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription", "payment_intent"],
    });

    // The session must belong to this vendor.
    const vendorId = session.metadata?.vendorId || session.client_reference_id;
    if (vendorId !== req.user.id) {
      throw new ApiError(403, "This session does not belong to your account.");
    }

    // If the payment succeeded, activate premium.
    if (
      session.mode === "subscription" &&
      ["paid", "no_payment_required"].includes(session.payment_status)
    ) {
      await activatePremium(session);
    } else if (session.status === "expired") {
      await markTransaction(session, "failed");
    }

    // Retrieve the updated transaction from the database.
    const transaction = await collections.transactions.findOne({
      stripeSessionId: session.id,
    });

    res.status(200).json({
      ok: true,
      paymentStatus: session.payment_status,
      sessionStatus: session.status,
      plan: planForShop(
        await collections.shops.findOne({ ownerId: req.user.id }),
      ),
      transaction: transaction ? serialize(transaction) : null,
    });
  }),
);

function stripeObjectId(value) {
  return typeof value === "string" ? value : (value?.id ?? null);
}

function subscriptionIdFromInvoice(invoice) {
  return (
    stripeObjectId(invoice.subscription) ??
    stripeObjectId(invoice.parent?.subscription_details?.subscription)
  );
}

async function updateShopSubscription(subscription, vendorId) {
  if (!vendorId) return;

  const now = new Date();
  const hasPeriodEnd = typeof subscription.current_period_end === "number";
  const premiumUntil = hasPeriodEnd
    ? new Date(subscription.current_period_end * 1000)
    : now;
  const hasPaidAccess =
    ["active", "trialing", "past_due"].includes(subscription.status) &&
    premiumUntil > now;

  await collections.shops.updateOne(
    { ownerId: vendorId },
    {
      $set: {
        plan: hasPaidAccess ? "premium" : "free",
        premiumUntil,
        updatedAt: now,
      },
    },
  );

  await collections.transactions.updateMany(
    { stripeSubscriptionId: subscription.id },
    {
      $set: {
        stripeSubscriptionStatus: subscription.status,
        updatedAt: now,
      },
    },
  );
}

async function activatePremium(session) {
  const vendorId = session.metadata?.vendorId || session.client_reference_id;
  const subscriptionId = stripeObjectId(session.subscription);
  if (!vendorId || !subscriptionId) return;

  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  if (!["active", "trialing"].includes(subscription.status)) return;

  const now = new Date();
  const paymentIntentId = stripeObjectId(session.payment_intent);
  await collections.transactions.updateOne(
    { stripeSessionId: session.id },
    {
      $set: {
        vendorId,
        shopId: session.metadata?.shopId,
        vendorName: session.metadata?.shopName,
        vendorEmail: session.customer_details?.email ?? session.customer_email,
        plan: "premium",
        stripeSubscriptionId: subscription.id,
        stripeCustomerId: stripeObjectId(session.customer),
        stripeSubscriptionStatus: subscription.status,
        amount: (session.amount_total ?? 0) / 100,
        amountMinor: session.amount_total ?? 0,
        currency: session.currency ?? "usd",
        status: "succeeded",
        stripePaymentIntentId: paymentIntentId,
        paidAt: now,
        updatedAt: now,
      },
      $setOnInsert: {
        stripeSessionId: session.id,
        createdAt: session.created ? new Date(session.created * 1000) : now,
      },
    },
    { upsert: true },
  );

  await updateShopSubscription(subscription, vendorId);
}

async function recordInvoice(invoice, status) {
  const subscriptionId = subscriptionIdFromInvoice(invoice);
  if (!subscriptionId) return;

  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const vendorId = subscription.metadata?.vendorId;
  if (!vendorId) return;

  await updateShopSubscription(subscription, vendorId);

  const existingInvoice = await collections.transactions.findOne({
    stripeInvoiceId: invoice.id,
  });
  const initialCheckout = existingInvoice
    ? null
    : await collections.transactions.findOne({
        stripeSubscriptionId: subscriptionId,
        stripeInvoiceId: { $exists: false },
      });
  const now = new Date();
  const amountMinor =
    status === "succeeded"
      ? (invoice.amount_paid ?? invoice.amount_due ?? 0)
      : (invoice.amount_due ?? invoice.amount_remaining ?? 0);
  const values = {
    vendorId,
    shopId: subscription.metadata?.shopId,
    vendorName: subscription.metadata?.shopName ?? "Vendor",
    vendorEmail: subscription.metadata?.vendorEmail ?? null,
    plan: "premium",
    stripeSubscriptionId: subscriptionId,
    stripeSubscriptionStatus: subscription.status,
    stripeCustomerId: stripeObjectId(invoice.customer),
    stripeInvoiceId: invoice.id,
    stripePaymentIntentId: stripeObjectId(invoice.payment_intent),
    amount: amountMinor / 100,
    amountMinor,
    currency: invoice.currency ?? "usd",
    status,
    paidAt: status === "succeeded" ? now : null,
    updatedAt: now,
  };

  if (existingInvoice || initialCheckout) {
    await collections.transactions.updateOne(
      { _id: (existingInvoice ?? initialCheckout)._id },
      { $set: values },
    );
    return;
  }

  await collections.transactions.insertOne({
    ...values,
    createdAt: invoice.created ? new Date(invoice.created * 1000) : now,
  });
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
    res.status(400).json({
      error: `Webhook signature verification failed: ${error.message}`,
    });
    return;
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        if (
          session.mode === "subscription" &&
          ["paid", "no_payment_required"].includes(session.payment_status)
        ) {
          await activatePremium(session);
        }
        break;
      }
      case "checkout.session.async_payment_succeeded": {
        await activatePremium(event.data.object);
        break;
      }
      case "checkout.session.async_payment_failed":
      case "checkout.session.expired": {
        await markTransaction(event.data.object, "failed");
        break;
      }
      case "invoice.paid": {
        await recordInvoice(event.data.object, "succeeded");
        break;
      }
      case "invoice.payment_failed": {
        await recordInvoice(event.data.object, "failed");
        break;
      }
      case "customer.subscription.updated": {
        const subscription = event.data.object;
        await updateShopSubscription(
          subscription,
          subscription.metadata?.vendorId,
        );
        break;
      }
      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        await updateShopSubscription(
          { ...subscription, status: "canceled" },
          subscription.metadata?.vendorId,
        );
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
