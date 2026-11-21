import { Router } from "express";
import { ObjectId } from "mongodb";
import { collections } from "../config/db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  ApiError,
  asyncHandler,
  requireObjectId,
  serialize,
} from "../utils/http.js";

const router = Router();

// CUSTOMER: saved items, joined with the live menu documents.
router.get(
  "/customer/favorites",
  requireAuth,
  requireRole("customer"),
  asyncHandler(async (req, res) => {
    const favorites = await collections.favorites
      .find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .toArray();

    const ids = favorites
      .map((favorite) => favorite.menuItemId)
      .filter((id) => typeof id === "string");

    const objectIds = ids
      .filter((id) => ObjectId.isValid(id))
      .map((id) => new ObjectId(id));

    const items = objectIds.length
      ? await collections.menus.find({ _id: { $in: objectIds } }).toArray()
      : [];

    const byId = new Map(items.map((item) => [item._id.toString(), item]));

    res.status(200).json(
      serialize(
        favorites
          .map((favorite) => {
            const item = byId.get(favorite.menuItemId);
            return item
              ? { id: favorite._id, createdAt: favorite.createdAt, item }
              : null;
          })
          .filter(Boolean),
      ),
    );
  }),
);

// CUSTOMER: add a favorite. The unique index prevents duplicates.
router.post(
  "/favorites/:menuItemId",
  requireAuth,
  requireRole("customer"),
  asyncHandler(async (req, res) => {
    const id = requireObjectId(req.params.menuItemId, "menu item ID");

    const item = await collections.menus.findOne({
      _id: id,
      status: "approved",
      isAvailable: true,
    });

    if (!item) {
      throw new ApiError(404, "This menu item is not available.");
    }

    try {
      await collections.favorites.insertOne({
        userId: req.user.id,
        menuItemId: id.toString(),
        createdAt: new Date(),
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }

    res.status(201).json({ ok: true, message: "Added to favorites." });
  }),
);

// CUSTOMER: remove a favorite.
router.delete(
  "/favorites/:menuItemId",
  requireAuth,
  requireRole("customer"),
  asyncHandler(async (req, res) => {
    const id = requireObjectId(req.params.menuItemId, "menu item ID");

    await collections.favorites.deleteOne({
      userId: req.user.id,
      menuItemId: id.toString(),
    });

    res.status(200).json({ ok: true, message: "Removed from favorites." });
  }),
);

// CUSTOMER: ids only, so menu cards can render the toggle state cheaply.
router.get(
  "/customer/favorite-ids",
  requireAuth,
  requireRole("customer"),
  asyncHandler(async (req, res) => {
    const favorites = await collections.favorites
      .find({ userId: req.user.id }, { projection: { menuItemId: 1 } })
      .toArray();

    res.status(200).json(favorites.map((favorite) => favorite.menuItemId));
  }),
);

export default router;
