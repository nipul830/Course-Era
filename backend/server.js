import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import admin from "firebase-admin";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const app = express();
const httpServer = http.createServer(app);
const meetingWss = new WebSocketServer({ noServer: true });
const meetingRooms = new Map();
const PORT = Number(process.env.PORT || 3000);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }
});

const allowedOrigins = [
  ...(process.env.FRONTEND_ORIGIN || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean),
  "capacitor://localhost",
  "http://localhost",
  "https://localhost"
];

app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Origin not allowed"));
  }
}));
app.use(express.json({ limit: "1mb" }));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: "draft-8",
  legacyHeaders: false
}));

let db;
let bucket;
// Short-lived terminal auth cache: the terminal polls market data frequently,
// so validating the same session against Firestore on every poll can exhaust
// the free Firestore read quota. Revocation is still re-checked after expiry.
const terminalAuthCache = new Map();
const TERMINAL_AUTH_CACHE_MS = 10000;

function initFirebase() {
  if (admin.apps.length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const credentialFile = process.env.GOOGLE_APPLICATION_CREDENTIALS || "/etc/secrets/firebase-service-account.json";

  if (raw) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(raw)),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || undefined
    });
  } else {
    // Render Secret Files are mounted under /etc/secrets. Prefer the configured
    // file when it exists, and fall back to Application Default Credentials.
    try {
      const serviceAccount = JSON.parse(readFileSync(credentialFile, "utf8"));
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET || undefined
      });
    } catch {
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET || undefined
      });
    }
  }

  db = admin.firestore();
  if (process.env.FIREBASE_STORAGE_BUCKET) {
    bucket = admin.storage().bucket();
  }
}

async function requireAuth(req, res, next) {
  try {
    initFirebase();
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Authentication required" });
    }
    req.user = await admin.auth().verifyIdToken(header.slice(7));
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired Firebase ID token" });
  }
}

