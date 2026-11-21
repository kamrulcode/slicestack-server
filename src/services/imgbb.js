import { ApiError } from "../utils/http.js";

const IMGBB_ENDPOINT = "https://api.imgbb.com/1/upload";

/**
 * Upload a buffer to ImgBB from the server so the API key never reaches the
 * browser. Returns the hosted image URL.
 */
export async function uploadToImgBB(buffer, mimeType) {
  const key = process.env.IMGBB_API_KEY;
  if (!key) {
    throw new ApiError(
      503,
      "Image uploads are not configured. Add IMGBB_API_KEY to the server environment.",
    );
  }

  const form = new FormData();
  form.append("image", new Blob([buffer], { type: mimeType }), "upload");
  form.append("name", `slicestack-${Date.now()}`);

  let response;
  try {
    response = await fetch(`${IMGBB_ENDPOINT}?key=${key}`, {
      method: "POST",
      body: form,
    });
  } catch {
    throw new ApiError(502, "Could not reach the image host. Try again.");
  }

  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.success || !data?.data?.url) {
    throw new ApiError(
      502,
      data?.error?.message || "Image upload failed. Try a smaller image.",
    );
  }

  return data.data.url;
}

export function isUploadConfigured() {
  return Boolean(process.env.IMGBB_API_KEY);
}
