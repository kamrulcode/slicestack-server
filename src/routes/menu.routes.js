import { Router } from "express";
import { collections } from "../config/db.js";
import { requireAuth, requireVendor } from "../middleware/auth.js";
import {
  ApiError,
  asyncHandler,
  cleanString,
  escapeRegex,
  requireObjectId,
  serialize,
} from "../utils/http.js";

const router = Router();

export const MENU_CATEGORIES = [
  "Classic Pizzas",
  "Vegetarian Pizzas",
  "Meat Lovers",
  "Specialty / Gourmet Pizzas",
  "Sides & Appetizers",
  "Beverages & Desserts",
];

const MENU_STATUSES = ["pending", "approved", "rejected"];
const FREE_PLAN_ITEM_LIMIT = 3;
const MAX_IMAGES = 6;

export function isPremiumShop(shop) {
  if (!shop || shop.plan !== "premium") return false;
  if (!shop.premiumUntil) return false;
  return new Date(shop.premiumUntil).getTime() > Date.now();
}

export function planForShop(shop) {
  return isPremiumShop(shop) ? "premium" : "free";
}

function isHttpUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function validateMenuItemInput(body) {
  const itemName = cleanString(body.itemName, 100);
  const category = cleanString(body.category, 60);
  const description = cleanString(body.description, 2000);
  const location = cleanString(body.location, 120);
  const price = Number(body.price);
  const images = Array.isArray(body.images) ? body.images : [];

  if (itemName.length < 3) {
    throw new ApiError(400, "Item name must be at least 3 characters.");
  }
  if (!MENU_CATEGORIES.includes(category)) {
    throw new ApiError(400, "Choose a valid menu category.");
  }
  if (description.length < 20) {
    throw new ApiError(400, "Description must be at least 20 characters.");
  }
  if (!Number.isFinite(price) || price <= 0) {
    throw new ApiError(400, "Price must be greater than 0.");
  }
  if (location.length < 2) {
    throw new ApiError(400, "Location is required.");
  }
  if (
    images.length === 0 ||
    images.length > MAX_IMAGES ||
    !images.every(isHttpUrl)
  ) {
    throw new ApiError(
      400,
      `Upload between 1 and ${MAX_IMAGES} images before saving the item.`,
    );
  }

  return {
    itemName,
    category,
    description,
    price: Math.round(price * 100) / 100,
    location,
    images,
  };
}

function publicMenuFilter(query) {
  const filter = { status: "approved", isAvailable: true };

  const category = cleanString(query.category, 60);
  if (category && category !== "all") {
    if (!MENU_CATEGORIES.includes(category)) {
      throw new ApiError(400, "Unknown menu category.");
    }
    filter.category = category;
  }

  const location = cleanString(query.location, 120);
  if (location) {
    filter.location = { $regex: escapeRegex(location), $options: "i" };
  }

  const search = cleanString(query.search, 120);
  if (search) {
    const regex = { $regex: escapeRegex(search), $options: "i" };
    filter.$or = [{ itemName: regex }, { shopName: regex }, { category: regex }];
  }

  return filter;
}

async function ratingFor(menuItemId) {
  const [summary] = await collections.reviews
    .aggregate([
      { $match: { menuItemId } },
      {
        $group: {
          _id: null,
          average: { $avg: "$rating" },
          count: { $sum: 1 },
        },
      },
    ])
    .toArray();

  return {
    average: summary ? Math.round(summary.average * 10) / 10 : 0,
    count: summary?.count ?? 0,
  };
}

// PUBLIC: browse the live menu. Approved + available items only.
router.get(
  "/menu-items",
  asyncHandler(async (req, res) => {
    const items = await collections.menus
      .find(publicMenuFilter(req.query))
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();

    res.status(200).json(serialize(items));
  }),
);

// PUBLIC: a single item with its shop and rating summary.
router.get(
  "/menu-items/:id",
  asyncHandler(async (req, res) => {
    const id = requireObjectId(req.params.id, "menu item ID");

    const item = await collections.menus.findOne({
      _id: id,
      status: "approved",
      isAvailable: true,
    });

    if (!item) {
      throw new ApiError(404, "This menu item is not available.");
    }

    const [shop, rating] = await Promise.all([
      collections.shops.findOne({ ownerId: item.ownerId }),
      ratingFor(item._id.toString()),
    ]);

    res.status(200).json(
      serialize({
        item,
        shop: shop
          ? {
              id: shop._id,
              name: shop.name,
              description: shop.description,
              address: shop.address,
              phone: shop.phone,
              logoUrl: shop.logoUrl,
              status: shop.status,
            }
          : null,
        rating,
      }),
    );
  }),
);

// PUBLIC: reviews for an item.
router.get(
  "/menu-items/:id/reviews",
  asyncHandler(async (req, res) => {
    const id = requireObjectId(req.params.id, "menu item ID");
    const reviews = await collections.reviews
      .find({ menuItemId: id.toString() })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();

    res.status(200).json(serialize(reviews));
  }),
);

// VENDOR: only the signed-in vendor's own items, including pending/rejected.
router.get(
  "/vendor/menu-items",
  requireAuth,
  requireVendor,
  asyncHandler(async (req, res) => {
    const items = await collections.menus
      .find({ ownerId: req.user.id })
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json(serialize(items));
  }),
);