async function requireAdmin(req, res, next) {
  try {
    initFirebase();
    const email = (req.user?.email || "").toLowerCase();
    const allowed = (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map(x => x.trim().toLowerCase())
      .filter(Boolean);

    if (req.user?.admin === true || (email && allowed.includes(email))) {
      return next();
    }

    return res.status(403).json({ error: "Admin access required" });
  } catch {
    res.status(500).json({ error: "Admin authorization failed" });
  }
}

function cleanId(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function positiveAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

const TERMINAL_PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";

function generateTerminalPassword(length = 14) {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += TERMINAL_PASSWORD_ALPHABET[bytes[i] % TERMINAL_PASSWORD_ALPHABET.length];
  return out;
}

function hashTerminalPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return salt.toString("hex") + ":" + hash.toString("hex");
}

function verifyTerminalPassword(password, stored) {
  try {
    const [saltHex, hashHex] = String(stored || "").split(":");
    if (!saltHex || !hashHex) return false;
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const actual = crypto.scryptSync(String(password), salt, expected.length, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function terminalSessionSecret() {
  let material = process.env.TERMINAL_CREDENTIAL_SECRET || process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "";
  if (!material && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    try { material = readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"); } catch {}
  }
  if (!material) throw new Error("Terminal session signing is not configured on the server");
  return crypto.createHash("sha256").update(String(material) + "|terminal-session-v1").digest();
}
function base64url(value) {
  return Buffer.from(value).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function fromBase64url(value) {
  return Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
function createTerminalSessionToken({ userId, accountId, credentialId, role }) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { uid:String(userId), accountId:String(accountId), credentialId:String(credentialId), role:String(role), iat:now, exp:now + 12 * 60 * 60 };
  const encoded = base64url(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", terminalSessionSecret()).update(encoded).digest("base64url");
  return "AF1." + encoded + "." + signature;
}
function verifyTerminalSessionToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts[0] !== "AF1") throw new Error("Invalid terminal session");
  const encoded = parts[1], provided = parts[2];
  const expected = crypto.createHmac("sha256", terminalSessionSecret()).update(encoded).digest("base64url");
  const a = Buffer.from(provided), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("Invalid terminal session");
  const payload = JSON.parse(fromBase64url(encoded).toString("utf8"));
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) throw new Error("Terminal session expired");
  return payload;
}

function terminalCredentialKey() {
  let material = process.env.TERMINAL_CREDENTIAL_SECRET || process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "";
  if (!material && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    try { material = readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"); } catch {}
  }
  if (!material) throw new Error("TERMINAL_CREDENTIAL_SECRET is not configured");
  return crypto.createHash("sha256").update(String(material)).digest();
}

function encryptTerminalSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", terminalCredentialKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("hex"), tag.toString("hex"), encrypted.toString("hex")].join(":");
}

function decryptTerminalSecret(value) {
  const [ivHex, tagHex, dataHex] = String(value || "").split(":");
  if (!ivHex || !tagHex || !dataHex) throw new Error("Credential secret is unavailable");
  const decipher = crypto.createDecipheriv("aes-256-gcm", terminalCredentialKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}

async function createTerminalCredentials(accountRef, userId, account) {
  initFirebase();
  const existingId = String(account?.terminalCredentialId || "").trim();
  if (existingId) {
    const existing = await db.collection("terminalCredentials").doc(existingId).get();
    if (existing.exists) return { id: existingId, data: existing.data() || {}, created: false };
  }

  const accountId = String(account?.accountId || "account");
  for (let attempt = 0; attempt < 5; attempt++) {
    const loginId = "AF" + crypto.randomBytes(5).toString("hex").toUpperCase();
    const credentialRef = db.collection("terminalCredentials").doc(loginId);
    const tradingPassword = generateTerminalPassword();
    const investorPassword = generateTerminalPassword();

    const result = await db.runTransaction(async tx => {
      const accountSnap = await tx.get(accountRef);
      const current = accountSnap.data() || {};
      if (current.terminalCredentialId) {
        return { existingId: String(current.terminalCredentialId), created: false };
      }
      const credentialSnap = await tx.get(credentialRef);
      if (credentialSnap.exists) return { collision: true };
      tx.set(credentialRef, {
        userId,
        accountId,
        loginId,
        tradingPasswordHash: hashTerminalPassword(tradingPassword),
        investorPasswordHash: hashTerminalPassword(investorPassword),
        tradingPasswordEnc: encryptTerminalSecret(tradingPassword),
        investorPasswordEnc: encryptTerminalSecret(investorPassword),
        status: "active",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastLoginAt: null,
        lastLoginMode: null,
        revokedAt: null,
        revokedReason: ""
      });
      tx.update(accountRef, {
        terminalCredentialId: loginId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return { created: true, loginId, tradingPassword, investorPassword };
    });

    if (result.collision) continue;
    if (!result.created) {
      const existing = await db.collection("terminalCredentials").doc(result.existingId).get();
      return { id: result.existingId, data: existing.data() || {}, created: false };
    }
    return {
      id: result.loginId,
      data: {
        userId, accountId, loginId: result.loginId, status: "active",
        tradingPasswordEnc: encryptTerminalSecret(result.tradingPassword),
        investorPasswordEnc: encryptTerminalSecret(result.investorPassword)
      },
      created: true,
      credentials: {
        loginId: result.loginId,
        tradingPassword: result.tradingPassword,
        investorPassword: result.investorPassword
      }
    };
  }
  throw new Error("Could not allocate a unique terminal login ID");
}

async function revokeTerminalCredentials(account, reason = "Account breached") {
  initFirebase();
  const credentialId = String(account?.terminalCredentialId || "").trim();
  if (!credentialId) return;
  await db.collection("terminalCredentials").doc(credentialId).set({
    status: "revoked",
    revokedAt: admin.firestore.FieldValue.serverTimestamp(),
    revokedReason: String(reason).slice(0, 200),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
}

async function requireTerminalAuth(req, res, next) {
  try {
    initFirebase();
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) return res.status(401).json({ error: "Terminal login required" });
    const token = verifyTerminalSessionToken(header.slice(7));
    if (!token.credentialId || !token.accountId || !token.uid || !["trader","investor"].includes(token.role)) {
      return res.status(401).json({ error: "Valid terminal credentials are required" });
    }
    const cacheKey = String(header.slice(7));
    const cached = terminalAuthCache.get(cacheKey);
    if (cached && (Date.now() - cached.at) < TERMINAL_AUTH_CACHE_MS) {
      req.terminal = { ...cached.terminal };
      return next();
    }

    const credentialSnap = await db.collection("terminalCredentials").doc(String(token.credentialId)).get();
    if (!credentialSnap.exists) return res.status(401).json({ error: "Terminal credentials revoked" });
    const credential = credentialSnap.data() || {};
    if (credential.status !== "active" || credential.userId !== token.uid || credential.accountId !== token.accountId) {
      terminalAuthCache.delete(cacheKey);
      return res.status(401).json({ error: "Terminal credentials revoked" });
    }
    const accountRef = db.collection("users").doc(token.uid).collection("trading").doc("account");
    const accountSnap = await accountRef.get();
    const account = accountSnap.exists ? (accountSnap.data() || {}) : {};
    if (!accountSnap.exists || account.status !== "active") {
      terminalAuthCache.delete(cacheKey);
      await revokeTerminalCredentials(account, account.status === "breached" ? (account.breachReason || "Account breached") : "Account inactive");
      return res.status(403).json({ error: account.status === "breached" ? "Account breached. Terminal credentials revoked." : "Trading account is not active", status: account.status || "inactive" });
    }
    req.terminal = { ...token, credentialId: String(token.credentialId), terminalRole: token.role, accountRef, account };
    terminalAuthCache.set(cacheKey, { at: Date.now(), terminal: { ...req.terminal } });
    next();
  } catch (e) {
    res.status(401).json({ error: "Invalid or expired terminal session" });
  }
}

const terminalLoginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many terminal login attempts. Please try again later." }
});

app.get("/", (req, res) => {
  res.status(200).send("Course Era API is running. Use /health to check status.");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "Course Era API",
    time: new Date().toISOString()
  });
});

app.get("/api/config", (req, res) => {
  res.json({
    siteName: "Course Era",
    status: "backend-ready",
    firebaseConfigured: Boolean(
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS
    ),
    storageConfigured: Boolean(process.env.FIREBASE_STORAGE_BUCKET)
  });
});

app.post("/api/terminal/login", terminalLoginRateLimit, async (req, res) => {
  try {
    initFirebase();
    const loginId = String(req.body.loginId || "").trim().toUpperCase().slice(0, 40);
    const password = String(req.body.password || "");
    const mode = String(req.body.mode || "trader").toLowerCase() === "investor" ? "investor" : "trader";
    if (!loginId || !password) return res.status(400).json({ error: "Login ID and password are required" });

    const snap = await db.collection("terminalCredentials").doc(loginId).get();
    if (!snap.exists) return res.status(401).json({ error: "Invalid terminal ID or password" });
    const credential = snap.data() || {};
    if (credential.status !== "active") return res.status(403).json({ error: "Terminal credentials are revoked" });

    const accountRef = db.collection("users").doc(String(credential.userId)).collection("trading").doc("account");
    const accountSnap = await accountRef.get();
    const account = accountSnap.exists ? (accountSnap.data() || {}) : {};
    if (!accountSnap.exists || account.accountId !== credential.accountId || account.status !== "active") {
      await revokeTerminalCredentials(account, account.status === "breached" ? (account.breachReason || "Account breached") : "Account inactive");
      return res.status(403).json({ error: account.status === "breached" ? "Account breached. Terminal credentials revoked." : "Trading account is not active", status: account.status || "inactive" });
    }

    const hash = mode === "investor" ? credential.investorPasswordHash : credential.tradingPasswordHash;
    if (!verifyTerminalPassword(password, hash)) return res.status(401).json({ error: "Invalid terminal ID or password" });

    const sessionToken = createTerminalSessionToken({
      userId: credential.userId,
      accountId: credential.accountId,
      credentialId: loginId,
      role: mode
    });

    // Login itself does not need a Firestore write. Avoid consuming a write
    // quota unit just to record a cosmetic login timestamp.
    res.json({
      token: sessionToken,
      role: mode,
      account: {
        id: account.accountId,
        balance: Number(account.balance ?? account.startingBalance ?? 0),
        equity: Number(account.equity ?? account.balance ?? account.startingBalance ?? 0),
        status: account.status
      }
    });
  } catch (e) {
    res.status(500).json({ error: "Could not sign in to terminal", detail: e.message });
  }
});

app.get("/api/trading-credentials", requireAuth, async (req, res) => {
  try {
    initFirebase();
    const accountRef = db.collection("users").doc(req.user.uid).collection("trading").doc("account");
    const accountSnap = await accountRef.get();
    if (!accountSnap.exists) return res.status(404).json({ error: "Trading account not found" });
    const account = accountSnap.data() || {};
    if (account.status !== "active") return res.status(403).json({ error: account.status === "breached" ? "Account breached. Terminal credentials revoked." : "Trading account is not active", status: account.status });

    const ensured = await createTerminalCredentials(accountRef, req.user.uid, account);
    const data = ensured.data || {};
    const loginId = data.loginId || ensured.id;
    const tradingPassword = ensured.created
      ? ensured.credentials.tradingPassword
      : decryptTerminalSecret(data.tradingPasswordEnc);
    const investorPassword = ensured.created
      ? ensured.credentials.investorPassword
      : decryptTerminalSecret(data.investorPasswordEnc);

    res.json({ loginId, tradingPassword, investorPassword, accountId: account.accountId || "" });
  } catch (e) {
    res.status(500).json({ error: "Could not load terminal credentials", detail: e.message });
  }
});

app.get("/api/profile", requireAuth, async (req, res) => {
  try {
    initFirebase();
    const snap = await db.collection("users").doc(req.user.uid).get();
    const d = snap.exists ? snap.data() : {};
    res.json({
      name: d.name || req.user.name || req.user.displayName || "",
      email: req.user.email || "",
      mobile: d.mobile || "",
      photoURL: d.photoURL || req.user.picture || ""
    });
  } catch (e) {
    res.status(500).json({ error: "Could not load profile" });
  }
});

app.put("/api/profile", requireAuth, async (req, res) => {
  try {
    initFirebase();
    const name = String(req.body.name || "").trim().slice(0, 80);
    const mobile = String(req.body.mobile || "").trim().slice(0, 30);
    const photoURL = String(req.body.photoURL || "").trim().slice(0, 900000);
    if (!name) return res.status(400).json({ error: "Name is required" });
    if (mobile && !/^[0-9+()\-\s]{7,20}$/.test(mobile)) {
      return res.status(400).json({ error: "Enter a valid mobile number" });
    }
    await db.collection("users").doc(req.user.uid).set({
      name, mobile,
      ...(photoURL ? { photoURL } : {}),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    await admin.auth().updateUser(req.user.uid, { displayName: name });
    res.json({ message: "Profile updated", name, mobile, photoURL });
  } catch (e) {
    res.status(500).json({ error: "Could not update profile" });
  }
});

app.post("/api/profile/photo", requireAuth, upload.single("photo"), async (req, res) => {
  try {
    initFirebase();
    if (!bucket) return res.status(500).json({ error: "Firebase Storage is not configured" });
    if (!req.file) return res.status(400).json({ error: "Photo is required" });
    if (!String(req.file.mimetype || "").startsWith("image/")) return res.status(400).json({ error: "Only image files are allowed" });
    if (req.file.size > 5 * 1024 * 1024) return res.status(400).json({ error: "Photo must be 5MB or smaller" });
    const path = "users/" + req.user.uid + "/profile-" + Date.now();
    const file = bucket.file(path);
    const token = crypto.randomUUID();
    await file.save(req.file.buffer, {
      metadata: {
        contentType: req.file.mimetype,
        cacheControl: "public,max-age=3600",
        metadata: { firebaseStorageDownloadTokens: token }
      }
    });
    const photoURL = "https://firebasestorage.googleapis.com/v0/b/" + encodeURIComponent(bucket.name) + "/o/" + encodeURIComponent(path) + "?alt=media&token=" + encodeURIComponent(token);
    await admin.auth().updateUser(req.user.uid, { photoURL });
    await db.collection("users").doc(req.user.uid).set({
      photoURL, updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    res.json({ message: "Profile photo updated", photoURL });
  } catch (e) {
    res.status(500).json({ error: "Could not update profile photo" });
  }
});

app.get("/api/reviews", async (req, res) => {
  try {
    initFirebase();
    const snap = await db.collection("reviews").orderBy("createdAt", "desc").limit(50).get();
    const reviews = snap.docs.map(doc => {
      const d = doc.data();
      return {
        id: doc.id,
        name: d.name || "Trader",
        rating: Math.min(5, Math.max(1, Number(d.rating) || 5)),
        text: d.text || "",
        createdAt: d.createdAt?.toDate?.()?.toISOString?.() || null
      };
    });
    res.json({ reviews });
  } catch (e) {
    res.status(500).json({ error: "Could not load reviews" });
  }
});

app.post("/api/reviews", requireAuth, async (req, res) => {
  try {
    initFirebase();
    const rating = Number(req.body.rating);
    const text = String(req.body.text || "").trim().slice(0, 800);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: "Rating must be between 1 and 5" });
    }
    if (text.length < 10) {
      return res.status(400).json({ error: "Review must be at least 10 characters" });
    }
    const existing = await db.collection("reviews").doc(req.user.uid).get();
    if (existing.exists) {
      return res.status(409).json({ error: "You have already submitted a review" });
    }
    const name = req.user.name || req.user.email?.split("@")[0] || "Trader";
    await db.collection("reviews").doc(req.user.uid).set({
      userId: req.user.uid,
      name,
      rating,
      text,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.status(201).json({ message: "Review submitted" });
  } catch (e) {
    res.status(500).json({ error: "Could not submit review" });
  }
});

app.get("/api/competition/entry", requireAuth, async (req, res) => {
  try {
    initFirebase();
    const snap = await db.collection("competitionParticipants").doc(req.user.uid).get();
    if (!snap.exists) return res.json({ joined: false });
    const d = snap.data();
    res.json({ joined: true, competitionId: d.competitionId, name: d.name || "Trader" });
  } catch (e) {
    res.status(500).json({ error: "Could not load competition entry" });
  }
});

app.post("/api/competition/join", requireAuth, async (req, res) => {
  try {
    initFirebase();
    const ref = db.collection("competitionParticipants").doc(req.user.uid);
    const result = await db.runTransaction(async tx => {
      const existing = await tx.get(ref);
      if (existing.exists) {
        const d = existing.data();
        return { competitionId: d.competitionId, name: d.name || "Trader", existing: true };
      }
      const competitionId = "AF-" + new Date().getFullYear() + "-" + crypto.randomBytes(4).toString("hex").toUpperCase();
      const name = req.user.name || req.user.email?.split("@")[0] || "Trader";
      tx.set(ref, {
        userId: req.user.uid,
        competitionId,
        name,
        joinedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return { competitionId, name, existing: false };
    });
    res.status(result.existing ? 200 : 201).json({
      joined: true,
      competitionId: result.competitionId,
      name: result.name,
      message: result.existing ? "Already joined" : "Competition joined successfully"
    });
  } catch (e) {
    res.status(500).json({ error: "Could not join competition" });
  }
});

app.get("/api/support-settings", async (req, res) => {
  try {
    initFirebase();
    const snap = await db.collection("settings").doc("support").get();
    const d = snap.exists ? snap.data() : {};
    res.json({
      support: {
        email: d.email || "",
        telegram: d.telegram || "joker007lp",
        whatsapp: d.whatsapp || "7608094247"
      }
    });
  } catch (e) {
    res.status(500).json({ error: "Could not load support settings" });
  }
});

app.put("/api/support-settings", requireAuth, requireAdmin, async (req, res) => {
  try {
    initFirebase();
    const clean = v => String(v || "").trim().slice(0, 200);
    const email = clean(req.body.email);
    const telegram = clean(req.body.telegram);
    const whatsapp = clean(req.body.whatsapp);
    await db.collection("settings").doc("support").set({
      email, telegram, whatsapp,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: req.user.uid
    }, { merge: true });
    res.json({ message: "Support settings updated", support: { email, telegram, whatsapp } });
  } catch (e) {
    res.status(500).json({ error: "Could not update support settings" });
  }
});

const DEFAULT_CHALLENGES = [
  { id:"instant-1000", model:"Instant", size:"$1K", accountSize:1000, price:8, dailyDrawdown:"3%", evaluation:"None" },
  { id:"instant-2500", model:"Instant", size:"$2.5K", accountSize:2500, price:15, dailyDrawdown:"3%", evaluation:"None" },
  { id:"one-5000", model:"1 Step", size:"$5K", accountSize:5000, price:40, dailyDrawdown:"4%", totalDrawdown:"8%", profitTarget:"10%" },
  { id:"one-10000", model:"1 Step", size:"$10K", accountSize:10000, price:75, dailyDrawdown:"4%", totalDrawdown:"8%", profitTarget:"10%" },
  { id:"one-25000", model:"1 Step", size:"$25K", accountSize:25000, price:150, dailyDrawdown:"4%", totalDrawdown:"8%", profitTarget:"10%" },
  { id:"two-5000", model:"2 Step", size:"$5K", accountSize:5000, price:25, dailyDrawdown:"4%", totalDrawdown:"8%", phase1Profit:"8%", phase2Profit:"6%" },
  { id:"two-10000", model:"2 Step", size:"$10K", accountSize:10000, price:45, dailyDrawdown:"4%", totalDrawdown:"8%", phase1Profit:"8%", phase2Profit:"6%" },
  { id:"two-25000", model:"2 Step", size:"$25K", accountSize:25000, price:110, dailyDrawdown:"4%", totalDrawdown:"8%", phase1Profit:"8%", phase2Profit:"6%" },
  { id:"two-50000", model:"2 Step", size:"$50K", accountSize:50000, price:200, dailyDrawdown:"4%", totalDrawdown:"8%", phase1Profit:"8%", phase2Profit:"6%" },
  { id:"two-100000", model:"2 Step", size:"$100K", accountSize:100000, price:350, dailyDrawdown:"4%", totalDrawdown:"8%", phase1Profit:"8%", phase2Profit:"6%" }
];

async function getChallengeCatalog() {
  initFirebase();
  const snap = await db.collection("settings").doc("challengeCatalog").get();
  const saved = snap.exists && Array.isArray(snap.data()?.items) ? snap.data().items : null;
  return saved && saved.length ? saved : DEFAULT_CHALLENGES;
}

const DEFAULT_CHALLENGE_RULES = {
  "1 Step": ["Daily Drawdown: 4%", "Total Drawdown: 8%", "Profit Target: 10%"],
  "2 Step": ["Daily Drawdown: 4%", "Total Drawdown: 8%", "Phase 1 Profit Target: 8%", "Phase 2 Profit Target: 6%"],
  "Instant": ["Daily Drawdown: 3%"]
};

app.get("/api/challenge-rules", async (req,res) => {
  try {
    initFirebase();
    const snap = await db.collection("settings").doc("challengeRules").get();
    const saved = snap.exists && snap.data()?.rules && typeof snap.data().rules === "object" ? snap.data().rules : null;
    res.json({ rules: saved || DEFAULT_CHALLENGE_RULES });
  } catch(e) {
    res.status(500).json({ error:"Could not load challenge rules" });
  }
});

app.put("/api/challenge-rules", requireAuth, requireAdmin, async (req,res) => {
  try {
    initFirebase();
    const clean = v => String(v ?? "").trim().slice(0,300);
    const incoming = req.body?.rules || {};
    const rules = {};
    for (const model of ["1 Step","2 Step","Instant"]) {
      rules[model] = Array.isArray(incoming[model])
        ? incoming[model].map(clean).filter(Boolean).slice(0,20)
        : [];
    }
    await db.collection("settings").doc("challengeRules").set({
      rules,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: req.user.uid
    }, { merge:true });
    res.json({ rules });
  } catch(e) {
    res.status(500).json({ error:"Could not save challenge rules" });
  }
});

app.get("/api/challenges", async (req, res) => {
  try {
    const challenges = await getChallengeCatalog();
    res.json({ challenges });
  } catch (e) {
    res.status(500).json({ error: "Could not load challenge catalog" });
  }
});

app.put("/api/challenges", requireAuth, requireAdmin, async (req, res) => {
  try {
    initFirebase();
    if (!Array.isArray(req.body.challenges) || !req.body.challenges.length) {
      return res.status(400).json({ error: "Challenge catalog is required" });
    }
    const items = req.body.challenges.map(x => ({
      id: cleanId(x.id), model: String(x.model || "").trim(), size: String(x.size || "").trim(),
      accountSize: Number(x.accountSize), price: Number(x.price),
      ...(x.dailyDrawdown ? { dailyDrawdown:String(x.dailyDrawdown) } : {}),
      ...(x.totalDrawdown ? { totalDrawdown:String(x.totalDrawdown) } : {}),
      ...(x.profitTarget ? { profitTarget:String(x.profitTarget) } : {}),
      ...(x.phase1Profit ? { phase1Profit:String(x.phase1Profit) } : {}),
      ...(x.phase2Profit ? { phase2Profit:String(x.phase2Profit) } : {}),
      ...(x.evaluation ? { evaluation:String(x.evaluation) } : {})
    })).filter(x => x.id && x.model && x.size && Number.isFinite(x.accountSize) && x.accountSize > 0 && Number.isFinite(x.price) && x.price > 0);
    if (!items.length) return res.status(400).json({ error: "No valid challenge items" });
    await db.collection("settings").doc("challengeCatalog").set({
      items, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy:req.user.uid
    });
    res.json({ challenges:items });
  } catch (e) {
    res.status(500).json({ error:"Could not update challenge catalog" });
  }
});

app.post("/api/challenge-payments", requireAuth, upload.single("screenshot"), async (req, res) => {
  try {
    initFirebase();
    const challengeId = String(req.body.challengeId || "").trim();
    const transactionId = String(req.body.transactionId || "").trim();
    const method = String(req.body.method || "UPI").trim();
    const currency = String(req.body.currency || (method === "USDT" ? "USDT" : "INR")).trim().toUpperCase();
    const amount = positiveAmount(req.body.amount);
    if (!challengeId || !transactionId || amount === null) return res.status(400).json({ error:"challengeId, transactionId and valid amount are required" });
    if (!["INR","USDT"].includes(currency)) return res.status(400).json({ error:"Currency must be INR or USDT" });
    const catalog = await getChallengeCatalog();
    const challenge = catalog.find(x => x.id === challengeId);
    if (!challenge) return res.status(404).json({ error:"Challenge not found" });
    const expectedAmount = currency === "INR" ? Math.round(Number(challenge.price) * 98) : Number(challenge.price);
    if (Math.abs(expectedAmount - amount) > 0.01) return res.status(400).json({ error:"Payment amount does not match selected currency price" });

    const duplicate = await db.collection("payments").where("transactionId","==",transactionId).limit(1).get();
    if (!duplicate.empty) return res.status(409).json({ error:"This transaction/reference ID was already submitted" });

    let screenshotUrl="", screenshotPath="", screenshotToken="";
    if (req.file) {
      const safe=req.file.originalname.replace(/[^a-zA-Z0-9._-]/g,"_");
      screenshotPath="payment-proofs/"+req.user.uid+"/"+Date.now()+"-"+safe;
      if (bucket) {
        try {
          screenshotToken=crypto.randomUUID();
          const file=bucket.file(screenshotPath);
          await file.save(req.file.buffer,{metadata:{
            contentType:req.file.mimetype,
            metadata:{firebaseStorageDownloadTokens:screenshotToken}
          }});
          screenshotUrl="https://firebasestorage.googleapis.com/v0/b/"+encodeURIComponent(bucket.name)+"/o/"+encodeURIComponent(screenshotPath)+"?alt=media&token="+encodeURIComponent(screenshotToken);
        } catch (storageError) {
          console.warn("Payment screenshot Storage upload failed; using Firestore fallback:", storageError?.message || storageError);
          if (req.file.buffer.length > 500000) {
            return res.status(400).json({error:"Payment screenshot storage is unavailable. Please use a screenshot under 500 KB and try again."});
          }
          screenshotUrl="data:"+req.file.mimetype+";base64,"+req.file.buffer.toString("base64");
          screenshotPath="";
          screenshotToken="";
        }
      } else {
        if (req.file.buffer.length > 500000) {
          return res.status(400).json({error:"Payment screenshot storage is unavailable. Please use a screenshot under 500 KB and try again."});
        }
        screenshotUrl="data:"+req.file.mimetype+";base64,"+req.file.buffer.toString("base64");
      }
    }
    const ref=db.collection("payments").doc();
    await ref.set({
      userId:req.user.uid,userEmail:req.user.email||"",type:"challenge",
      challengeId,challengeModel:challenge.model,challengeSize:challenge.size,
      accountSize:Number(challenge.accountSize),courseId:"",courseTitle:"Aura Farming "+challenge.model+" "+challenge.size,
      method,currency,transactionId,amount,screenshotUrl,screenshotPath,status:"pending",
      submittedAt:admin.firestore.FieldValue.serverTimestamp(),reviewedAt:null,reviewedBy:null
    });
    res.status(201).json({id:ref.id,status:"pending",message:"Challenge payment submitted for verification"});
  } catch(e) {
    res.status(500).json({error:"Could not submit challenge payment",detail:e.message});
  }
});

app.get("/api/challenge-payments/my", requireAuth, async (req,res)=>{
  try {
    initFirebase();
    const snap=await db.collection("payments").where("userId","==",req.user.uid).get();
    const payments=snap.docs.map(d=>({id:d.id,...d.data()})).filter(p=>p.type==="challenge");
    res.json({payments});
  } catch(e){res.status(500).json({error:"Could not load challenge payments"});}
});

app.get("/api/payment-settings", requireAuth, async (req, res) => {
  try {
    initFirebase();
    const snap = await db.collection("settings").doc("payment").get();
    const d = snap.exists ? snap.data() : {};
    res.json({ settings: {
      googlePayUpi: d.googlePayUpi || "lipupoddar-3@okaxis",
      phonePeUpi: d.phonePeUpi || "nipukumar007@ibl",
      paytmUpi: d.paytmUpi || "nipukumar007@ibl",
      merchantName: d.merchantName || "Aura Farming",
      qrUpi: d.qrUpi || d.googlePayUpi || "lipupoddar-3@okaxis",
      qrImageUrl: d.qrImageUrl || "",
      usdtWallet: d.usdtWallet || ""
    }});
  } catch (e) {
    res.status(500).json({ error: "Could not load payment settings" });
  }
});

app.put("/api/payment-settings", requireAuth, requireAdmin, async (req, res) => {
  try {
    initFirebase();
    const clean = v => String(v || "").trim().slice(0, 200);
    const googlePayUpi = clean(req.body.googlePayUpi);
    const phonePeUpi = clean(req.body.phonePeUpi);
    const paytmUpi = clean(req.body.paytmUpi) || phonePeUpi;
    const merchantName = clean(req.body.merchantName) || "Aura Farming";
    const qrUpi = clean(req.body.qrUpi) || googlePayUpi;
    const usdtWallet = clean(req.body.usdtWallet);
    const qrImageUrl = clean(req.body.qrImageUrl);
    if (!googlePayUpi || !phonePeUpi || !paytmUpi || !qrUpi) {
      return res.status(400).json({ error: "Google Pay, PhonePe, Paytm and QR UPI IDs are required" });
    }
    await db.collection("settings").doc("payment").set({
      googlePayUpi, phonePeUpi, paytmUpi, merchantName, qrUpi, usdtWallet, qrImageUrl,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: req.user.uid
    }, { merge: true });
    res.json({ message: "Payment settings updated" });
  } catch (e) {
    res.status(500).json({ error: "Could not update payment settings", detail: e.message });
  }
});

app.post("/api/payment-settings/qr", requireAuth, requireAdmin, upload.single("qr"), async (req, res) => {
  try {
    initFirebase();
    if (!bucket) return res.status(500).json({ error: "Firebase Storage is not configured" });
    if (!req.file) return res.status(400).json({ error: "QR image is required" });
    if (!String(req.file.mimetype || "").startsWith("image/")) return res.status(400).json({ error: "Only image files are allowed" });
    if (req.file.size > 5 * 1024 * 1024) return res.status(400).json({ error: "QR image must be 5MB or smaller" });

    const path = "payment-settings/qr-" + Date.now() + "-" + req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    const file = bucket.file(path);
    const downloadToken = crypto.randomUUID();
    await file.save(req.file.buffer, {
      metadata: {
        contentType: req.file.mimetype,
        cacheControl: "public,max-age=3600",
        metadata: { firebaseStorageDownloadTokens: downloadToken }
      }
    });
    const qrImageUrl = "https://firebasestorage.googleapis.com/v0/b/" + encodeURIComponent(bucket.name) + "/o/" + encodeURIComponent(path) + "?alt=media&token=" + encodeURIComponent(downloadToken);
    await db.collection("settings").doc("payment").set({
      qrImageUrl,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: req.user.uid
    }, { merge: true });
    res.json({ message: "QR image updated", qrImageUrl });
  } catch (e) {
    res.status(500).json({ error: "Could not upload QR image", detail: e.message });
  }
});

app.get("/api/meeting", requireAuth, async (req, res) => {
  try {
    initFirebase();
    const snap = await db.collection("settings").doc("meeting").get();
    const d = snap.exists ? snap.data() : {};
    res.json({ meeting: {
      enabled: d.enabled === true,
      title: d.title || "Course Era Live Class",
      date: d.date || "",
      time: d.time || "",
      meetingId: d.meetingId || "",
      passcode: d.passcode || ""
    }});
  } catch (e) {
    res.status(500).json({ error: "Could not load meeting settings" });
  }
});

app.put("/api/meeting", requireAuth, requireAdmin, async (req, res) => {
  try {
    initFirebase();
    const clean = v => String(v || "").trim().slice(0, 500);
    const title = clean(req.body.title) || "Course Era Live Class";
    const date = clean(req.body.date);
    const time = clean(req.body.time);
    const meetingId = clean(req.body.meetingId);
    const passcode = clean(req.body.passcode);
    const enabled = req.body.enabled === true;

    if (enabled && !meetingId) {
      return res.status(400).json({ error: "Meeting code is required when meeting is enabled" });
    }

    await db.collection("settings").doc("meeting").set({
      enabled, title, date, time, meetingId, passcode,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: req.user.uid
    }, { merge: true });

    res.json({ message: "Live meeting settings updated" });
  } catch (e) {
    res.status(500).json({ error: "Could not update meeting settings", detail: e.message });
  }
});

app.get("/api/courses", requireAuth, async (req, res) => {
  try {
    initFirebase();
    let snap = await db.collection("courses")
      .where("published", "==", true)
      .get();



    const courses = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ courses });
  } catch (e) {
    res.status(500).json({ error: "Could not load courses", detail: e.message });
  }
});

app.post("/api/courses", requireAuth, requireAdmin, async (req, res) => {
  try {
    initFirebase();

    const {
      title,
      description = "",
      price = 0,
      thumbnail = "",
      videoUrl = "",
      published = true
    } = req.body;

    if (!String(title || "").trim()) {
      return res.status(400).json({ error: "Course title is required" });
    }

    const id = cleanId(req.body.id || title);
    if (!id) return res.status(400).json({ error: "Invalid course id" });

    const amount = positiveAmount(price);
    if (amount === null) {
      return res.status(400).json({ error: "Price must be greater than 0" });
    }

    await db.collection("courses").doc(id).set({
      title: String(title).trim(),
      description: String(description || "").trim(),
      price: amount,
      thumbnail: String(thumbnail || "").trim(),
      videoUrl: String(videoUrl || "").trim(),
      published: Boolean(published),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.status(201).json({ id, message: "Course created" });
  } catch (e) {
    res.status(500).json({ error: "Could not create course", detail: e.message });
  }
});

app.put("/api/courses/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    initFirebase();

    const updates = { ...req.body };
    delete updates.id;
    delete updates.createdAt;

    if (updates.price !== undefined) {
      const amount = positiveAmount(updates.price);
      if (amount === null) {
        return res.status(400).json({ error: "Price must be greater than 0" });
      }
      updates.price = amount;
    }

    if (updates.title !== undefined) {
      updates.title = String(updates.title).trim();
      if (!updates.title) return res.status(400).json({ error: "Course title is required" });
    }

    updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    await db.collection("courses").doc(req.params.id).set(updates, { merge: true });
    res.json({ message: "Course updated" });
  } catch (e) {
    res.status(500).json({ error: "Could not update course", detail: e.message });
  }
});

app.delete("/api/courses/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    initFirebase();
    await db.collection("courses").doc(req.params.id).delete();
    res.json({ message: "Course deleted" });
  } catch (e) {
    res.status(500).json({ error: "Could not delete course", detail: e.message });
  }
});

app.post("/api/payments", requireAuth, upload.single("screenshot"), async (req, res) => {
  try {
    initFirebase();

    const {
      courseId,
      method = "UPI",
      transactionId
    } = req.body;

    const amount = positiveAmount(req.body.amount);

    if (!courseId || !transactionId || amount === null) {
      return res.status(400).json({
        error: "courseId, transactionId and a valid amount are required"
      });
    }

    const course = await db.collection("courses").doc(courseId).get();
    if (!course.exists) return res.status(404).json({ error: "Course not found" });

    const courseData = course.data();
    if (courseData.published !== true) {
      return res.status(400).json({ error: "Course is not available for purchase" });
    }

    if (Math.abs(Number(courseData.price || 0) - amount) > 0.01) {
      return res.status(400).json({ error: "Payment amount does not match the course price" });
    }

    const normalizedTransactionId = String(transactionId).trim();

    const duplicate = await db.collection("payments")
      .where("transactionId", "==", normalizedTransactionId)
      .limit(1)
      .get();

    if (!duplicate.empty) {
      return res.status(409).json({ error: "This transaction/reference ID was already submitted" });
    }

    let screenshotUrl = "";
    let screenshotPath = "";

    if (req.file && bucket) {
      const safe = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      screenshotPath = "payment-proofs/" + req.user.uid + "/" + Date.now() + "-" + safe;
      const file = bucket.file(screenshotPath);

      await file.save(req.file.buffer, {
        metadata: { contentType: req.file.mimetype }
      });

      const [signedUrl] = await file.getSignedUrl({
        action: "read",
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000
      });
      screenshotUrl = signedUrl;
    }

    const ref = db.collection("payments").doc();

    await ref.set({
      userId: req.user.uid,
      userEmail: req.user.email || "",
      courseId,
      courseTitle: courseData.title || "",
      method: String(method),
      transactionId: normalizedTransactionId,
      amount,
      screenshotUrl,
      screenshotPath,
      status: "pending",
      submittedAt: admin.firestore.FieldValue.serverTimestamp(),
      reviewedAt: null,
      reviewedBy: null
    });

    res.status(201).json({
      id: ref.id,
      status: "pending",
      message: "Payment submitted for verification"
    });
  } catch (e) {
    res.status(500).json({ error: "Could not submit payment", detail: e.message });
  }
});

app.get("/api/payments/my", requireAuth, async (req, res) => {
  try {
    initFirebase();

    const snap = await db.collection("payments")
      .where("userId", "==", req.user.uid)
      .get();

    const payments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ payments });
  } catch (e) {
    res.status(500).json({ error: "Could not load payments", detail: e.message });
  }
});

app.get("/api/admin/courses", requireAuth, requireAdmin, async (req, res) => {
  try {
    initFirebase();
    const snap = await db.collection("courses").get();
    const courses = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ courses });
  } catch (e) {
    res.status(500).json({ error: "Could not load admin courses", detail: e.message });
  }
});

app.get("/api/admin/stats", requireAuth, requireAdmin, async (req, res) => {
  try {
    initFirebase();
    const [coursesSnap, paymentsSnap, authPage] = await Promise.all([
      db.collection("courses").get(),
      db.collection("payments").get(),
      admin.auth().listUsers(1000)
    ]);
    const payments = paymentsSnap.docs.map(d => d.data());
    res.json({
      courses: coursesSnap.size,
      publishedCourses: coursesSnap.docs.filter(d => d.data().published === true).length,
      users: authPage.users.length,
      payments: paymentsSnap.size,
      pendingPayments: payments.filter(p => p.status === "pending").length,
      approvedPayments: payments.filter(p => p.status === "approved").length,
      rejectedPayments: payments.filter(p => p.status === "rejected").length,
      approvedRevenue: payments.filter(p => p.status === "approved").reduce((sum,p)=>sum+Number(p.amount||0),0)
    });
  } catch (e) {
    res.status(500).json({ error: "Could not load admin stats", detail: e.message });
  }
});

app.get("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    initFirebase();
    const users = [];
    let nextPageToken;
    do {
      const page = await admin.auth().listUsers(1000, nextPageToken);
      page.users.forEach(u => users.push({
        uid: u.uid,
        email: u.email || "",
        name: u.displayName || "",
        disabled: Boolean(u.disabled),
        createdAt: u.metadata?.creationTime || null,
        lastSignInAt: u.metadata?.lastSignInTime || null
      }));
      nextPageToken = page.pageToken;
    } while (nextPageToken);
    res.json({ users });
  } catch (e) {
    res.status(500).json({ error: "Could not load users", detail: e.message });
  }
});

