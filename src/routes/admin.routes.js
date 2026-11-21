import { Router } from "express";
import { ObjectId } from "mongodb";
import { collections } from "../config/db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  ApiError,
  asyncHandler,
  cleanString,
  escapeRegex,
  requireObjectId,
  serialize,
} from "../utils/http.js";
import { weeklyCounts } from "../utils/weekly.js";

const router = Router();
const adminOnly = [requireAuth, requireRole("admin")];

const MENU_STATUSES = ["pending", "approved", "rejected"];
const APPLICATION_ACTIONS = ["approve", "reject", "suspend"];

function normalizeRole(value) {
  return value === "admin" || value === "vendor" ? value : "customer";
}

function toVendorApplication(doc) {
  return serialize({
    id: doc._id,
    userId: doc.userId,
    shopName: doc.shopName,
    ownerName: doc.ownerName,
    phone: doc.phone,
    address: doc.address,
    description: doc.description,
    logoUrl: doc.logoUrl ?? null,
    status: doc.status,
    rejectionReason: doc.rejectionReason ?? null,
    reviewedBy: doc.reviewedBy ?? null,
    reviewedAt: doc.reviewedAt ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  });
}

function toPlatformUser(doc) {
  return serialize({
    id: doc._id,
    name: doc.name,
    email: doc.email,
    image: doc.image ?? null,
    role: normalizeRole(doc.role),
    blocked: doc.blocked === true,
    createdAt: doc.createdAt ?? null,
  });
}

// ADMIN: platform counters, all from real records.
router.get(
  "/admin/dashboard",
  adminOnly,
  asyncHandler(async (_req, res) => {
    const users = collections.users;
    const [
      totalUsers,
      vendors,
      admins,
      totalMenuItems,
      pendingMenuItems,
      approvedMenuItems,
      rejectedMenuItems,
      totalTransactions,
      completedTransactions,
      revenue,
      weeklyOrders,
    ] = await Promise.all([
      users.countDocuments({}),
      users.countDocuments({ role: "vendor" }),
      users.countDocuments({ role: "admin" }),
      collections.menus.countDocuments({}),
      collections.menus.countDocuments({ status: "pending" }),
      collections.menus.countDocuments({ status: "approved" }),
      collections.menus.countDocuments({ status: "rejected" }),
      collections.transactions.countDocuments({}),
      collections.transactions.countDocuments({ status: "succeeded" }),
      collections.transactions
        .aggregate([
          { $match: { status: "succeeded" } },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ])
        .toArray(),
      weeklyCounts({}),
    ]);

    res.status(200).json({
      users: {
        total: totalUsers,
        vendors,
        admins,
        customers: Math.max(0, totalUsers - vendors - admins),
      },
      menuItems: {
        total: totalMenuItems,
        pending: pendingMenuItems,
        approved: approvedMenuItems,
        rejected: rejectedMenuItems,
      },
      transactions: {
        total: totalTransactions,
        completed: completedTransactions,
        revenue: revenue[0]?.total ?? 0,
      },
      weeklyOrders,
    });
  }),
);

// ADMIN: users with search and role filter.
router.get(
  "/admin/users",
  adminOnly,
  asyncHandler(async (req, res) => {
    const filter = {};
    const role = cleanString(req.query.role, 20);
    if (role && role !== "all") {
      if (!["customer", "vendor", "admin"].includes(role)) {
        throw new ApiError(400, "Invalid role filter.");
      }
      filter.role = role;
    }

    const search = cleanString(req.query.search, 120);
    if (search) {
      const regex = { $regex: escapeRegex(search), $options: "i" };
      filter.$or = [{ name: regex }, { email: regex }];
    }

    const users = await collections.users
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();

    res.status(200).json(users.map(toPlatformUser));
  }),
);

// ADMIN: block or unblock a user. Admins cannot block themselves or another admin.
router.patch(
  "/admin/users/:id/block",
  adminOnly,
  asyncHandler(async (req, res) => {
    const id = requireObjectId(req.params.id, "user ID");
    const blocked = req.body?.blocked;

    if (typeof blocked !== "boolean") {
      throw new ApiError(400, "A boolean blocked value is required.");
    }

    if (id.toString() === req.user.id) {
      throw new ApiError(400, "You cannot block your own account.");
    }

    const target = await collections.users.findOne({ _id: id });
    if (!target) throw new ApiError(404, "User not found.");

    if (normalizeRole(target.role) === "admin") {
      throw new ApiError(400, "Admin accounts cannot be blocked from this page.");
    }

    await collections.users.updateOne(
      { _id: id },
      { $set: { blocked, updatedAt: new Date() } },
    );

    // Blocked users lose active sessions immediately.
    if (blocked) {
      await collections.sessions.deleteMany({ userId: id.toString() });
    }

    res.status(200).json({
      ok: true,
      message: blocked ? "User blocked." : "User unblocked.",
    });
  }),
);

