import { Router } from "express";
import { collections } from "../config/db.js";
import { requireAuth, requireRole, requireVendor } from "../middleware/auth.js";
import {
  ApiError,
  asyncHandler,
  cleanString,
  requireObjectId,
  serialize,
} from "../utils/http.js";
import { planForShop } from "./menu.routes.js";
import { sendOrderStatusEmail } from "../services/mail.js";
import { weeklyCounts } from "../utils/weekly.js";

const router = Router();

const ACTIVE_ORDER_STATUSES = ["pending", "accepted"];

function parseDeliveryDate(value) {
  const raw = cleanString(value, 40);
  const date = new Date(raw);

  if (!raw || Number.isNaN(date.getTime())) {
    throw new ApiError(400, "Choose a valid delivery date.");
  }

  // Compare calendar days so an order for today is always allowed.
  const requested = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  );
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  if (requested < today) {
    throw new ApiError(400, "Delivery date cannot be in the past.");
  }

  return {
    deliveryDate: date.toISOString().slice(0, 10),
    deliveryDateValue: new Date(`${date.toISOString().slice(0, 10)}T00:00:00.000Z`),
  };
}

function toOrder(doc) {
  return serialize({
    id: doc._id,
    menuItemId: doc.menuItemId,
    itemName: doc.itemName,
    itemImage: doc.itemImage ?? null,
    price: doc.price,
    shopName: doc.shopName ?? "",
    ownerId: doc.ownerId,
    customerId: doc.customerId,
    customerName: doc.customerName,
    customerEmail: doc.customerEmail,
    deliveryDate: doc.deliveryDate,
    deliveryAddress: doc.deliveryAddress,
    message: doc.message ?? "",
    status: doc.status,
    statusHistory: doc.statusHistory ?? [],
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  });
}

// CUSTOMER: place an order.
router.post(
  "/orders",
  requireAuth,
  requireRole("customer"),
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    const menuItemId = requireObjectId(body.menuItemId, "menu item ID");
    const deliveryAddress = cleanString(body.deliveryAddress, 300);
    const message = cleanString(body.message, 1000);
    const { deliveryDate, deliveryDateValue } = parseDeliveryDate(
      body.deliveryDate,
    );

    if (deliveryAddress.length < 5) {
      throw new ApiError(400, "Enter a valid delivery address.");
    }

    const item = await collections.menus.findOne({
      _id: menuItemId,
      status: "approved",
      isAvailable: true,
    });

    if (!item) {
      throw new ApiError(404, "This item is no longer available.");
    }

    if (item.ownerId === req.user.id) {
      throw new ApiError(400, "You cannot order your own menu item.");
    }

    const duplicate = await collections.orders.findOne({
      customerId: req.user.id,
      menuItemId: item._id.toString(),
      deliveryDate,
      status: { $in: ACTIVE_ORDER_STATUSES },
    });

    if (duplicate) {
      throw new ApiError(
        409,
        "You already have an active order for this item on that date.",
      );
    }

    const now = new Date();
    const order = {
      menuItemId: item._id.toString(),
      itemName: item.itemName,
      itemImage: item.images?.[0] ?? null,
      price: item.price,
      ownerId: item.ownerId,
      shopName: item.shopName ?? "",
      customerId: req.user.id,
      customerName: req.user.name,
      customerEmail: req.user.email,
      deliveryDate,
      deliveryDateValue,
      deliveryAddress,
      message,
      status: "pending",
      statusHistory: [{ status: "pending", at: now }],
      createdAt: now,
      updatedAt: now,
    };

    try {
      const result = await collections.orders.insertOne(order);
      res.status(201).json({
        ok: true,
        message: "Order placed successfully.",
        order: toOrder({ ...order, _id: result.insertedId }),
      });
    } catch (error) {
      if (error?.code === 11000) {
        throw new ApiError(
          409,
          "You already have an active order for this item on that date.",
        );
      }
      throw error;
    }
  }),
);

// CUSTOMER: own orders only.
router.get(
  "/customer/orders",
  requireAuth,
  requireRole("customer"),
  asyncHandler(async (req, res) => {
    const orders = await collections.orders
      .find({ customerId: req.user.id })
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json(orders.map(toOrder));
  }),
);

router.get(
  "/customer/orders/:id",
  requireAuth,
  requireRole("customer"),
  asyncHandler(async (req, res) => {
    const id = requireObjectId(req.params.id, "order ID");
    const order = await collections.orders.findOne({
      _id: id,
      customerId: req.user.id,
    });

    if (!order) throw new ApiError(404, "Order not found.");

    res.status(200).json(toOrder(order));
  }),
);