app.patch("/api/admin/users/:uid", requireAuth, requireAdmin, async (req, res) => {
  try {
    initFirebase();
    if (req.params.uid === req.user.uid) return res.status(400).json({ error: "You cannot disable your own admin account" });
    if (typeof req.body.disabled !== "boolean") return res.status(400).json({ error: "disabled must be true or false" });
    const u = await admin.auth().updateUser(req.params.uid, { disabled: req.body.disabled });
    res.json({ message: req.body.disabled ? "User disabled" : "User enabled", disabled: u.disabled });
  } catch (e) {
    res.status(500).json({ error: "Could not update user", detail: e.message });
  }
});

app.get("/api/admin/users/:uid/courses", requireAuth, requireAdmin, async (req, res) => {
  try {
    initFirebase();
    const snap = await db.collection("users").doc(req.params.uid).collection("courses").get();
    const courses = [];
    for (const d of snap.docs) {
      const c = await db.collection("courses").doc(d.id).get();
      if (c.exists) courses.push({ id: c.id, ...c.data(), grantedAt: d.data().grantedAt || null });
    }
    res.json({ courses });
  } catch (e) {
    res.status(500).json({ error: "Could not load user courses", detail: e.message });
  }
});

app.delete("/api/admin/users/:uid/courses/:courseId", requireAuth, requireAdmin, async (req, res) => {
  try {
    initFirebase();
    await db.collection("users").doc(req.params.uid).collection("courses").doc(req.params.courseId).delete();
    res.json({ message: "Course access revoked" });
  } catch (e) {
    res.status(500).json({ error: "Could not revoke course access", detail: e.message });
  }
});