// ADMIN: every menu item, with status and search filters.
router.get(
  "/admin/menu-items",
  adminOnly,
  asyncHandler(async (req, res) => {
    const filter = {};
    const status = cleanString(req.query.status, 20);

    if (status && status !== "all") {
      if (!MENU_STATUSES.includes(status)) {
        throw new ApiError(400, "Invalid menu status.");
      }
      filter.status = status;
    }

    const search = cleanString(req.query.search, 120);
    if (search) {
      const regex = { $regex: escapeRegex(search), $options: "i" };
      filter.$or = [
        { itemName: regex },
        { shopName: regex },
        { category: regex },
      ];
    }

    const items = await collections.menus
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json(serialize(items));
  }),
);

// ADMIN: approve, reject or reset an item.
router.patch(
  "/admin/menu-items/:id",
  adminOnly,
  asyncHandler(async (req, res) => {
    const id = requireObjectId(req.params.id, "menu item ID");
    const status = cleanString(req.body?.status, 20);
    const rejectionReason = cleanString(req.body?.rejectionReason, 500);

    if (!MENU_STATUSES.includes(status)) {
      throw new ApiError(400, "Invalid menu status.");
    }

    const result = await collections.menus.updateOne(
      { _id: id },
      {
        $set: {
          status,
          rejectionReason: status === "rejected" ? rejectionReason || null : null,
          updatedAt: new Date(),
        },
      },
    );

    if (result.matchedCount === 0) {
      throw new ApiError(404, "Menu item not found.");
    }

    res.status(200).json({
      ok: true,
      message: `Menu item marked ${status}.`,
    });
  }),
);

// ADMIN: remove any item.
router.delete(
  "/admin/menu-items/:id",
  adminOnly,
  asyncHandler(async (req, res) => {
    const id = requireObjectId(req.params.id, "menu item ID");
    const result = await collections.menus.deleteOne({ _id: id });

    if (result.deletedCount === 0) {
      throw new ApiError(404, "Menu item not found.");
    }

    res.status(200).json({ ok: true, message: "Menu item deleted." });
  }),
);

// ADMIN: read-only transactions. Admin can never edit a payment record.
router.get(
  "/admin/transactions",
  adminOnly,
  asyncHandler(async (_req, res) => {
    const transactions = await collections.transactions
      .find({})
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();

    res.status(200).json(serialize(transactions));
  }),
);

// ADMIN: vendor applications for the review page.
router.get(
  "/admin/vendor-applications",
  adminOnly,
  asyncHandler(async (req, res) => {
    const status = cleanString(req.query.status, 20);
    const filter = {};
    if (status && status !== "all") {
      filter.status = status;
    }

    const applications = await collections.applications
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();

    res.status(200).json(applications.map(toVendorApplication));
  }),
);

// ADMIN: approve, reject or suspend a vendor application.
router.patch(
  "/admin/vendor-applications/:id",
  adminOnly,
  asyncHandler(async (req, res) => {
    const id = requireObjectId(req.params.id, "application ID");
    const action = cleanString(req.body?.action, 20);
    const reason = cleanString(req.body?.reason, 500);

    if (!APPLICATION_ACTIONS.includes(action)) {
      throw new ApiError(400, "Invalid application action.");
    }

    const application = await collections.applications.findOne({ _id: id });
    if (!application) throw new ApiError(404, "Application not found.");

    if (application.userId === req.user.id) {
      throw new ApiError(400, "You cannot review your own application.");
    }

    const allowedFrom = {
      approve: ["PENDING", "REJECTED", "SUSPENDED"],
      reject: ["PENDING"],
      suspend: ["APPROVED"],
    };
    const nextStatus = {
      approve: "APPROVED",
      reject: "REJECTED",
      suspend: "SUSPENDED",
    };

    if (!allowedFrom[action].includes(application.status)) {
      throw new ApiError(
        409,
        `This application cannot be ${action}d from its current status.`,
      );
    }

    const now = new Date();
    const userObjectId = new ObjectId(application.userId);

    await collections.applications.updateOne(
      { _id: id },
      {
        $set: {
          status: nextStatus[action],
          rejectionReason: action === "reject" ? reason || null : null,
          reviewedBy: req.user.id,
          reviewedAt: now,
          updatedAt: now,
        },
      },
    );

    if (action === "approve") {
      await collections.users.updateOne(
        { _id: userObjectId },
        { $set: { role: "vendor", updatedAt: now } },
      );

      await collections.shops.updateOne(
        { ownerId: application.userId },
        {
          $set: {
            applicationId: id.toString(),
            name: application.shopName,
            description: application.description,
            address: application.address,
            phone: application.phone,
            logoUrl: application.logoUrl ?? null,
            status: "active",
            updatedAt: now,
          },
          $setOnInsert: {
            ownerId: application.userId,
            createdAt: now,
            plan: "free",
          },
        },
        { upsert: true },
      );
    }

    if (action === "suspend") {
      await collections.shops.updateOne(
        { ownerId: application.userId },
        { $set: { status: "suspended", updatedAt: now } },
      );
    }

    res.status(200).json({
      ok: true,
      message: `Application ${nextStatus[action].toLowerCase()}.`,
    });
  }),
);

export default router;
