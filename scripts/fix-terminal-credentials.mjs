import { readFileSync, writeFileSync } from "node:fs";

const path = "backend/server.js";
const text = readFileSync(path, "utf8");

const old = `  if (existingId) {
    const existing = await db.collection("terminalCredentials").doc(existingId).get();
    if (existing.exists) return { id: existingId, data: existing.data() || {}, created: false };
  }
`;

const replacement = `  if (existingId) {
    const existing = await db.collection("terminalCredentials").doc(existingId).get();
    if (existing.exists) {
      const existingData = existing.data() || {};
      if (existingData.status === "active") {
        return { id: existingId, data: existingData, created: false };
      }
      // Never show or reuse a revoked credential on the dashboard.
      // Keep the old credential for audit history, but detach it from the
      // active trading account so the transaction below issues a fresh one.
      await accountRef.update({
        terminalCredentialId: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
  }
`;

if (!text.includes(old)) {
  console.log("Terminal credential fix already present or source changed");
  process.exit(0);
}

writeFileSync(path, text.replace(old, replacement));
console.log("Patched revoked terminal credential reuse");
