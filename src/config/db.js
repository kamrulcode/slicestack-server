import { MongoClient } from "mongodb";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const mongoUrl = process.env.MONGODB_URL;

if (!mongoUrl) {
  throw new Error("MONGODB_URL must be set for the SliceStack API.");
}

// Reuse a single client when the module is reloaded in development.
const globalForMongo = globalThis;
const client =
  globalForMongo.__slicestackMongoClient ?? new MongoClient(mongoUrl);

if (!globalForMongo.__slicestackMongoClient) {
  globalForMongo.__slicestackMongoClient = client;
}

await client.connect();

export const db = client.db("slicestack");

export const collections = {
  users: db.collection("user"),
  sessions: db.collection("session"),
  menus: db.collection("menus"),
  offers: db.collection("offers"),
  shops: db.collection("shops"),
  applications: db.collection("vendorApplications"),
  orders: db.collection("orders"),
  favorites: db.collection("favorites"),
  reviews: db.collection("reviews"),
  transactions: db.collection("transactions"),
  newsletter: db.collection("newsletter"),
};

/**
 * Indexes back the ownership rules and duplicate protections. They are safe to
 * call on every boot: MongoDB ignores an index that already exists.
 */
export async function ensureIndexes() {
  await Promise.all([
    collections.menus.createIndex({ ownerId: 1, createdAt: -1 }),
    collections.menus.createIndex({ status: 1, isAvailable: 1 }),
    collections.offers.createIndex({ isActive: 1, createdAt: -1 }),
    collections.shops.createIndex({ ownerId: 1 }, { unique: true }),
    collections.applications.createIndex({ userId: 1 }, { unique: true }),
    collections.orders.createIndex({ customerId: 1, createdAt: -1 }),
    collections.orders.createIndex({ ownerId: 1, createdAt: -1 }),
    collections.orders.createIndex(
      { customerId: 1, menuItemId: 1, deliveryDate: 1 },
      {
        unique: true,
        partialFilterExpression: { status: "pending" },
        name: "unique_pending_order",
      },
    ),
    collections.favorites.createIndex(
      { userId: 1, menuItemId: 1 },
      { unique: true },
    ),
    collections.favorites.createIndex({ userId: 1, createdAt: -1 }),
    collections.reviews.createIndex(
      { menuItemId: 1, customerId: 1 },
      { unique: true },
    ),
    collections.reviews.createIndex({ menuItemId: 1, createdAt: -1 }),
    collections.transactions.createIndex(
      { stripeSessionId: 1 },
      { unique: true, sparse: true },
    ),
    collections.transactions.createIndex(
      { stripeInvoiceId: 1 },
      { unique: true, sparse: true },
    ),
    collections.transactions.createIndex(
      { vendorId: 1 },
      {
        unique: true,
        partialFilterExpression: { status: "pending" },
        name: "unique_pending_subscription_payment",
      },
    ),
    collections.transactions.createIndex({ stripeSubscriptionId: 1 }),
    collections.transactions.createIndex({ vendorId: 1, createdAt: -1 }),
    collections.newsletter.createIndex({ email: 1 }, { unique: true }),
  ]);
}
