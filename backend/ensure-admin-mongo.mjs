import admin from "./mongo-firebase-compat.js";
import { getMongoDb } from "./mongodb.js";

const email = String(process.env.ADMIN_EMAIL || "lipupoddar@gmail.com").trim().toLowerCase();
const password = String(process.env.ADMIN_PASSWORD || "");

if (!password) {
  throw new Error("ADMIN_PASSWORD is required for MongoDB admin bootstrap");
}

const auth = admin.auth();
let user;
try {
  user = await auth.getUserByEmail(email);
  await auth.updateUser(user.uid, { password, disabled: false, displayName: user.displayName || "Aura Farming Admin" });
  user = await auth.getUser(user.uid);
  console.log("MONGO_ADMIN=UPDATED");
} catch (e) {
  if (e?.code !== "auth/user-not-found") throw e;
  user = await auth.createUser({ email, password, displayName: "Aura Farming Admin", admin: true });
  console.log("MONGO_ADMIN=CREATED");
}

const db = await getMongoDb();
await db.collection("users").doc(user.uid).set({
  email,
  name: user.displayName || "Aura Farming Admin",
  admin: true,
  updatedAt: new Date(),
  createdAt: new Date()
}, { merge: true });

console.log("MONGO_ADMIN_EMAIL=" + email);
