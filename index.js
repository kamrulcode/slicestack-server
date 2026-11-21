import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import cors from "cors";

import "dotenv/config";

const app = express();
app.use(cors());
app.use(express.json());
const port = process.env.PORT || 8000;

const client = new MongoClient(process.env.MONGODB_URL);
export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

const connectClient = await connectToMongoDB();
const db = connectClient.db("slicestack");
const users = db.collection("user");
const menus = db.collection("menus");
const shops = db.collection("shops");
const menuCategories = new Set([
  "Classic Pizzas",
  "Vegetarian Pizzas",
  "Meat Lovers",
  "Specialty / Gourmet Pizzas",
  "Sides & Appetizers",
  "Beverages & Desserts",
]);

function getMenuOwnerId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getMenuItemId(value) {
  return typeof value === "string" && ObjectId.isValid(value)
    ? new ObjectId(value)
    : null;
}

function isValidMenuItem({ itemName, category, price }) {
  return (
    typeof itemName === "string" &&
    itemName.trim().length >= 3 &&
    itemName.trim().length <= 100 &&
    typeof category === "string" &&
    menuCategories.has(category.trim()) &&
    typeof price === "number" &&
    Number.isFinite(price) &&
    price > 0
  );
}

// get users data ***********

app.get("/users", async (req, res) => {
  const cursor = users.find();
  const result = await cursor.toArray();
  res.send(result);
});

// menu items data *********

// PUBLIC: Get all approved and available menu items
app.get("/api/menu-items", async (req, res) => {
  try {
    const result = await menus
      .find({
        status: "approved",
        isAvailable: true,
      })
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json(result);
  } catch (error) {
    console.error("Public menu retrieval failed:", error);
    res.status(500).json({
      message: "Unable to load menu items.",
    });
  }
});

const MENU_STATUSES = ["pending", "approved", "rejected"];

// ADMIN: Get all menu items or filter by status
app.get("/api/admin/menu-items", async (req, res) => {
  try {
    const { status } = req.query;

    const filter = {};

    if (status && status !== "all") {
      if (!MENU_STATUSES.includes(status)) {
        return res.status(400).json({
          message: "Invalid menu status.",
        });
      }

      filter.status = status;
    }

    const result = await menus.find(filter).sort({ createdAt: -1 }).toArray();

    return res.status(200).json(result);
  } catch (error) {
    console.error("Admin menu retrieval failed:", error);

    return res.status(500).json({
      message: "Unable to load menu items.",
    });
  }
});

// ADMIN: Update menu item details and approval status
app.patch("/api/admin/menu-items/:id", async (req, res) => {
  const id = getMenuItemId(req.params.id);

  const { itemName, category, price, status } = req.body ?? {};

  if (
    !id ||
    !isValidMenuItem({ itemName, category, price }) ||
    !MENU_STATUSES.includes(status)
  ) {
    return res.status(400).json({
      ok: false,
      message: "Invalid menu item details or approval status.",
    });
  }

  try {
    const result = await menus.updateOne(
      { _id: id },
      {
        $set: {
          itemName: itemName.trim(),
          category: category.trim(),
          price,
          status,
          updatedAt: new Date(),
        },
      },
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        ok: false,
        message: "Menu item not found.",
      });
    }

    return res.status(200).json({
      ok: true,
      message: "Menu item updated successfully.",
    });
  } catch (error) {
    console.error("Admin menu update failed:", error);

    return res.status(500).json({
      ok: false,
      message: "Unable to update menu item.",
    });
  }
});

// ADMIN: Delete any vendor's menu item
app.delete("/api/admin/menu-items/:id", async (req, res) => {
  const id = getMenuItemId(req.params.id);

  if (!id) {
    return res.status(400).json({
      ok: false,
      message: "Invalid menu item ID.",
    });
  }

  try {
    const result = await menus.deleteOne({ _id: id });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        ok: false,
        message: "Menu item not found.",
      });
    }

    return res.status(200).json({
      ok: true,
      message: "Menu item deleted successfully.",
    });
  } catch (error) {
    console.error("Admin menu deletion failed:", error);

    return res.status(500).json({
      ok: false,
      message: "Unable to delete menu item.",
    });
  }
});

// VENDOR DASHBOARD: Get only logged-in vendor's menu items
app.get("/api/menu-items/vendor/:ownerId", async (req, res) => {
  const ownerId = getMenuOwnerId(req.params.ownerId);

  if (!ownerId) {
    return res.status(400).json({
      message: "An owner ID is required.",
    });
  }

  try {
    const result = await menus
      .find({ ownerId })
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json(result);
  } catch (error) {
    console.error("Vendor menu retrieval failed:", error);
    res.status(500).json({
      message: "Unable to load vendor menu items.",
    });
  }
});

