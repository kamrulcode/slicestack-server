import { Router } from "express";
import multer from "multer";
import { requireAuth } from "../middleware/auth.js";
import { ApiError, asyncHandler } from "../utils/http.js";
import { uploadToImgBB } from "../services/imgbb.js";

const router = Router();

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 6 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED.has(file.mimetype)) {
      cb(new ApiError(400, "Upload a JPG, PNG, WEBP or GIF image."));
      return;
    }
    cb(null, true);
  },
});

function handleMulterError(error) {
  if (error instanceof multer.MulterError) {
    return new ApiError(
      400,
      error.code === "LIMIT_FILE_SIZE"
        ? "Each image must be 5MB or smaller."
        : "Image upload failed.",
    );
  }
  return error;
}

// Any signed-in user may upload an avatar; vendors upload menu images.
router.post(
  "/uploads/image",
  requireAuth,
  (req, res, next) => {
    upload.single("image")(req, res, (error) => {
      if (error) next(handleMulterError(error));
      else next();
    });
  },
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ApiError(400, "Choose an image to upload.");

    const url = await uploadToImgBB(req.file.buffer, req.file.mimetype);
    res.status(201).json({ ok: true, url });
  }),
);

router.post(
  "/uploads/images",
  requireAuth,
  (req, res, next) => {
    upload.array("images", 6)(req, res, (error) => {
      if (error) next(handleMulterError(error));
      else next();
    });
  },
  asyncHandler(async (req, res) => {
    if (!req.files?.length) throw new ApiError(400, "Choose at least one image.");

    const urls = await Promise.all(
      req.files.map((file) => uploadToImgBB(file.buffer, file.mimetype)),
    );

    res.status(201).json({ ok: true, urls });
  }),
);

export default router;
