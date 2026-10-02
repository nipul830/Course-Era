import { readFileSync } from "node:fs";

const serverFile = new URL("./server.js", import.meta.url);
const source = readFileSync(serverFile, "utf8");
const mongoImportReady = source.includes('import admin from "./mongo-firebase-compat.js";');
const authRoutesReady = source.includes('app.post("/api/auth/login"');

// The Mongo migration patch was historically a one-time manual step. Run it
// automatically before server.js only when the server has not been converted
// yet. Once converted, do nothing so every restart remains safe and idempotent.
if (!mongoImportReady || !authRoutesReady) {
  await import("./prepare-all-mongo.mjs");
}