// VENDOR: submit a menu item. Owner, shop details and status are server-owned.
router.post(
  "/menu-items",
  requireAuth,
  requireVendor,
  asyncHandler(async (req, res) => {
    const values = validateMenuItemInput(req.body ?? {});
    const shop = req.shop;
    const plan = planForShop(shop);

    if (plan === "free") {
      const activeCount = await collections.menus.countDocuments({
        ownerId: req.user.id,
        status: { $ne: "rejected" },
      });

      if (activeCount >= FREE_PLAN_ITEM_LIMIT) {
        throw new ApiError(
          403,
          `The Free plan allows ${FREE_PLAN_ITEM_LIMIT} active menu items. Upgrade to Premium for unlimited items.`,
        );
      }
    }

    const now = new Date();

    const result = await collections.menus.insertOne({
      ...values,
      status: "pending",
      isAvailable: true,
      logoUrl: shop.logoUrl ?? null,
      shopName: shop.name ?? "",
      ownerId: req.user.id,
      rejectionReason: null,
      createdAt: now,
      updatedAt: now,
    });

    res.status(201).json({
      ok: true,
      id: result.insertedId.toString(),
      message: "Menu item submitted for review.",
    });
  }),
);

// VENDOR: update own item. Ownership is derived from the session.
router.put(
  "/menu-items/:id",
  requireAuth,
  requireVendor,
  asyncHandler(async (req, res) => {
    const id = requireObjectId(req.params.id, "menu item ID");
    const body = req.body ?? {};
    const updates = { updatedAt: new Date() };

    if (body.itemName !== undefined) {
      const itemName = cleanString(body.itemName, 100);
      if (itemName.length < 3) {
        throw new ApiError(400, "Item name must be at least 3 characters.");
      }
      updates.itemName = itemName;
    }

    if (body.category !== undefined) {
      const category = cleanString(body.category, 60);
      if (!MENU_CATEGORIES.includes(category)) {
        throw new ApiError(400, "Choose a valid menu category.");
      }
      updates.category = category;
    }

    if (body.price !== undefined) {
      const price = Number(body.price);
      if (!Number.isFinite(price) || price <= 0) {
        throw new ApiError(400, "Price must be greater than 0.");
      }
      updates.price = Math.round(price * 100) / 100;
    }

    if (body.description !== undefined) {
      const description = cleanString(body.description, 2000);
      if (description.length < 20) {
        throw new ApiError(400, "Description must be at least 20 characters.");
      }
      updates.description = description;
    }

    if (body.location !== undefined) {
      const location = cleanString(body.location, 120);
      if (location.length < 2) {
        throw new ApiError(400, "Location is required.");
      }
      updates.location = location;
    }

    if (body.images !== undefined) {
      if (
        !Array.isArray(body.images) ||
        body.images.length === 0 ||
        body.images.length > MAX_IMAGES ||
        !body.images.every(isHttpUrl)
      ) {
        throw new ApiError(400, "Enter valid image URLs.");
      }
      updates.images = body.images;
    }

    const result = await collections.menus.updateOne(
      { _id: id, ownerId: req.user.id },
      { $set: updates },
    );

    if (result.matchedCount === 0) {
      throw new ApiError(404, "Menu item not found.");
    }

    res.status(200).json({ ok: true, message: "Menu item updated." });
  }),
);

// VENDOR: availability toggle.
router.patch(
  "/menu-items/:id/availability",
  requireAuth,
  requireVendor,
  asyncHandler(async (req, res) => {
    const id = requireObjectId(req.params.id, "menu item ID");
    const { isAvailable } = req.body ?? {};

    if (typeof isAvailable !== "boolean") {
      throw new ApiError(400, "Invalid availability update.");
    }

    if (isAvailable) {
      const plan = planForShop(req.shop);
      if (plan === "free") {
        const activeCount = await collections.menus.countDocuments({
          ownerId: req.user.id,
          status: "approved",
          isAvailable: true,
          _id: { $ne: id },
        });
        if (activeCount >= FREE_PLAN_ITEM_LIMIT) {
          throw new ApiError(
            403,
            `The Free plan allows ${FREE_PLAN_ITEM_LIMIT} active menu items. Upgrade to Premium to publish more.`,
          );
        }
      }
    }

    const result = await collections.menus.updateOne(
      { _id: id, ownerId: req.user.id },
      { $set: { isAvailable, updatedAt: new Date() } },
    );

    if (result.matchedCount === 0) {
      throw new ApiError(404, "Menu item not found.");
    }

    res.status(200).json({ ok: true, message: "Availability updated." });
  }),
);

// VENDOR: delete own item.
router.delete(
  "/menu-items/:id",
  requireAuth,
  requireVendor,
  asyncHandler(async (req, res) => {
    const id = requireObjectId(req.params.id, "menu item ID");

    const result = await collections.menus.deleteOne({
      _id: id,
      ownerId: req.user.id,
    });

    if (result.deletedCount === 0) {
      throw new ApiError(404, "Menu item not found.");
    }

    res.status(200).json({ ok: true, message: "Menu item deleted." });
  }),
);

export { MENU_STATUSES };
export default router;
