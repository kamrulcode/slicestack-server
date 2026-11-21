import { Router } from "express";
import { collections } from "../config/db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  ApiError,
  asyncHandler,
  cleanString,
  requireObjectId,
  serialize,
} from "../utils/http.js";

const router = Router();

// CUSTOMER: review an item they actually received. One review per customer
// per item; posting again updates the existing review.
router.post(
  "/menu-items/:id/reviews",
  requireAuth,
  requireRole("customer"),
  asyncHandler(async (req, res) => {
    const id = requireObjectId(req.params.id, "menu item ID");
    const rating = Number(req.body?.rating);
    const comment = cleanString(req.body?.comment, 1000);

    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new ApiError(400, "Choose a rating between 1 and 5 stars.");
    }

    if (comment.length > 0 && comment.length < 3) {
      throw new ApiError(400, "Your review is too short.");
    }

    const item = await collections.menus.findOne({
      _id: id,
      status: "approved",
    });

    if (!item) {
      throw new ApiError(404, "Menu item not found.");
    }

    const deliveredOrder = await collections.orders.findOne({
      customerId: req.user.id,
      menuItemId: id.toString(),
      status: "accepted",
    });

    if (!deliveredOrder) {
      throw new ApiError(
        403,
        "You can review an item after a shop accepts your order for it.",
      );
    }

    const now = new Date();

    await collections.reviews.updateOne(
      { menuItemId: id.toString(), customerId: req.user.id },
      {
        $set: {
          rating,
          comment,
          customerName: req.user.name,
          customerImage: req.user.image ?? null,
          updatedAt: now,
        },
        $setOnInsert: {
          menuItemId: id.toString(),
          shopId: item.ownerId,
          customerId: req.user.id,
          createdAt: now,
        },
      },
      { upsert: true },
    );

    const [summary] = await collections.reviews
      .aggregate([
        { $match: { menuItemId: id.toString() } },
        { $group: { _id: null, average: { $avg: "$rating" }, count: { $sum: 1 } } },
      ])
      .toArray();

    res.status(201).json({
      ok: true,
      message: "Thanks for your review.",
      rating: {
        average: summary ? Math.round(summary.average * 10) / 10 : 0,
        count: summary?.count ?? 0,
      },
    });
  }),
);

// CUSTOMER: delete their own review.
router.delete(
  "/menu-items/:id/reviews/mine",
  requireAuth,
  requireRole("customer"),
  asyncHandler(async (req, res) => {
    const id = requireObjectId(req.params.id, "menu item ID");

    const result = await collections.reviews.deleteOne({
      menuItemId: id.toString(),
      customerId: req.user.id,
    });

    if (result.deletedCount === 0) {
      throw new ApiError(404, "Review not found.");
    }

    res.status(200).json({ ok: true, message: "Review removed." });
  }),
);

export default router;
