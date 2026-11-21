import { Router } from "express";
import { ObjectId } from "mongodb";
import { collections } from "../config/db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  ApiError,
  asyncHandler,
  cleanString,
  serialize,
} from "../utils/http.js";

const router = Router();

function toApplication(doc) {
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

function toShop(doc) {
  return serialize({
    id: doc._id,
    ownerId: doc.ownerId,
    applicationId: doc.applicationId,
    name: doc.name,
    description: doc.description,
    address: doc.address,
    phone: doc.phone,
    logoUrl: doc.logoUrl ?? null,
    status: doc.status,
    plan: doc.plan ?? "free",
    premiumUntil: doc.premiumUntil ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  });
}

// Signed-in user's account, vendor application and shop (for guards/UI).
router.get(
  "/auth/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const [application, shop] = await Promise.all([
      collections.applications.findOne({ userId: req.user.id }),
      collections.shops.findOne({ ownerId: req.user.id }),
    ]);

    res.status(200).json(
      serialize({
        user: req.user,
        application: application ? toApplication(application) : null,
        shop: shop ? toShop(shop) : null,
      }),
    );
  }),
);

// Both customers and vendors may update their own name and avatar.
router.patch(
  "/users/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const updates = {};
    const name = cleanString(req.body?.name, 100);
    const image = cleanString(req.body?.image, 500);

    if (req.body?.name !== undefined) {
      if (name.length < 2) throw new ApiError(400, "Enter your full name.");
      updates.name = name;
    }

    if (req.body?.image !== undefined) {
      if (image && !/^https:\/\/\S+$/i.test(image)) {
        throw new ApiError(400, "Profile image must be a valid URL.");
      }
      updates.image = image || null;
    }

    if (Object.keys(updates).length === 0) {
      throw new ApiError(400, "Nothing to update.");
    }

    updates.updatedAt = new Date();

    // Role, blocked and plan are intentionally ignored here.
    await collections.users.updateOne(
      { _id: new ObjectId(req.user.id) },
      { $set: updates },
    );

    res.status(200).json({
      ok: true,
      message: "Profile updated.",
      user: { ...req.user, ...updates, updatedAt: undefined },
    });
  }),
);

// Vendor profile (application + shop) for the vendor dashboard pages.
router.get(
  "/vendors/me",
  requireAuth,
  requireRole("vendor"),
  asyncHandler(async (req, res) => {
    const [application, shop] = await Promise.all([
      collections.applications.findOne({ userId: req.user.id }),
      collections.shops.findOne({ ownerId: req.user.id }),
    ]);

    if (!application || !shop) {
      throw new ApiError(404, "Vendor profile not found.");
    }

    res.status(200).json({
      application: toApplication(application),
      shop: toShop(shop),
    });
  }),
);

// Vendor updates their public shop details. Menus are kept in sync.
router.patch(
  "/vendors/me",
  requireAuth,
  requireRole("vendor"),
  asyncHandler(async (req, res) => {
    const application = await collections.applications.findOne({
      userId: req.user.id,
    });
    const shop = await collections.shops.findOne({ ownerId: req.user.id });

    if (!application || !shop) {
      throw new ApiError(404, "Vendor profile not found.");
    }

    const updates = {};
    const shopName = cleanString(req.body?.shopName, 100);
    const ownerName = cleanString(req.body?.ownerName, 100);
    const phone = cleanString(req.body?.phone, 40);
    const address = cleanString(req.body?.address, 300);
    const description = cleanString(req.body?.description, 1000);
    const logoUrl = cleanString(req.body?.logoUrl, 500);

    if (req.body?.shopName !== undefined) {
      if (shopName.length < 2) throw new ApiError(400, "Enter a shop name.");
      updates.shopName = shopName;
    }
    if (req.body?.ownerName !== undefined) {
      if (ownerName.length < 2) throw new ApiError(400, "Enter the owner name.");
      updates.ownerName = ownerName;
    }
    if (req.body?.phone !== undefined) updates.phone = phone;
    if (req.body?.address !== undefined) { updates.address = address; }
    if (req.body?.description !== undefined) updates.description = description;
    if (req.body?.logoUrl !== undefined) updates.logoUrl = logoUrl || null;

    if (Object.keys(updates).length === 0) {
      throw new ApiError(400, "Nothing to update.");
    }

    const now = new Date();
    updates.updatedAt = now;

    await collections.applications.updateOne(
      { userId: req.user.id },
      { $set: updates },
    );

    const shopUpdates = {
      updatedAt: now,
      ...(updates.shopName !== undefined ? { name: updates.shopName } : {}),
      ...(updates.address !== undefined ? { address: updates.address } : {}),
      ...(updates.description !== undefined
        ? { description: updates.description }
        : {}),
      ...(updates.phone !== undefined ? { phone: updates.phone } : {}),
      ...(updates.logoUrl !== undefined ? { logoUrl: updates.logoUrl } : {}),
    };

    await collections.shops.updateOne(
      { ownerId: req.user.id },
      { $set: shopUpdates },
    );

    // Denormalized menu fields follow the shop.
    const menuUpdates = {
      updatedAt: now,
      ...(updates.shopName !== undefined
        ? { shopName: updates.shopName }
        : {}),
      ...(updates.logoUrl !== undefined ? { logoUrl: updates.logoUrl } : {}),
    };

    if (Object.keys(menuUpdates).length > 1) {
      await collections.menus.updateMany(
        { ownerId: req.user.id },
        { $set: menuUpdates },
      );
    }

    res.status(200).json({ ok: true, message: "Shop profile updated." });
  }),
);