app.post("/api/menu-items", async (req, res) => {
  const data = req.body ?? {};
  const ownerId = getMenuOwnerId(data.ownerId);

  const validImages =
    Array.isArray(data.images) &&
    data.images.length > 0 &&
    data.images.every(
      (image) => typeof image === "string" && /^https:\/\/\S+$/i.test(image),
    );

  if (
    !ownerId ||
    !isValidMenuItem(data) ||
    typeof data.description !== "string" ||
    data.description.trim().length < 20 ||
    typeof data.location !== "string" ||
    data.location.trim().length < 2 ||
    !validImages
  ) {
    return res.status(400).json({
      ok: false,
      message: "Enter valid menu item details.",
    });
  }

  try {
    const now = new Date();

    const result = await menus.insertOne({
      itemName: data.itemName.trim(),
      category: data.category.trim(),
      description: data.description.trim(),
      price: data.price,
      location: data.location.trim(),
      images: data.images,
      status: "pending",
      isAvailable: true,
      logoUrl: typeof data.logoUrl === "string" ? data.logoUrl : null,
      shopName: typeof data.shopName === "string" ? data.shopName : "",
      ownerId,
      createdAt: now,
      updatedAt: now,
    });

    return res.status(201).json({
      ok: true,
      id: result.insertedId.toString(),
      message: "Menu item submitted successfully.",
    });
  } catch (error) {
    console.error("Menu item creation failed:", error);

    return res.status(500).json({
      ok: false,
      message: "Unable to create menu item.",
    });
  }
});

app.put("/api/menu-items/:id", async (req, res) => {
  const id = getMenuItemId(req.params.id);
  const ownerId = getMenuOwnerId(req.query.ownerId);
  const data = req.body ?? {};

  if (!id || !ownerId || !isValidMenuItem(data)) {
    res
      .status(400)
      .json({ message: "Enter a valid name, category, and price." });
    return;
  }

  try {
    const result = await menus.updateOne(
      { _id: id, ownerId },
      {
        $set: {
          itemName: data.itemName.trim(),
          category: data.category.trim(),
          price: data.price,
          updatedAt: new Date(),
        },
      },
    );

    if (result.matchedCount === 0) {
      res.status(404).json({ message: "Menu item not found." });
      return;
    }

    res.json({ ok: true, message: "Menu item updated." });
  } catch (error) {
    console.error("Menu item update failed", error);
    res.status(500).json({ message: "Unable to update menu item." });
  }
});

app.patch("/api/menu-items/:id/availability", async (req, res) => {
  const id = getMenuItemId(req.params.id);
  const ownerId = getMenuOwnerId(req.query.ownerId);
  const { isAvailable } = req.body ?? {};

  if (!id || !ownerId || typeof isAvailable !== "boolean") {
    res.status(400).json({ message: "Invalid availability update." });
    return;
  }

  try {
    const result = await menus.updateOne(
      { _id: id, ownerId },
      { $set: { isAvailable, updatedAt: new Date() } },
    );

    if (result.matchedCount === 0) {
      res.status(404).json({ message: "Menu item not found." });
      return;
    }

    res.json({ ok: true, message: "Availability updated." });
  } catch (error) {
    console.error("Menu item availability update failed", error);
    res.status(500).json({ message: "Unable to update availability." });
  }
});

app.delete("/api/menu-items/:id", async (req, res) => {
  const id = getMenuItemId(req.params.id);
  const ownerId = getMenuOwnerId(req.query.ownerId);

  if (!id || !ownerId) {
    return res.status(400).json({
      ok: false,
      message: "Invalid menu item ID or owner ID.",
    });
  }

  try {
    const result = await menus.deleteOne({
      _id: id,
      ownerId,
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        ok: false,
        message: "Menu item not found.",
      });
    }

    return res.status(200).json({
      ok: true,
      message: "Menu item deleted successfully.",
    });
  } catch (error) {
    console.error("Menu item deletion failed:", error);

    return res.status(500).json({
      ok: false,
      message: "Unable to delete menu item.",
    });
  }
});

// get shop details ***
app.get("/api/shops", async (req, res) => {
  const cursor = shops.find();
  const result = await cursor.toArray();
  res.send(result);
});

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
