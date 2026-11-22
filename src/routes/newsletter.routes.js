import { Router } from "express";
import { asyncHandler, ApiError } from "../utils/http.js";
import { collections } from "../config/db.js";

const router = Router();

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Newsletter signup. Public on purpose: the footer form is available to
 * visitors who never sign in, so no session is required.
 */
router.post(
  "/newsletter",
  asyncHandler(async (req, res) => {
    const email = String(req.body?.email ?? "").trim().toLowerCase();

    if (!EMAIL_PATTERN.test(email) || email.length > 254) {
      throw new ApiError(400, "Enter a valid email address.");
    }

    const now = new Date();
    await collections.newsletter.updateOne(
      { email },
      { $set: { email, updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );

    res.status(201).json({
      ok: true,
      message: "You are on the list — watch your inbox.",
    });
  }),
);

export default router;