app.get("/api/admin/payments", requireAuth, requireAdmin, async (req, res) => {
  try {
    initFirebase();

    const snap = await db.collection("payments").orderBy("submittedAt", "desc").get();
    const payments = [];
    for (const d of snap.docs) {
      const p = { id: d.id, ...d.data() };
      if (p.screenshotPath && bucket) {
        try {
          const [url] = await bucket.file(p.screenshotPath).getSignedUrl({
            action: "read",
            expires: Date.now() + 60 * 60 * 1000
          });
          p.screenshotUrl = url;
        } catch {}
      }
      payments.push(p);
    }
    res.json({ payments });
  } catch (e) {
    res.status(500).json({ error: "Could not load payment queue", detail: e.message });
  }
});

app.patch("/api/admin/payments/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    initFirebase();

    const status = req.body.status;
    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({ error: "Status must be approved or rejected" });
    }

    const ref = db.collection("payments").doc(req.params.id);
    const snap = await ref.get();

    if (!snap.exists) return res.status(404).json({ error: "Payment not found" });

    const payment = snap.data();

    if (payment.status === status) {
      return res.json({ message: "Payment already " + status });
    }
    if (payment.status !== "pending") {
      return res.status(409).json({ error: "Only pending payments can be reviewed" });
    }

    if (status === "approved") {
      if (payment.type === "challenge") {
        const catalog = await getChallengeCatalog();
        const challenge = catalog.find(x => x.id === payment.challengeId);
        if (!challenge) return res.status(400).json({ error: "Challenge is no longer available" });
      } else {
        const course = await db.collection("courses").doc(payment.courseId).get();
        if (!course.exists || course.data().published !== true) return res.status(400).json({ error: "Course is no longer available" });
      }
    }

    await ref.update({
      status,
      reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
      reviewedBy: req.user.uid
    });

    if (status === "approved" && payment.type === "challenge") {
      const accountRef = db.collection("users").doc(payment.userId).collection("trading").doc("account");
      const catalog = await getChallengeCatalog();
      const challenge = catalog.find(x => x.id === payment.challengeId);
      const accountId = "AF-ACC-" + new Date().getFullYear() + "-" + crypto.randomBytes(4).toString("hex").toUpperCase();
      await accountRef.set({
        accountId, startingBalance:Number(challenge.accountSize), balance:Number(challenge.accountSize),
        equity:Number(challenge.accountSize), pnl:0, currency:"USD",
        challenge:challenge.model+" "+challenge.size, challengeId:challenge.id,
        sourcePaymentId:req.params.id, status:"active",
        createdAt:admin.firestore.FieldValue.serverTimestamp(), updatedAt:admin.firestore.FieldValue.serverTimestamp()
      });
      const credentialBundle = await createTerminalCredentials(accountRef, payment.userId, {
        accountId, status:"active"
      });
      await db.collection("users").doc(payment.userId).collection("challengeAccounts").doc(accountId).set({
        accountId, paymentId:req.params.id, challengeId:challenge.id, model:challenge.model, size:challenge.size,
        accountSize:Number(challenge.accountSize), status:"active",
        terminalCredentialId:credentialBundle.id,
        createdAt:admin.firestore.FieldValue.serverTimestamp()
      });
      await ref.update({
        accountId,
        terminalCredentialId:credentialBundle.id,
        ...(credentialBundle.credentials ? {
          terminalLoginId:credentialBundle.credentials.loginId
        } : {})
      });
      if (credentialBundle.credentials) {
        await ref.update({
          terminalCredentialsIssued: true
        });
      }
    } else if (status === "approved") {
      await db.collection("users").doc(payment.userId).collection("courses").doc(payment.courseId).set({
        courseId: payment.courseId, paymentId: req.params.id, grantedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }

    res.json({ message: "Payment " + status });
  } catch (e) {
    res.status(500).json({ error: "Could not review payment", detail: e.message });
  }
});

