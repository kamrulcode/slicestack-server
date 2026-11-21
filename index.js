import express from "express";
import cors from "cors";
import "dotenv/config";

import { collections, ensureIndexes } from "./src/config/db.js";
import { attachUser } from "./src/middleware/auth.js";
import { ApiError } from "./src/utils/http.js";
import menuRoutes from "./src/routes/menu.routes.js";
import orderRoutes from "./src/routes/orders.routes.js";
import adminRoutes from "./src/routes/admin.routes.js";
import userRoutes from "./src/routes/users.routes.js";
import favoriteRoutes from "./src/routes/favorites.routes.js";
import reviewRoutes from "./src/routes/reviews.routes.js";
import uploadRoutes from "./src/routes/uploads.routes.js";
import subscriptionRoutes, {
  stripeWebhookHandler,
} from "./src/routes/subscriptions.routes.js";

const app = express();
const port = Number(process.env.PORT || 8000);

const allowedOrigins = (process.env.CLIENT_URL || "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Requests without an Origin header (server-to-server, curl) are allowed.
      if (!origin || allowedOrigins.includes(origin.replace(/\/$/, ""))) {
        callback(null, true);
        return;
      }
      callback(new ApiError(403, "This origin is not allowed."));
    },
  }),
);

// Stripe needs the untouched request body to verify the signature, so this
// route is registered before express.json().
app.post(
  "/api/webhooks/stripe",
  express.raw({ type: "application/json" }),
  stripeWebhookHandler,
);

app.use(express.json({ limit: "1mb" }));

// Resolve the Better Auth JWT for every request. Public routes simply continue
// without a user; protected routes enforce it.
app.use("/api", attachUser);

app.get("/", (_req, res) => {
  res.send("SliceStack API");
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "slicestack-api" });
});

// Public shop directory, kept from the original backend.
app.get("/api/shops", async (_req, res, next) => {
  try {
    const shops = await collections.shops
      .find({ status: "active" })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();

    res.json(
      shops.map((shop) => ({
        _id: shop._id.toString(),
        ownerId: shop.ownerId,
        name: shop.name,
        description: shop.description,
        address: shop.address,
        phone: shop.phone,
        logoUrl: shop.logoUrl ?? null,
        status: shop.status,
        plan: shop.plan ?? "free",
      })),
    );
  } catch (error) {
    next(error);
  }
});

app.use("/api", menuRoutes);
app.use("/api", orderRoutes);
app.use("/api", adminRoutes);
app.use("/api", userRoutes);

app.use("/api", favoriteRoutes);
app.use("/api", reviewRoutes);
app.use("/api", uploadRoutes);
app.use("/api", subscriptionRoutes);

app.use((_req, _res, next) => {
  next(new ApiError(404, "API route not found."));
});

// Single error handler: ApiError messages are safe to show, everything else is
// logged and replaced with a generic message.
app.use((error, _req, res, _next) => {
  const status = error instanceof ApiError ? error.status : 500;

  if (status >= 500) {
    console.error(error);
  }

  res.status(status).json({
    error:
      status >= 500 ? "Something went wrong. Please try again." : error.message,
  });
});

async function start() {
  try {
    await ensureIndexes();
  } catch (error) {
    console.error("Index setup failed:", error.message);
  }

  app.listen(port, () => {
    console.log(`SliceStack API listening on http://localhost:${port}`);
  });
}

start();
