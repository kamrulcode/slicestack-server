import { ObjectId } from "mongodb";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { collections } from "../config/db.js";
import { ApiError } from "../utils/http.js";

const AUTH_URL = (process.env.BETTER_AUTH_URL || "http://localhost:3000").replace(
  /\/$/,
  "",
);

// Better Auth publishes the signing keys for its JWT plugin here. Keys are
// cached by jose and refreshed automatically when the key set rotates.
const JWKS = createRemoteJWKSet(
  new URL(`${AUTH_URL}/api/auth/jwks`),
  { cacheMaxAge: 5 * 60 * 1000 },
);

function normalizeRole(value) {
  return value === "admin" || value === "vendor" ? value : "customer";
}

async function userFromToken(token) {
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: AUTH_URL,
    audience: AUTH_URL,
  });

  if (typeof payload.sub !== "string" || !ObjectId.isValid(payload.sub)) {
    return null;
  }

  // Always read the role and block flag from the database, never from the
  // token, so a role change or block takes effect immediately.
  const doc = await collections.users.findOne({
    _id: new ObjectId(payload.sub),
  });

  if (!doc) return null;

  return {
    id: doc._id.toString(),
    name: doc.name,
    email: doc.email,
    image: doc.image ?? null,
    role: normalizeRole(doc.role),
    blocked: doc.blocked === true,
    createdAt: doc.createdAt ?? null,
  };
}

/** Resolve the bearer token, but allow the request to continue anonymously. */
export async function attachUser(req, _res, next) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

  if (!token) {
    next();
    return;
  }

  try {
    req.user = await userFromToken(token);
  } catch {
    // Invalid or expired tokens are treated as anonymous; protected routes
    // then return 401 and the client can refresh its token.
    req.user = null;
  }

  next();
}

/** Require a signed-in, non-blocked user. */
export function requireAuth(req, _res, next) {
  if (!req.user) {
    next(new ApiError(401, "Please sign in to continue."));
    return;
  }

  if (req.user.blocked) {
    next(
      new ApiError(403, "Your account has been blocked. Contact SliceStack support."),
    );
    return;
  }

  next();
}

/** Require one of the given roles. Always use after `requireAuth`. */
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) {
      next(new ApiError(401, "Please sign in to continue."));
      return;
    }

    if (!roles.includes(req.user.role)) {
      next(new ApiError(403, "You do not have access to this resource."));
      return;
    }

    next();
  };
}

/**
 * Vendors need an approved application and an active shop. Returns the shop on
 * `req.shop` so handlers never have to trust a client-supplied owner ID.
 */
export async function requireVendor(req, _res, next) {
  try {
    if (!req.user) throw new ApiError(401, "Please sign in to continue.");
    if (req.user.blocked) {
      throw new ApiError(403, "Your account has been blocked.");
    }
    if (req.user.role !== "vendor") {
      throw new ApiError(403, "A vendor account is required.");
    }

    const [application, shop] = await Promise.all([
      collections.applications.findOne({ userId: req.user.id }),
      collections.shops.findOne({ ownerId: req.user.id }),
    ]);

    if (application?.status !== "APPROVED" || shop?.status !== "active") {
      throw new ApiError(403, "Your vendor workspace is not active.");
    }

    req.application = application;
    req.shop = shop;
    next();
  } catch (error) {
    next(error);
  }
}