// CUSTOMER: cancel a pending order only.
router.patch(
  "/customer/orders/:id/cancel",
  requireAuth,
  requireRole("customer"),
  asyncHandler(async (req, res) => {
    const id = requireObjectId(req.params.id, "order ID");
    const now = new Date();

    const result = await collections.orders.findOneAndUpdate(
      {
        _id: id,
        customerId: req.user.id,
        status: "pending",
      },
      {
        $set: { status: "cancelled", updatedAt: now },
        $push: { statusHistory: { status: "cancelled", at: now } },
      },
      { returnDocument: "after" },
    );

    if (!result) {
      const exists = await collections.orders.findOne({
        _id: id,
        customerId: req.user.id,
      });
      if (!exists) throw new ApiError(404, "Order not found.");
      throw new ApiError(
        409,
        "Only pending orders can be cancelled.",
      );
    }

    res.status(200).json({
      ok: true,
      message: "Order cancelled.",
      order: toOrder(result),
    });
  }),
);

// CUSTOMER: dashboard counters.
router.get(
  "/customer/dashboard",
  requireAuth,
  requireRole("customer"),
  asyncHandler(async (req, res) => {
    const [total, pending, accepted, rejected, cancelled, weekly] =
      await Promise.all([
        collections.orders.countDocuments({ customerId: req.user.id }),
        collections.orders.countDocuments({
          customerId: req.user.id,
          status: "pending",
        }),
        collections.orders.countDocuments({
          customerId: req.user.id,
          status: "accepted",
        }),
        collections.orders.countDocuments({
          customerId: req.user.id,
          status: "rejected",
        }),
        collections.orders.countDocuments({
          customerId: req.user.id,
          status: "cancelled",
        }),
        weeklyCounts({ customerId: req.user.id }),
      ]);

    res.status(200).json({ total, pending, accepted, rejected, cancelled, weekly });
  }),
);

// VENDOR: dashboard counters and plan.
router.get(
  "/vendor/dashboard",
  requireAuth,
  requireVendor,
  asyncHandler(async (req, res) => {
    const ownerId = req.user.id;
    const [
      totalItems,
      activeItems,
      pendingItems,
      pendingOrders,
      acceptedOrders,
      rejectedOrders,
      weekly,
    ] = await Promise.all([
      collections.menus.countDocuments({ ownerId }),
      collections.menus.countDocuments({
        ownerId,
        status: "approved",
        isAvailable: true,
      }),
      collections.menus.countDocuments({ ownerId, status: "pending" }),
      collections.orders.countDocuments({ ownerId, status: "pending" }),
      collections.orders.countDocuments({ ownerId, status: "accepted" }),
      collections.orders.countDocuments({ ownerId, status: "rejected" }),
      weeklyCounts({ ownerId }),
    ]);

    res.status(200).json(
      serialize({
        totalItems,
        activeItems,
        pendingItems,
        pendingOrders,
        acceptedOrders,
        rejectedOrders,
        weekly,
        plan: planForShop(req.shop),
        premiumUntil: req.shop.premiumUntil ?? null,
        shop: {
          id: req.shop._id,
          name: req.shop.name,
          address: req.shop.address,
          logoUrl: req.shop.logoUrl ?? null,
        },
      }),
    );
  }),
);

// VENDOR: orders that belong to this vendor's shop.
router.get(
  "/vendor/orders",
  requireAuth,
  requireVendor,
  asyncHandler(async (req, res) => {
    const status = cleanString(req.query.status, 20);
    const filter = { ownerId: req.user.id };
    if (status && status !== "all") {
      if (!["pending", "accepted", "rejected", "cancelled"].includes(status)) {
        throw new ApiError(400, "Invalid order status filter.");
      }
      filter.status = status;
    }

    const orders = await collections.orders
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json(orders.map(toOrder));
  }),
);

router.get(
  "/vendor/orders/:id",
  requireAuth,
  requireVendor,
  asyncHandler(async (req, res) => {
    const id = requireObjectId(req.params.id, "order ID");
    const order = await collections.orders.findOne({
      _id: id,
      ownerId: req.user.id,
    });

    if (!order) throw new ApiError(404, "Order not found.");

    res.status(200).json(toOrder(order));
  }),
);

// VENDOR: accept or reject a pending order. Only once, only own orders.
router.patch(
  "/vendor/orders/:id/status",
  requireAuth,
  requireVendor,
  asyncHandler(async (req, res) => {
    const id = requireObjectId(req.params.id, "order ID");
    const status = cleanString(req.body?.status, 20);

    if (status !== "accepted" && status !== "rejected") {
      throw new ApiError(400, "Status must be accepted or rejected.");
    }

    const now = new Date();
    const result = await collections.orders.findOneAndUpdate(
      { _id: id, ownerId: req.user.id, status: "pending" },
      {
        $set: { status, updatedAt: now },
        $push: { statusHistory: { status, at: now } },
      },
      { returnDocument: "after" },
    );

    if (!result) {
      const exists = await collections.orders.findOne({
        _id: id,
        ownerId: req.user.id,
      });
      if (!exists) throw new ApiError(404, "Order not found.");
      throw new ApiError(409, "Only pending orders can be processed.");
    }

    // Notification failures must not roll back a valid status change.
    sendOrderStatusEmail({
      to: result.customerEmail,
      name: result.customerName,
      status,
      itemName: result.itemName,
    }).catch((error) => {
      console.error("Order status email failed:", error.message);
    });

    res.status(200).json({
      ok: true,
      message: `Order ${status}.`,
      order: toOrder(result),
    });
  }),
);

export default router;
