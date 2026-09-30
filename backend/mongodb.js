import { MongoClient } from "mongodb";
import "dotenv/config";

// Course-Era MongoDB connection used by the migrated challenge/account data.
const uri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/courseera";
const client = new MongoClient(uri, {
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 5000,
  socketTimeoutMS: 10000
});
let database = null;
let connecting = null;

export async function getMongoDb() {
  if (database) return database;
  if (!connecting) {
    connecting = (async () => {
      await client.connect();
      const dbName = process.env.MONGO_DB_NAME || undefined;
      database = dbName ? client.db(dbName) : client.db();
      await database.command({ ping: 1 });
      return database;
    })().catch(err => {
      database = null;
      throw err;
    }).finally(() => {
      connecting = null;
    });
  }
  return connecting;
}

export async function closeMongoDb() {
  if (database || connecting) {
    await client.close();
    database = null;
    connecting = null;
  }
}
