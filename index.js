import express from "express";
import { MongoClient } from "mongodb";
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

// get users data ***********

app.get("/users", async (req, res) => {
  const cursor = users.find();
  const result = await cursor.toArray();
  res.send(result);
});

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
