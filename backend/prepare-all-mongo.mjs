import { readFileSync, writeFileSync } from "node:fs";

const target = new URL("./server.js", import.meta.url);
let source = readFileSync(target, "utf8");

function replaceOnce(pattern, replacement, label) {
  const next = source.replace(pattern, replacement);
  if (next === source) throw new Error(`${label} patch not applied`);
  source = next;
}

if (!source.includes('import { getMongoDb } from "./mongodb.js";')) {
  replaceOnce(
    'import { fileURLToPath } from "node:url";',
    'import { fileURLToPath } from "node:url";\nimport { getMongoDb } from "./mongodb.js";\nimport { createAuthToken } from "./mongo-firebase-compat.js";',
    "Mongo imports"
  );
}

replaceOnce(
  /import admin from "firebase-admin";/,
  'import admin from "./mongo-firebase-compat.js";',
  "Firebase Admin import"
);

replaceOnce(
  /function initFirebase\(\) \{[\s\S]*?\n\}\n\nasync function requireAuth/,
  `function initFirebase() {
  // Compatibility name kept so existing routes stay stable; all persistence and
  // authentication now run against MongoDB. Firebase Admin/Firestore are not used.
  if (!db) db = admin.firestore();
  bucket = null;
}

async function requireAuth`,
  "Firebase initialization"
);

replaceOnce(
  /function terminalSessionSecret\(\) \{[\s\S]*?\n\}\nfunction base64url/,
  `function terminalSessionSecret() {
  const material = process.env.TERMINAL_CREDENTIAL_SECRET || process.env.AUTH_SESSION_SECRET || process.env.MONGO_URI || "course-era-mongo-terminal";
  return crypto.createHash("sha256").update(String(material) + "|terminal-session-v1").digest();
}
function base64url`,
  "terminal session secret"
);

replaceOnce(
  /function terminalCredentialKey\(\) \{[\s\S]*?\n\}\n\nfunction encryptTerminalSecret/,
  `function terminalCredentialKey() {
  const material = process.env.TERMINAL_CREDENTIAL_SECRET || process.env.AUTH_SESSION_SECRET || process.env.MONGO_URI || "course-era-mongo-terminal";
  return crypto.createHash("sha256").update(String(material)).digest();
}

function encryptTerminalSecret`,
  "terminal credential key"
);

replaceOnce(
  /app\.post\("\/api\/terminal\/login", terminalLoginRateLimit, async \(req, res\) => \{/,
  `app.post("/api/auth/signup", async (req, res) => {
  try {
    initFirebase();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const name = String(req.body?.name || "").trim().slice(0, 120);
    if (!email || !password || !name) return res.status(400).json({ error: "Name, email and password are required" });
    const user = await admin.auth().createUser({ email, password, displayName: name });
    await db.collection("users").doc(user.uid).set({
      email, name, mobile: "", photoURL: "", createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    const token = createAuthToken(user);
    res.status(201).json({ token, user: { uid: user.uid, email: user.email, displayName: user.displayName || name, photoURL: user.photoURL || "" } });
  } catch (e) {
    const status = e?.code === "auth/email-already-in-use" ? 409 : 400;
    res.status(status).json({ error: e?.message || "Could not create account", code: e?.code || "auth/signup-failed" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    initFirebase();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
    const user = await admin.auth().signInWithEmailAndPassword(email, password);
    const token = createAuthToken(user);
    res.json({ token, user: { uid: user.uid, email: user.email, displayName: user.displayName || "", photoURL: user.photoURL || "", admin: Boolean(user.admin) } });
  } catch (e) {
    res.status(401).json({ error: e?.message || "Email or password is incorrect", code: e?.code || "auth/invalid-credential" });
  }
});

app.get("/api/auth/me", requireAuth, async (req, res) => {
  res.json({ user: { uid: req.user.uid, email: req.user.email || "", displayName: req.user.displayName || req.user.name || "", photoURL: req.user.photoURL || "", admin: Boolean(req.user.admin) } });
});

app.post("/api/terminal/login", terminalLoginRateLimit, async (req, res) => {`,
  "Mongo auth routes"
);

replaceOnce(
  /app\.get\("\/api\/config", \(req, res\) => \{[\s\S]*?\n\}\);/,
  `app.get("/api/config", (req, res) => {
  res.json({
    siteName: "Aura Farming",
    status: "backend-ready",
    mongoConfigured: true,
    storageConfigured: false,
    firebaseConfigured: false
  });
});`,
  "API config"
);

replaceOnce(
  /app\.post\("\/api\/profile\/photo", requireAuth, upload\.single\("photo"\), async \(req, res\) => \{[\s\S]*?\n\}\);/,
  `app.post("/api/profile/photo", requireAuth, upload.single("photo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Photo is required" });
    if (!String(req.file.mimetype || "").startsWith("image/")) return res.status(400).json({ error: "Only image files are allowed" });
    if (req.file.size > 5 * 1024 * 1024) return res.status(400).json({ error: "Photo must be 5MB or smaller" });
    const photoURL = "data:" + req.file.mimetype + ";base64," + req.file.buffer.toString("base64");
    await admin.auth().updateUser(req.user.uid, { photoURL });
    await db.collection("users").doc(req.user.uid).set({ photoURL, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    res.json({ message: "Profile photo updated", photoURL });
  } catch (e) {
    console.error("PROFILE_PHOTO_MONGO_ERROR", e);
    res.status(500).json({ error: "Could not update profile photo" });
  }
});`,
  "profile photo storage"
);

replaceOnce(
  /app\.post\("\/api\/payment-settings\/qr", requireAuth, requireAdmin, upload\.single\("qr"\), async \(req, res\) => \{[\s\S]*?\n\}\);/,
  `app.post("/api/payment-settings/qr", requireAuth, requireAdmin, upload.single("qr"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "QR image is required" });
    if (!String(req.file.mimetype || "").startsWith("image/")) return res.status(400).json({ error: "Only image files are allowed" });
    if (req.file.size > 5 * 1024 * 1024) return res.status(400).json({ error: "QR image must be 5MB or smaller" });
    if (req.file.buffer.length > 650000) return res.status(400).json({ error: "QR image is too large. Please choose a smaller image." });
    const qrImageUrl = "data:" + req.file.mimetype + ";base64," + req.file.buffer.toString("base64");
    await db.collection("settings").doc("payment").set({ qrImageUrl, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: req.user.uid }, { merge: true });
    res.json({ message: "Payment QR updated", qrImageUrl });
  } catch (e) {
    console.error("PAYMENT_QR_MONGO_ERROR", e);
    res.status(500).json({ error: "Could not update payment QR" });
  }
});`,
  "payment QR storage"
);

writeFileSync(target, source);
console.log("ALL_MONGO_RUNTIME_PATCH=OK");
