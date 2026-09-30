import { MongoClient } from "mongodb";
import "dotenv/config";

const uri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/courseera";
const client = new MongoClient(uri);
let database = null;

export async function getMongoDb() {
  if (database) return database;
  await client.connect();
  database = client.db();
  await database.command({ ping: 1 });
  return database;
}

export async function closeMongoDb() {
  if (database) {
    await client.close();
    database = null;
  }
}
