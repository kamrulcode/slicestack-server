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
const adminOnly = [requireAuth, requireRole("admin")];
const OFFER_FIELDS = new Set([
  "title",
  "description",
  "discount",
  "price",
  "oldPrice",
  "image",
  "tag",
  "color",
  "isActive",
]);
const REQUIRED_OFFER_FIELDS = [
  "title",
  "description",
  "discount",
  "price",
  "oldPrice",
  "image",
  "tag",
  "color",
];

function isHttpsUrl(value) {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function validateOfferFields(body, { partial = false } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "Offer details must be an object.");
  }

  const keys = Object.keys(body);
  if (keys.some((key) => !OFFER_FIELDS.has(key))) {
    throw new ApiError(400, "Offer contains unsupported fields.");
  }
  if (partial && keys.length === 0) {
    throw new ApiError(400, "Provide at least one offer field to update.");
  }

  if (!partial) {
    const missing = REQUIRED_OFFER_FIELDS.filter(
      (field) => body[field] === undefined,
    );
    if (missing.length > 0) {
      throw new ApiError(400, "Complete all required offer fields.");
    }
  }

  const values = {};

  for (const field of ["title", "description", "discount", "tag"]) {
    if (body[field] === undefined) continue;

    const maxLength =
      field === "description" ? 2000 : field === "title" ? 100 : 50;
    const value = cleanString(body[field], maxLength);
    const minimumLength = field === "title" ? 3 : field === "description" ? 10 : 1;
    if (value.length < minimumLength) {
      throw new ApiError(400, `Invalid offer ${field}.`);
    }
    values[field] = value;
  }

  for (const field of ["price", "oldPrice"]) {
    if (body[field] === undefined) continue;
    const value = body[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new ApiError(400, `Offer ${field} must be a positive number.`);
    }
    values[field] = Math.round(value * 100) / 100;
  }

  if (body.image !== undefined) {
    if (!isHttpsUrl(body.image)) {
      throw new ApiError(400, "Offer image must be a valid HTTPS URL.");
    }
    values.image = body.image;
  }

  if (body.color !== undefined) {
    if (
      typeof body.color !== "string" ||
      !/^from-\[#[0-9a-f]{6}\]\/(?:10|15|20) to-\[#[0-9a-f]{6}\]\/(?:10|15|20)$/i.test(
        body.color,
      )
    ) {
      throw new ApiError(400, "Offer color must use a supported gradient.");
    }
    values.color = body.color;
  }

  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") {
      throw new ApiError(400, "Offer isActive must be a boolean.");
    }
    values.isActive = body.isActive;
  }

  return values;
}

function validatePricePair(offer) {
  if (offer.oldPrice <= offer.price) {
    throw new ApiError(400, "Offer oldPrice must be greater than price.");
  }
}

// PUBLIC: active offers only.
router.get(
  "/offers",
  asyncHandler(async (_req, res) => {
    const offers = await collections.offers
      .find({ isActive: true })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();

    res.status(200).json(serialize(offers));
  }),
);

// PUBLIC: one active offer by ID.
router.get(
  "/offers/:id",
  asyncHandler(async (req, res) => {
    const id = requireObjectId(req.params.id, "offer ID");
    const offer = await collections.offers.findOne({ _id: id, isActive: true });

    if (!offer) throw new ApiError(404, "Offer not found.");
    res.status(200).json(serialize(offer));
  }),
);

// ADMIN: list all offers, including inactive offers.
router.get(
  "/admin/offers",
  ...adminOnly,
  asyncHandler(async (_req, res) => {
    const offers = await collections.offers
      .find({})
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();

    res.status(200).json(serialize(offers));
  }),
);

// ADMIN: create an offer.
router.post(
  "/admin/offers",
  ...adminOnly,
  asyncHandler(async (req, res) => {
    const values = validateOfferFields(req.body ?? {});
    validatePricePair(values);

    const now = new Date();
    const offer = {
      ...values,
      isActive: values.isActive ?? true,
      createdAt: now,
      updatedAt: now,
    };
    const result = await collections.offers.insertOne(offer);

    res.status(201).json({
      ok: true,
      offer: serialize({ ...offer, _id: result.insertedId }),
    });
  }),
);

// ADMIN: partially update an offer.
router.patch(
  "/admin/offers/:id",
  ...adminOnly,
  asyncHandler(async (req, res) => {
    const id = requireObjectId(req.params.id, "offer ID");
    const updates = validateOfferFields(req.body ?? {}, { partial: true });
    const current = await collections.offers.findOne({ _id: id });

    if (!current) throw new ApiError(404, "Offer not found.");
    validatePricePair({ ...current, ...updates });

    await collections.offers.updateOne(
      { _id: id },
      { $set: { ...updates, updatedAt: new Date() } },
    );
    const offer = await collections.offers.findOne({ _id: id });

    res.status(200).json({ ok: true, offer: serialize(offer) });
  }),
);

// ADMIN: delete an offer.
router.delete(
  "/admin/offers/:id",
  ...adminOnly,
  asyncHandler(async (req, res) => {
    const id = requireObjectId(req.params.id, "offer ID");
    const result = await collections.offers.deleteOne({ _id: id });

    if (result.deletedCount === 0) throw new ApiError(404, "Offer not found.");
    res.status(200).json({ ok: true, message: "Offer deleted." });
  }),
);

export default router;