app.post("/api/admin/trading-accounts/:uid/breach", requireAuth, requireAdmin, async (req,res) => {
  try {
    initFirebase();
    const accountRef = db.collection("users").doc(req.params.uid).collection("trading").doc("account");
    const snap = await accountRef.get();
    if (!snap.exists) return res.status(404).json({ error:"Trading account not found" });
    const reason = String(req.body.reason || "Account breached by admin").trim().slice(0,200);
    await accountRef.update({
      status:"breached",
      breachReason:reason,
      updatedAt:admin.firestore.FieldValue.serverTimestamp()
    });
    await revokeTerminalCredentials(snap.data() || {}, reason);
    res.json({ message:"Trading account breached and terminal credentials revoked" });
  } catch(e) {
    res.status(500).json({ error:"Could not breach trading account", detail:e.message });
  }
});

app.get("/api/trading-account", requireAuth, async (req, res) => {
  try {
    initFirebase();

    const accountRef = db.collection("users").doc(req.user.uid).collection("trading").doc("account");
    const existing = await accountRef.get();

    if (existing.exists) {
      const account = existing.data() || {};
      const normalize = {};
      if (!account.accountId) normalize.accountId = "AF-ACC-" + new Date().getFullYear() + "-" + crypto.randomBytes(4).toString("hex").toUpperCase();
      if (!account.status) normalize.status = "active";
      if (account.openPnl == null) normalize.openPnl = 0;
      if (Object.keys(normalize).length) {
        await accountRef.set({ ...normalize, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        Object.assign(account, normalize);
      }
      return res.json({
        account: {
          id: account.accountId || "account",
          startingBalance: Number(account.startingBalance || 0),
          balance: Number(account.balance ?? account.startingBalance ?? 0),
          equity: Number(account.equity ?? account.balance ?? account.startingBalance ?? 0),
          pnl: Number(account.pnl ?? ((account.balance ?? 0) - (account.startingBalance ?? 0))),
          currency: account.currency || "USD",
          challenge: account.challenge || "Funded Account",
          challengeId: account.challengeId || "",
          sourcePaymentId: account.sourcePaymentId || "",
          status: account.status || "active",
          dailyDrawdownPct: Number(account.dailyDrawdownPct || 0),
          maxDrawdownPct: Number(account.maxDrawdownPct || 0),
          dailyDrawdownLimit: accountRules(account).dailyDrawdownPct,
          maxDrawdownLimit: accountRules(account).maxDrawdownPct
        }
      });
    }

    const approved = await db.collection("payments")
      .where("userId", "==", req.user.uid)
      .where("status", "==", "approved")
      .get();

    if (approved.empty) {
      return res.status(404).json({ error: "No approved funded account found" });
    }

    const payment = approved.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => {
        const at = a.reviewedAt?.toMillis?.() || 0;
        const bt = b.reviewedAt?.toMillis?.() || 0;
        return bt - at;
      })[0];

    const courseSnap = await db.collection("courses").doc(payment.courseId).get();
    const course = courseSnap.exists ? courseSnap.data() : {};

    const startingBalance = Number(
      course.accountSize ??
      course.startingBalance ??
      course.fundedBalance ??
      10000
    );

    if (!Number.isFinite(startingBalance) || startingBalance <= 0) {
      return res.status(500).json({ error: "Funded account size is not configured" });
    }

    const account = {
      accountId: "AF-ACC-" + new Date().getFullYear() + "-" + crypto.randomBytes(4).toString("hex").toUpperCase(),
      startingBalance,
      balance: startingBalance,
      equity: startingBalance,
      pnl: 0,
      openPnl: 0,
      currency: "USD",
      challenge: course.title || "Funded Account",
      sourcePaymentId: payment.id,
      status: "active",
      dailyDrawdownPct: 0,
      maxDrawdownPct: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await accountRef.create(account);

    res.json({
      account: {
        id: account.accountId || "account",
        startingBalance,
        balance: startingBalance,
        equity: startingBalance,
        pnl: 0,
        currency: "USD",
        challenge: account.challenge,
        sourcePaymentId: payment.id
      }
    });
  } catch (e) {
    if (e?.code === 6 || e?.code === "already-exists") {
      const snap = await db.collection("users").doc(req.user.uid).collection("trading").doc("account").get();
      const account = snap.data() || {};
      return res.json({
        account: {
          id: account.accountId || "account",
          startingBalance: Number(account.startingBalance || 0),
          balance: Number(account.balance ?? account.startingBalance ?? 0),
          equity: Number(account.equity ?? account.balance ?? account.startingBalance ?? 0),
          pnl: Number(account.pnl ?? 0),
          currency: account.currency || "USD",
          challenge: account.challenge || "Funded Account",
          sourcePaymentId: account.sourcePaymentId || "",
          status: account.status || "active",
          dailyDrawdownPct: Number(account.dailyDrawdownPct || 0),
          maxDrawdownPct: Number(account.maxDrawdownPct || 0),
          dailyDrawdownLimit: accountRules(account).dailyDrawdownPct,
          maxDrawdownLimit: accountRules(account).maxDrawdownPct
        }
      });
    }
    res.status(500).json({ error: "Could not load trading account", detail: e.message });
  }
});

app.post("/api/trading-account/adjust", requireAuth, async (req, res) => {
  try {
    initFirebase();

    const delta = Number(req.body.delta);
    if (!Number.isFinite(delta) || Math.abs(delta) > 1000000) {
      return res.status(400).json({ error: "Invalid simulated P&L adjustment" });
    }

    const accountRef = db.collection("users").doc(req.user.uid).collection("trading").doc("account");

    await db.runTransaction(async tx => {
      const snap = await tx.get(accountRef);
      if (!snap.exists) throw new Error("Trading account not found");
      const a = snap.data() || {};
      const startingBalance = Number(a.startingBalance || 0);
      const balance = Number(a.balance ?? startingBalance) + delta;
      const pnl = balance - startingBalance;
      tx.update(accountRef, {
        balance,
        equity: balance,
        pnl,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    const snap = await accountRef.get();
    const a = snap.data() || {};
    res.json({
      account: {
        id: a.accountId || "account",
        startingBalance: Number(a.startingBalance || 0),
        balance: Number(a.balance ?? 0),
        equity: Number(a.equity ?? a.balance ?? 0),
        pnl: Number(a.pnl ?? 0),
        currency: a.currency || "USD",
        challenge: a.challenge || "Funded Account"
      }
    });
  } catch (e) {
    res.status(500).json({ error: "Could not update trading account", detail: e.message });
  }
});



const MARKET_SYMBOLS = {
  "OANDA:XAUUSD": { yahoo:"XAUUSD=X", name:"GOLD", kind:"gold", contractSize:100 },
  "FX:EURUSD": { yahoo:"EURUSD=X", name:"EUR/USD", kind:"forex", contractSize:100000 },
  "FX:GBPUSD": { yahoo:"GBPUSD=X", name:"GBP/USD", kind:"forex", contractSize:100000 },
  "FX:USDJPY": { yahoo:"JPY=X", name:"USD/JPY", kind:"forex-jpy", contractSize:100000 },
  "FX:AUDUSD": { yahoo:"AUDUSD=X", name:"AUD/USD", kind:"forex", contractSize:100000 },
  "BINANCE:BTCUSDT": { yahoo:"BTC-USD", name:"BTC/USD", kind:"crypto", contractSize:1 },
  "BINANCE:ETHUSDT": { yahoo:"ETH-USD", name:"ETH/USD", kind:"crypto", contractSize:1 },
  "BINANCE:SOLUSDT": { yahoo:"SOL-USD", name:"SOL/USD", kind:"crypto", contractSize:1 },
  "BINANCE:XRPUSDT": { yahoo:"XRP-USD", name:"XRP/USD", kind:"crypto", contractSize:1 },
  "INDEX:NAS100": { yahoo:"^NDX", name:"NAS100", kind:"index", contractSize:1 },
  "INDEX:DEX40": { yahoo:"^GDAXI", name:"DEX40", kind:"index", contractSize:1 },
  "INDEX:US30": { yahoo:"^DJI", name:"US30", kind:"index", contractSize:1 },
  "OIL:USOIL": { yahoo:"CL=F", name:"US OIL", kind:"oil", contractSize:1 },
  "NASDAQ:AAPL": { yahoo:"AAPL", name:"APPLE", kind:"stock", contractSize:1 },
  "NASDAQ:NVDA": { yahoo:"NVDA", name:"NVIDIA", kind:"stock", contractSize:1 }
};
const quoteCache = new Map();

function biquoteSymbol(symbol){
  if(symbol==="OANDA:XAUUSD") return "XAUUSD";
  if(symbol.startsWith("FX:")) return symbol.slice(3).replace(/USDJPY$/,"USDJPY");
  if(symbol.startsWith("BINANCE:")) return symbol.slice(8).replace("USDT","USD");
  return symbol;
}

async function fetchBiQuote(symbol){
  const code=biquoteSymbol(symbol);
  const response=await fetch("https://biquote.io/api/"+encodeURIComponent(code),{headers:{"Accept":"application/json","User-Agent":"AuraFarming/1.0"}});
  if(!response.ok) throw new Error("Market feed returned "+response.status);
  const data=await response.json();
  const bid=Number(data.bid), ask=Number(data.ask), mid=Number(data.mid);
  const price=Number.isFinite(mid)&&mid>0?mid:(Number.isFinite(ask)&&ask>0?ask:bid);
  if(!Number.isFinite(price)||price<=0) throw new Error("Market price unavailable for "+code);
  return {
    price,
    bid:Number.isFinite(bid)&&bid>0?bid:price,
    ask:Number.isFinite(ask)&&ask>0?ask:price,
    previousClose:Number(data.previousClose||price),
    change:Number(data.changeAmount||0),
    changePct:Number(data.dayDiffPercent||0),
    timestamp:Date.parse(data.timestamp)||Math.floor(Date.now()/1000)
  };
}

async function getMarketQuotes(symbols) {
  const requested=[...new Set((Array.isArray(symbols)?symbols:Object.keys(MARKET_SYMBOLS)).filter(s=>MARKET_SYMBOLS[s]))];
  const now=Date.now(), out={}, freshForMs=200;
  await Promise.all(requested.map(async symbol=>{
    const spec=MARKET_SYMBOLS[symbol], cached=quoteCache.get(symbol);
    if(cached&&now-cached.fetchedAt<freshForMs){out[symbol]={symbol,name:spec.name,...cached,stale:false,cached:true};return;}
    try{
      const q=await fetchBiQuote(symbol);
      quoteCache.set(symbol,{...q,fetchedAt:now});
      out[symbol]={symbol,name:spec.name,...q,stale:false};
    }catch(e){
      const old=quoteCache.get(symbol);
      out[symbol]=old?{symbol,name:spec.name,...old,stale:true}:{symbol,name:spec.name,price:null,stale:true,error:"Market data unavailable"};
    }
  }));
  return out;
}

function parsePercent(value, fallback) {
  const n = Number.parseFloat(String(value || "").replace("%",""));
  return Number.isFinite(n) ? n : fallback;
}

function tradePnl(position, price) {
  const p = Number(position.entryPrice || 0);
  const q = Number(price || 0);
  const lot = Number(position.lot || 0);
  const spec = MARKET_SYMBOLS[position.symbol];
  if (!spec || !p || !q || !lot) return 0;
  let pnl = (position.side === "BUY" ? q - p : p - q) * lot * spec.contractSize;
  if (spec.kind === "forex-jpy") pnl = pnl / q;
  return Number.isFinite(pnl) ? pnl : 0;
}

async function loadTradingAccount(uid) {
  initFirebase();
  const ref = db.collection("users").doc(uid).collection("trading").doc("account");
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Trading account not found");
  return { ref, data:snap.data() || {} };
}

function accountRules(account) {
  return {
    dailyDrawdownPct: parsePercent(account.dailyDrawdown, 4),
    maxDrawdownPct: parsePercent(account.maxDrawdown, 8)
  };
}

async function refreshTradingAccount(uid, quotes) {
  const { ref, data } = await loadTradingAccount(uid);
  const positionSnap = await ref.collection("positions").where("status","==","open").get();
  const missingSymbols=[...new Set(positionSnap.docs.map(d=>d.data()?.symbol).filter(s=>s && !quotes?.[s]))];
  if(missingSymbols.length){
    const extra=await getMarketQuotes(missingSymbols);
    quotes={...(quotes||{}),...extra};
  }
  let balance = Number(data.balance ?? data.startingBalance ?? 0);
  let openPnl = 0;
  let realizedFromStops = 0;
  const positions = [];
  for (const d of positionSnap.docs) {
    const p = { id:d.id, ...d.data() };
    const q = Number(quotes[p.symbol]?.price || 0);
    let exitPrice = null;
    let closeReason = "";
    if (q && p.stopLoss != null) {
      if (p.side === "BUY" && q <= Number(p.stopLoss)) { exitPrice=Number(p.stopLoss); closeReason="Stop Loss"; }
      if (p.side === "SELL" && q >= Number(p.stopLoss)) { exitPrice=Number(p.stopLoss); closeReason="Stop Loss"; }
    }
    if (q && !exitPrice && p.takeProfit != null) {
      if (p.side === "BUY" && q >= Number(p.takeProfit)) { exitPrice=Number(p.takeProfit); closeReason="Take Profit"; }
      if (p.side === "SELL" && q <= Number(p.takeProfit)) { exitPrice=Number(p.takeProfit); closeReason="Take Profit"; }
    }
    if (exitPrice !== null) {
      const pnl = tradePnl(p, exitPrice);
      balance += pnl;
      realizedFromStops += pnl;
      await ref.collection("positions").doc(p.id).update({
        status:"closed", closePrice:exitPrice, realizedPnl:pnl, closeReason,
        closedAt:admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:admin.firestore.FieldValue.serverTimestamp()
      });
      continue;
    }
    const pnl = q ? tradePnl(p, q) : 0;
    openPnl += pnl;
    positions.push({ ...p, currentPrice:q || p.entryPrice, pnl });
  }
  const equity = balance + openPnl;
  const starting = Number(data.startingBalance || balance);
  const peak = Math.max(Number(data.peakEquity || starting), equity);
  const todayKey = new Date().toISOString().slice(0,10);
  const dayChanged = data.dailyResetDate !== todayKey;
  const dailyStart = dayChanged ? equity : Number(data.dailyStartEquity || starting);
  const dailyDd = dailyStart > 0 ? Math.max(0, (dailyStart-equity)/dailyStart*100) : 0;
  const maxDd = peak > 0 ? Math.max(0, (peak-equity)/peak*100) : 0;
  const rules = accountRules(data);
  let status = data.status || "active";
  let breach = data.breachReason || "";
  if (status === "active" && (dailyDd >= rules.dailyDrawdownPct || maxDd >= rules.maxDrawdownPct)) {
    status = "breached";
    breach = dailyDd >= rules.dailyDrawdownPct ? "Daily drawdown limit reached" : "Maximum drawdown limit reached";
  }
  if (status === "breached" && data.status !== "breached") {
    await revokeTerminalCredentials({ ...data, terminalCredentialId:data.terminalCredentialId }, breach || "Account breached");
  }
  await ref.update({
    balance, equity, pnl:balance-starting, openPnl, peakEquity:peak,
    dailyStartEquity:dailyStart, dailyResetDate:todayKey, dailyDrawdownPct:dailyDd, maxDrawdownPct:maxDd,
    status, breachReason:breach,
    updatedAt:admin.firestore.FieldValue.serverTimestamp()
  });
  return { ...data, balance, equity, pnl:balance-starting, openPnl, peakEquity:peak,
    dailyStartEquity:dailyStart, dailyDrawdownPct:dailyDd, maxDrawdownPct:maxDd,
    status, breachReason:breach, positions, realizedFromStops };
}

async function fetchMarketCandles(symbol, interval="15m"){
  const allowed=new Set(["1m","5m","15m","30m","60m","1h","4h","1d"]);
  const safe=allowed.has(interval)?interval:"15m";
  const code=biquoteSymbol(symbol);
  const response=await fetch("https://biquote.io/api/"+encodeURIComponent(code)+"/ohlc?interval="+encodeURIComponent(safe==="60m"?"1h":safe)+"&limit=500",{headers:{"Accept":"application/json","User-Agent":"AuraFarming/1.0"}});
  if(!response.ok) throw new Error("Candle feed returned "+response.status);
  const data=await response.json();
  const candles=(data.bars||[]).map(x=>({
    time:Math.floor(Date.parse(x.openTime)/1000),
    open:Number(x.open),
    high:Number(x.high),
    low:Number(x.low),
    close:Number(x.close),
    volume:Number(x.volume||x.tickVolume||0),
    isOpen:x.isOpen===true
  })).filter(x=>Number.isFinite(x.time)&&[x.open,x.high,x.low,x.close].every(Number.isFinite))
    .sort((x,y)=>x.time-y.time);
  if(!candles.length) throw new Error("No candle data available");
  return candles;
}

app.get("/api/market/candles", requireTerminalAuth, async (req,res) => {
  try {
    const symbol=String(req.query.symbol||"").trim();
    const interval=String(req.query.interval||"15m").trim();
    const spec=MARKET_SYMBOLS[symbol];
    if(!spec) return res.status(400).json({error:"Unsupported trading symbol"});
    const candles=await fetchMarketCandles(symbol,interval);
    const quotes=await getMarketQuotes([symbol]);
    res.json({symbol,interval,candles,quote:quotes[symbol]||null});
  } catch(e) {
    res.status(502).json({error:"Market candle data unavailable"});
  }
});

app.get("/api/market/quotes", requireTerminalAuth, async (req,res) => {
  try {
    const symbols = String(req.query.symbols || "").split(",").map(x=>x.trim()).filter(Boolean);
    res.json({ quotes: await getMarketQuotes(symbols) });
  } catch (e) {
    res.status(502).json({ error:"Market data unavailable", detail:e.message });
  }
});

app.get("/api/trading/positions", requireTerminalAuth, async (req,res) => {
  try {
    const {ref,data}=await loadTradingAccount(req.terminal.uid);
    const baseAccount={
      id:data.accountId || "account",
      balance:Number(data.balance ?? data.startingBalance ?? 0),
      equity:Number(data.equity ?? data.balance ?? data.startingBalance ?? 0),
      pnl:Number(data.pnl ?? 0),
      openPnl:Number(data.openPnl ?? 0),
      status:data.status || "active",
      dailyDrawdownPct:Number(data.dailyDrawdownPct || 0),
      maxDrawdownPct:Number(data.maxDrawdownPct || 0)
    };
    const openSnap=await ref.collection("positions").where("status","==","open").get();
    const symbols=[...new Set(openSnap.docs.map(d=>d.data()?.symbol).filter(Boolean))];
    let account=baseAccount;
    let positions=[];
    try {
      const quotes=await getMarketQuotes(symbols);
      const refreshed=await refreshTradingAccount(req.user.uid,quotes);
      account={id:refreshed.accountId || data.accountId || "account",balance:refreshed.balance,equity:refreshed.equity,pnl:refreshed.pnl,openPnl:refreshed.openPnl,status:refreshed.status,dailyDrawdownPct:refreshed.dailyDrawdownPct||0,maxDrawdownPct:refreshed.maxDrawdownPct||0};
      positions=refreshed.positions.map(p=>({id:p.id,symbol:p.symbol,name:MARKET_SYMBOLS[p.symbol]?.name||p.symbol,side:p.side,lot:p.lot,entryPrice:p.entryPrice,currentPrice:p.currentPrice,pnl:p.pnl,stopLoss:p.stopLoss||null,takeProfit:p.takeProfit||null,openedAt:p.openedAt||null}));
    } catch (refreshError) {
      positions=openSnap.docs.map(d=>({id:d.id,...d.data(),name:MARKET_SYMBOLS[d.data()?.symbol]?.name||d.data()?.symbol}));
    }
    res.json({
      account:{
        ...account,
        dailyDrawdownLimit:accountRules(data).dailyDrawdownPct,
        maxDrawdownLimit:accountRules(data).maxDrawdownPct
      },
      positions
    });
  } catch (e) {
    res.status(500).json({error:"Could not load trading positions",detail:e.message});
  }
});

app.post("/api/trading/orders", requireTerminalAuth, async (req,res) => {
  try {
    const symbol=String(req.body.symbol||"").trim();
    const side=String(req.body.side||"").toUpperCase();
    const lot=Number(req.body.lot);
    const stopLoss=req.body.stopLoss===null||req.body.stopLoss===""?null:Number(req.body.stopLoss);
    const takeProfit=req.body.takeProfit===null||req.body.takeProfit===""?null:Number(req.body.takeProfit);
    if (!MARKET_SYMBOLS[symbol]) return res.status(400).json({error:"Unsupported trading symbol"});
    if (!["BUY","SELL"].includes(side)) return res.status(400).json({error:"Side must be BUY or SELL"});
    if (!Number.isFinite(lot) || lot<=0 || lot>10000) return res.status(400).json({error:"Invalid lot size"});
    if (stopLoss!==null && (!Number.isFinite(stopLoss)||stopLoss<=0)) return res.status(400).json({error:"Invalid stop loss"});
    if (takeProfit!==null && (!Number.isFinite(takeProfit)||takeProfit<=0)) return res.status(400).json({error:"Invalid take profit"});
    const quotes=await getMarketQuotes([symbol]);
    const quote=quotes[symbol];
    if (!quote?.price) return res.status(502).json({error:"No live market price available"});
    const entryPrice=side==="BUY"?Number(quote.ask||quote.price):Number(quote.bid||quote.price);
    if (side==="BUY" && ((stopLoss!==null&&stopLoss>=entryPrice) || (takeProfit!==null&&takeProfit<=entryPrice))) return res.status(400).json({error:"BUY SL must be below entry and TP above entry"});
    if (side==="SELL" && ((stopLoss!==null&&stopLoss<=entryPrice) || (takeProfit!==null&&takeProfit>=entryPrice))) return res.status(400).json({error:"SELL SL must be above entry and TP below entry"});
    const {ref,data}=await loadTradingAccount(req.terminal.uid);
    if ((data.status||"active")!=="active") return res.status(403).json({error:"Trading account is not active",status:data.status||"inactive"});
    if (req.terminal?.terminalRole !== "trader") return res.status(403).json({error:"Investor password is read-only. Use the trading password to place orders."});
    const positionRef=ref.collection("positions").doc();
    const now=admin.firestore.FieldValue.serverTimestamp();
    await positionRef.set({
      symbol, side, lot:Number(lot.toFixed(4)), entryPrice,
      stopLoss:stopLoss===null?null:Number(stopLoss), takeProfit:takeProfit===null?null:Number(takeProfit),
      status:"open", openedAt:now, updatedAt:now
    });
    // Fast execution path: return immediately after the position is persisted.
    // Full equity/risk reconciliation continues in the background so the terminal does not
    // wait on another Firestore read/query before confirming the simulated fill.
    const lotValue=Number(lot.toFixed(4));
    const newOpenPnl=tradePnl({symbol,side,lot:lotValue,entryPrice},quote.price);
    const fastBalance=Number(data.balance ?? data.startingBalance ?? 0);
    const fastOpenPnl=Number(data.openPnl || 0)+newOpenPnl;
    const fastAccount={
      id:data.accountId || "account",
      balance:fastBalance,
      equity:fastBalance+fastOpenPnl,
      pnl:fastBalance-Number(data.startingBalance || fastBalance),
      openPnl:fastOpenPnl,
      status:data.status || "active"
    };
    res.status(201).json({
      message:"Market order executed",
      position:{id:positionRef.id,symbol,side,lot:lotValue,entryPrice,stopLoss,takeProfit},
      account:fastAccount
    });
    refreshTradingAccount(req.user.uid,quotes).catch(()=>{});
  } catch(e) {
    console.error("TRADING_ORDER_ERROR", e);
    res.status(500).json({error:"Could not execute order",detail:e.message || "Unknown server error"});
  }
});

app.post("/api/trading/positions/:id/close", requireTerminalAuth, async (req,res) => {
  try {
    if (req.terminal?.terminalRole !== "trader") return res.status(403).json({error:"Investor password is read-only. Use the trading password to close trades."});
    const {ref,data}=await loadTradingAccount(req.terminal.uid);
    const positionRef=ref.collection("positions").doc(req.params.id);
    const snap=await positionRef.get();
    if(!snap.exists) return res.status(404).json({error:"Position not found"});
    const p=snap.data();
    if(p.status!=="open") return res.status(409).json({error:"Position is already closed"});
    const quotes=await getMarketQuotes([p.symbol]);
    const q=Number(quotes[p.symbol]?.price||0);
    if(!q) return res.status(502).json({error:"No live market price available"});
    const pnl=tradePnl(p,q);
    await positionRef.update({
      status:"closed",closePrice:q,realizedPnl:pnl,
      closedAt:admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:admin.firestore.FieldValue.serverTimestamp()
    });
    const balance=Number(data.balance ?? data.startingBalance ?? 0)+pnl;
    const starting=Number(data.startingBalance ?? balance);
    const account={
      id:data.accountId || "account",
      balance,
      equity:balance,
      pnl:balance-starting,
      openPnl:0,
      status:data.status || "active"
    };
    await ref.update({
      balance,equity:balance,pnl:balance-starting,openPnl:0,
      updatedAt:admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({message:"Position closed",closePrice:q,realizedPnl:pnl,account});
    refreshTradingAccount(req.terminal.uid,quotes).catch(()=>{});
  } catch(e) {
    console.error("TRADING_CLOSE_ERROR", e);
    res.status(500).json({error:"Could not close position",detail:e.message || "Unknown server error"});
  }
});
app.get("/api/trading/history", requireTerminalAuth, async (req,res) => {
  try {
    const {ref,data}=await loadTradingAccount(req.terminal.uid);
    const snap=await ref.collection("positions").get();
    const all=snap.docs.map(d=>({id:d.id,...d.data(),name:MARKET_SYMBOLS[d.data()?.symbol]?.name||d.data()?.symbol}));
    const open=all.filter(p=>p.status==="open");
    const pending=all.filter(p=>p.status==="pending");
    const closed=all.filter(p=>p.status==="closed").sort((a,b)=>{
      const at=a.closedAt?.toMillis?.()||0,bt=b.closedAt?.toMillis?.()||0;return bt-at;
    });
    const symbols=[...new Set(open.map(p=>p.symbol).filter(Boolean))];
    if(symbols.length){
      try {
        const quotes=await getMarketQuotes(symbols);
        for(const p of open) p.currentPrice=Number(quotes[p.symbol]?.price||p.currentPrice||p.entryPrice||0);
      } catch(e) {}
    }
    res.json({
      account:{id:data.accountId||"account",balance:Number(data.balance??data.startingBalance??0),equity:Number(data.equity??data.balance??data.startingBalance??0)},
      open,pending,closed
    });
  } catch(e) {
    res.status(500).json({error:"Could not load trade history",detail:e.message||"Unknown error"});
  }
});

app.patch("/api/trading/positions/:id", requireTerminalAuth, async (req,res) => {
  try {
    if (req.terminal?.terminalRole !== "trader") return res.status(403).json({error:"Investor password is read-only. Use the trading password to close trades."});
    const {ref}=await loadTradingAccount(req.terminal.uid);
    const positionRef=ref.collection("positions").doc(req.params.id);
    const snap=await positionRef.get();
    if(!snap.exists) return res.status(404).json({error:"Position not found"});
    const p=snap.data();
    if(p.status!=="open") return res.status(409).json({error:"Position is closed"});
    const sl=req.body.stopLoss===null||req.body.stopLoss===""?null:Number(req.body.stopLoss);
    const tp=req.body.takeProfit===null||req.body.takeProfit===""?null:Number(req.body.takeProfit);
    const current=Number((await getMarketQuotes([p.symbol]))[p.symbol]?.price||p.entryPrice);
    if(sl!==null && (!Number.isFinite(sl)||sl<=0)) return res.status(400).json({error:"Invalid stop loss"});
    if(tp!==null && (!Number.isFinite(tp)||tp<=0)) return res.status(400).json({error:"Invalid take profit"});
    if(p.side==="BUY" && ((sl!==null&&sl>=current)||(tp!==null&&tp<=current))) return res.status(400).json({error:"BUY SL must be below current price and TP above current price"});
    if(p.side==="SELL" && ((sl!==null&&sl<=current)||(tp!==null&&tp>=current))) return res.status(400).json({error:"SELL SL must be above current price and TP below current price"});
    await positionRef.update({stopLoss:sl,takeProfit:tp,updatedAt:admin.firestore.FieldValue.serverTimestamp()});
    res.json({message:"Position risk settings updated",stopLoss:sl,takeProfit:tp});
  } catch(e) { res.status(500).json({error:"Could not update position",detail:e.message}); }
});

app.get("/api/my-courses", requireAuth, async (req, res) => {
  try {
    initFirebase();

    const snap = await db.collection("users")
      .doc(req.user.uid)
      .collection("courses")
      .get();

    const courses = [];

    for (const d of snap.docs) {
      const c = await db.collection("courses").doc(d.id).get();
      if (c.exists) {
        courses.push({
          id: c.id,
          ...c.data(),
          grantedAt: d.data().grantedAt || null
        });
      }
    }

    res.json({ courses });
  } catch (e) {
    res.status(500).json({ error: "Could not load your courses", detail: e.message });
  }
});

app.get("/api/courses/:id/access", requireAuth, async (req, res) => {
  try {
    initFirebase();

    const grant = await db.collection("users")
      .doc(req.user.uid)
      .collection("courses")
      .doc(req.params.id)
      .get();

    if (!grant.exists) {
      return res.status(403).json({ error: "Course access not granted" });
    }

    const course = await db.collection("courses").doc(req.params.id).get();
    if (!course.exists) return res.status(404).json({ error: "Course not found" });

    res.json({
      access: true,
      course: { id: course.id, ...course.data() }
    });
  } catch (e) {
    res.status(500).json({ error: "Could not verify course access", detail: e.message });
  }
});

app.use((err, req, res, next) => {
  if (err?.message === "Origin not allowed") {
    return res.status(403).json({ error: "Origin not allowed" });
  }
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

function meetingRoomId(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
}

async function verifyMeetingSocket(req) {
  const url = new URL(req.url || "", "http://localhost");
  const token = url.searchParams.get("token") || "";
  const code = meetingRoomId(url.searchParams.get("code") || "");
  const passcode = String(url.searchParams.get("passcode") || "");
  const kind = String(url.searchParams.get("kind") || "participant");
  const role = String(url.searchParams.get("role") || "participant");
  if (!token || !code) throw new Error("Authentication and meeting code are required");
  initFirebase();
  const user = await admin.auth().verifyIdToken(token);
  const snap = await db.collection("settings").doc("meeting").get();
  const meeting = snap.exists ? snap.data() : {};
  if (meeting.enabled !== true || meetingRoomId(meeting.meetingId) !== code) throw new Error("Meeting is not active");
  if (String(meeting.passcode || "") && String(meeting.passcode) !== passcode) throw new Error("Invalid meeting passcode");
  let meetingRole = "participant";
  if (role === "host") {
    const admins = (process.env.ADMIN_EMAILS || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
    if (user.email && admins.includes(String(user.email).toLowerCase())) meetingRole = "host";
  }
  return { user, kind: kind === "screen" ? "screen" : "participant", role: meetingRole };
}

function activeParticipantCount(room) {
  let count = 0;
  for (const info of room.values()) if (!info.isScreen) count++;
  return count;
}

function broadcastRoom(room, payload, exceptId = "") {
  for (const [id, client] of room) {
    if (id === exceptId) continue;
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(payload));
  }
}

function broadcastBinary(room, data, exceptId = "") {
  for (const [id, client] of room) {
    if (id === exceptId || client.isScreen) continue;
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(data, { binary: true });
  }
}

meetingWss.on("connection", (ws, req, auth, code) => {
  const room = meetingRooms.get(code) || new Map();
  const { user, kind, role } = auth;
  const isScreen = kind === "screen";
  const isHost = !isScreen && role === "host";

  if (isScreen && [...room.values()].some(x => x.isScreen)) {
    ws.send(JSON.stringify({ type: "error", message: "Another screen is already being shared." }));
    ws.close();
    return;
  }

  if (!isScreen && activeParticipantCount(room) >= 12) {
    ws.send(JSON.stringify({ type: "error", message: "Meeting is full. Maximum 12 participants." }));
    ws.close();
    return;
  }

  const id = crypto.randomUUID();
  const name = user.name || user.email?.split("@")[0] || "Participant";
  room.set(id, { ws, userId: user.uid, name, isScreen, isHost });
  meetingRooms.set(code, room);

  const peers = isScreen
    ? []
    : [...room.entries()]
        .filter(([peerId, info]) => peerId !== id && !info.isScreen)
        .map(([peerId, info]) => ({ id: peerId, name: info.name, isHost: info.isHost }));

  if (isScreen) {
    ws.send(JSON.stringify({ type: "screen-connected", selfId: id }));
    broadcastRoom(room, { type: "screen-start", id, name: name + " • Screen" }, id);
  } else {
    ws.send(JSON.stringify({
      type: "joined",
      selfId: id,
      peers,
      count: activeParticipantCount(room),
      screenSharing: [...room.values()].some(x => x.isScreen)
    }));
    broadcastRoom(room, { type: "participant-count", count: activeParticipantCount(room) }, "");
    broadcastRoom(room, { type: "peer-joined", id, name, isHost }, id);
  }

  ws.on("message", (raw, isBinary) => {
    if (isBinary) {
      if (isScreen) broadcastBinary(room, raw, id);
      return;
    }

    try {
      const msg = JSON.parse(raw.toString());

      if (isScreen && msg.type === "screen-start") {
        broadcastRoom(room, { type: "screen-start", id, name: name + " • Screen" }, id);
        return;
      }

      if (isScreen && msg.type === "screen-stop") {
        broadcastRoom(room, { type: "screen-stop", id }, id);
        return;
      }

      if (msg.type === "camera-request") {
        const host = [...room.entries()].find(([, info]) => info.isHost && !info.isScreen);
        if (host && host[1].ws.readyState === WebSocket.OPEN) {
          host[1].ws.send(JSON.stringify({ type: "camera-request", from: id, fromName: name }));
        }
        return;
      }

      if (msg.type === "camera-response") {
        if (!isHost) return;
        const target = room.get(String(msg.to || ""));
        if (!target || target.isScreen) return;
        target.ws.send(JSON.stringify({
          type: "camera-response",
          approved: msg.approved === true,
          from: id,
          fromName: name
        }));
        return;
      }

      const target = room.get(String(msg.to || ""));
      if (!target || target.isScreen || !["offer", "answer", "ice"].includes(msg.type)) return;
      target.ws.send(JSON.stringify({ ...msg, from: id, fromName: name }));
    } catch {}
  });

  const cleanup = () => {
    if (!room.has(id)) return;
    room.delete(id);
    if (room.size === 0) {
      meetingRooms.delete(code);
    } else if (isScreen) {
      broadcastRoom(room, { type: "screen-stop", id });
    } else {
      broadcastRoom(room, { type: "peer-left", id });
      broadcastRoom(room, { type: "participant-count", count: activeParticipantCount(room) });
    }
  };

  ws.on("close", cleanup);
  ws.on("error", cleanup);
});

httpServer.on("upgrade", async (req, socket, head) => {
  try {
    const url = new URL(req.url || "", "http://localhost");
    if (url.pathname !== "/ws/meeting") {
      socket.destroy();
      return;
    }
    const code = meetingRoomId(url.searchParams.get("code") || "");
    const auth = await verifyMeetingSocket(req);
    meetingWss.handleUpgrade(req, socket, head, ws => {
      meetingWss.emit("connection", ws, req, auth, code);
    });
  } catch (e) {
    try { socket.write("HTTP/1.1 401 Unauthorized\\r\\n\\r\\n"); } catch {}
    socket.destroy();
  }
});

httpServer.listen(PORT, () => {
  console.log("Course Era API + meeting server running on port " + PORT);
});
