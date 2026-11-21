import { ObjectId } from "mongodb";

/** An error with an HTTP status and a message that is safe to show clients. */
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Express 5 forwards rejected promises, but this keeps handlers explicit. */
export function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function toObjectId(value) {
  return typeof value === "string" && ObjectId.isValid(value)
    ? new ObjectId(value)
    : null;
}

export function requireObjectId(value, label = "ID") {
  const id = toObjectId(value);
  if (!id) throw new ApiError(400, `Invalid ${label}.`);
  return id;
}

export function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function cleanString(value, maxLength = 500) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

/** Convert a Mongo document into an API-safe object (string IDs). */
export function serialize(doc) {
  if (!doc) return doc;
  if (Array.isArray(doc)) return doc.map(serialize);
  if (typeof doc !== "object") return doc;
  if (doc instanceof Date) return doc.toISOString();
  if (doc instanceof ObjectId) return doc.toString();

  return Object.fromEntries(
    Object.entries(doc).map(([key, value]) => [key, serialize(value)]),
  );
}