/**
 * Self-service vendor activation. This replaces the old Next.js database
 * function: the backend trusts only the verified session user.
 */
router.post(
  "/vendors/apply",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.user.role === "admin") {
      throw new ApiError(403, "Admin accounts cannot become vendors.");
    }

    const shopName = cleanString(req.body?.shopName, 100);
    const ownerName = cleanString(req.body?.ownerName, 100);
    const phone = cleanString(req.body?.phone, 40);
    const address = cleanString(req.body?.address, 300);
    const description = cleanString(req.body?.description, 2000);
    const logoUrl = cleanString(req.body?.logoUrl, 500);

    if (shopName.length < 2) throw new ApiError(400, "Enter a shop name.");
    if (ownerName.length < 2) throw new ApiError(400, "Enter the owner name.");
    if (phone.length < 6) throw new ApiError(400, "Enter a valid phone number.");
    if (address.length < 5) throw new ApiError(400, "Enter the shop address.");
    if (description.length < 20) {
      throw new ApiError(400, "Describe your shop in at least 20 characters.");
    }

    const [existingApplication, existingShop] = await Promise.all([
      collections.applications.findOne({ userId: req.user.id }),
      collections.shops.findOne({ ownerId: req.user.id }),
    ]);

    if (
      existingApplication?.status === "SUSPENDED" ||
      existingShop?.status === "suspended"
    ) {
      throw new ApiError(
        403,
        "This vendor account is suspended. Contact the SliceStack team.",
      );
    }

    const now = new Date();

    const application = await collections.applications.findOneAndUpdate(
      { userId: req.user.id },
      {
        $set: {
          shopName,
          ownerName,
          phone,
          address,
          description,
          logoUrl: logoUrl || null,
          status: "APPROVED",
          rejectionReason: null,
          reviewedBy: null,
          reviewedAt: null,
          updatedAt: now,
        },
        $setOnInsert: { userId: req.user.id, createdAt: now },
      },
      { upsert: true, returnDocument: "after" },
    );

    const shop = await collections.shops.findOneAndUpdate(
      { ownerId: req.user.id },
      {
        $set: {
          applicationId: application._id.toString(),
          name: shopName,
          description,
          address,
          phone,
          logoUrl: logoUrl || null,
          status: "active",
          updatedAt: now,
        },
        $setOnInsert: {
          ownerId: req.user.id,
          createdAt: now,
          plan: "free",
        },
      },
      { upsert: true, returnDocument: "after" },
    );

    await collections.users.updateOne(
      { _id: new ObjectId(req.user.id) },
      { $set: { role: "vendor", updatedAt: now } },
    );

    res.status(201).json({
      ok: true,
      message: "Vendor account activated.",
      application: toApplication(application),
      shop: toShop(shop),
    });
  }),
);

export default router;
