import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import admin from "./mongo-firebase-compat.js";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getMongoDb } from "./mongodb.js";
import { createAuthToken } from "./mongo-firebase-compat.js";

const app = express();
// Aura Farming runs behind the AIC edge proxy, so trust its forwarded client IP.
app.set("trust proxy", 1);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_ROOT = path.resolve(__dirname, "..");
app.use("/downloads", express.static(path.join(FRONTEND_ROOT, "downloads"), {
  setHeaders: (res, filePath) => {
    if (String(filePath).endsWith(".apk")) {
      res.setHeader("Content-Type", "application/vnd.android.package-archive");
      res.setHeader("Content-Disposition", 'attachment; filename="AuraFarming-Terminal.apk"');
    }
  }
}));
const httpServer = http.createServer(app);
const meetingWss = new WebSocketServer({ noServer: true });
const marketWss = new WebSocketServer({ noServer: true });
const meetingRooms = new Map();
const marketClients = new Map();
let marketStreamTimer = null;
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
  "https://localhost",
  "https://aurafirming.in",
  "https://www.aurafirming.in"
];

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://www.gstatic.com", "https://cdn.jsdelivr.net", "https://unpkg.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "https:"],
      fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
      connectSrc: [
        "'self'",
        "https://*.googleapis.com",
        "https://*.firebaseio.com",
        "wss://*.firebaseio.com",
        "https://securetoken.googleapis.com",
        "https://identitytoolkit.googleapis.com",
        "https://firebaseinstallations.googleapis.com"
      ],
      frameSrc: ["'self'", "https://*.firebaseapp.com", "https://*.google.com"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  }
}));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Origin not allowed"));
  }
}));
app.use(express.json({ limit: "1mb" }));
app.use(express.static(FRONTEND_ROOT, {
  index: false,
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
  }
}));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 1200,
  standardHeaders: "draft-8",
  legacyHeaders: false
}));

let db;
let bucket;
// Short-lived terminal auth cache: the terminal polls market data frequently,
// so validating the same session against Firestore on every poll can exhaust
// the free Firestore read quota. Revocation is still re-checked after expiry.
const terminalAuthCache = new Map();
const activeRiskAccounts = new Map(); // key: uid::accountId
function trackRiskAccount(uid, accountId) {
  const id = String(accountId || "").trim();
  const key = String(uid) + "::" + id;
  activeRiskAccounts.set(key, { uid: String(uid), accountId: id, at: Date.now() });
}
function untrackRiskAccount(uid, accountId) {
  activeRiskAccounts.delete(String(uid) + "::" + String(accountId || "").trim());
}
let floatingRiskTimer = null;
function startFloatingRiskMonitor() {
  if (floatingRiskTimer) return;
  floatingRiskTimer = setInterval(async () => {
    if (!activeRiskAccounts.size) return;
    const entries = [...activeRiskAccounts.values()];
    for (const { uid, accountId } of entries) {
      try {
        const { ref, data } = await loadTradingAccount(uid, accountId);
        if ((data.status || "active") !== "active") {
          untrackRiskAccount(uid, accountId);
          continue;
        }
        const openSnap = await ref.collection("positions").where("status", "==", "open").limit(50).get();
        if (openSnap.empty) {
          untrackRiskAccount(uid, accountId);
          continue;
        }
        const symbols = [...new Set(openSnap.docs.map(d => d.data()?.symbol).filter(Boolean))];
        const quotes = symbols.length ? await getMarketQuotes(symbols) : {};
        await refreshTradingAccount(uid, quotes, accountId);
      } catch (e) {
        console.warn("FLOATING_RISK_TICK", e?.message || e);
      }
    }
  }, 1000);
}
startFloatingRiskMonitor();

const TERMINAL_AUTH_CACHE_MS = 10000;

function initFirebase() {
  // Compatibility name kept so existing routes stay stable; all persistence and
  // authentication now run against MongoDB. Firebase Admin/Firestore are not used.
  if (!db) db = admin.firestore();
  bucket = null;
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

    // Keep the primary Aura Farming admin usable even if ADMIN_EMAILS was
    // not added to the server environment yet. Environment-configured admins
    // still work as before, and Firebase custom admin claims remain supported.
    const primaryAdminEmail = "lipupoddar@gmail.com";

    if (req.user?.admin === true || (email && (allowed.includes(email) || email === primaryAdminEmail))) {
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
  const material = process.env.TERMINAL_CREDENTIAL_SECRET || process.env.AUTH_SESSION_SECRET || process.env.MONGO_URI || "course-era-mongo-terminal";
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
  const material = process.env.TERMINAL_CREDENTIAL_SECRET || process.env.AUTH_SESSION_SECRET || process.env.MONGO_URI || "course-era-mongo-terminal";
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
    const accountBase = db.collection("users").doc(token.uid);
    const accountRef = accountBase.collection("tradingAccounts").doc(String(token.accountId));
    const accountSnap = await accountRef.get();
    const account = accountSnap.exists ? (accountSnap.data() || {}) : {};
    if (!accountSnap.exists || account.accountId !== String(token.accountId) || account.status !== "active") {
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
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  // Successful logins should not burn the budget (dashboard may refresh session).
  skipSuccessfulRequests: true,
  message: { error: "Too many terminal login attempts. Please try again later." }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(FRONTEND_ROOT, "index.html"));
});

const FRONTEND_PAGES = new Set([
  "admin", "affiliate", "challenge", "checkout", "competition", "courses",
  "help", "index", "invite", "leaderboard", "login", "position", "profile",
  "reviews", "signup", "terminal", "transparency"
]);

app.get("/:page", (req, res, next) => {
  const page = String(req.params.page || "").replace(/\\.html$/i, "");
  if (!FRONTEND_PAGES.has(page)) return next();
  res.sendFile(path.join(FRONTEND_ROOT, page + ".html"));
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
    siteName: "Aura Farming",
    status: "backend-ready",
    mongoConfigured: true,
    storageConfigured: false,
    firebaseConfigured: false
  });
});

app.post("/api/auth/signup", async (req, res) => {
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

    const accountRef = db.collection("users").doc(String(credential.userId)).collection("tradingAccounts").doc(String(credential.accountId));
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
        status: account.status,
        challenge: account.challenge || ""
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

    let ensured = await createTerminalCredentials(accountRef, req.user.uid, account);
    let data = ensured.data || {};
    let loginId = data.loginId || ensured.id;
    let tradingPassword;
    let investorPassword;

    try {
      if (ensured.created) {
        tradingPassword = ensured.credentials.tradingPassword;
        investorPassword = ensured.credentials.investorPassword;
      } else {
        tradingPassword = decryptTerminalSecret(data.tradingPasswordEnc);
        investorPassword = decryptTerminalSecret(data.investorPasswordEnc);
      }
    } catch (decryptError) {
      // Credentials may have been encrypted on an older deployment with different
      // key material. Revoke that credential and issue a fresh one for this active
      // trading account so the dashboard can recover without changing the account.
      console.warn("TRADING_CREDENTIALS_ROTATING_LEGACY:", decryptError.message);
      if (loginId) {
        await db.collection("terminalCredentials").doc(loginId).set({
          status: "revoked",
          revokedAt: admin.firestore.FieldValue.serverTimestamp(),
          revokedReason: "Credential encryption key changed",
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }
      await accountRef.update({
        terminalCredentialId: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      const freshAccountSnap = await accountRef.get();
      const freshAccount = freshAccountSnap.data() || {};
      ensured = await createTerminalCredentials(accountRef, req.user.uid, freshAccount);
      data = ensured.data || {};
      loginId = data.loginId || ensured.id;
      if (!ensured.created) throw new Error("Could not rotate terminal credentials");
      tradingPassword = ensured.credentials.tradingPassword;
      investorPassword = ensured.credentials.investorPassword;
    }

    res.json({ loginId, tradingPassword, investorPassword, accountId: account.accountId || "" });
  } catch (e) {
    console.error("TRADING_CREDENTIALS_ERROR:", e);
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

const DEFAULT_STRUCTURED_CHALLENGE_RULES = {
  "1 Step": {
    "Phase 1": { stage: "Phase 1", floatingLossEnabled: true, floatingLossPercent: 1, minimumTradingDays: 5 },
    "Funded":  { stage: "Funded",  floatingLossEnabled: true, floatingLossPercent: 1, minimumTradingDays: 0 }
  },
  "2 Step": {
    "Phase 1": { stage: "Phase 1", floatingLossEnabled: true, floatingLossPercent: 1, minimumTradingDays: 3 },
    "Phase 2": { stage: "Phase 2", floatingLossEnabled: true, floatingLossPercent: 1, minimumTradingDays: 2 },
    "Funded":  { stage: "Funded",  floatingLossEnabled: true, floatingLossPercent: 1, minimumTradingDays: 0 }
  },
  "Instant": {
    "Funded": { stage: "Funded", floatingLossEnabled: true, floatingLossPercent: 1, minimumTradingDays: 0 }
  }
};

function normalizeStageRule(value, stage) {
  let raw = value;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { raw = {}; }
  }
  raw = raw && typeof raw === "object" ? raw : {};
  const pct = Number(raw.floatingLossPercent ?? raw.floatingLossPct ?? 1);
  const days = Number(raw.minimumTradingDays ?? raw.minTradingDays ?? 5);
  return {
    stage: String(raw.stage || stage),
    floatingLossEnabled: raw.floatingLossEnabled === true,
    floatingLossPercent: Math.min(2.5, Math.max(0.25, Number.isFinite(pct) ? pct : 1)),
    minimumTradingDays: Math.min(10, Math.max(0, Math.round(Number.isFinite(days) ? days : 5)))
  };
}

function normalizeChallengeRulesPayload(input) {
  const source = input && typeof input === "object" ? input : {};
  const models = {
    "1 Step": ["Phase 1", "Funded"],
    "2 Step": ["Phase 1", "Phase 2", "Funded"],
    "Instant": ["Funded"]
  };
  const out = {};
  for (const [name, stages] of Object.entries(models)) {
    out[name] = {};
    const md = source[name];
    for (const stage of stages) {
      let value;
      if (Array.isArray(md)) {
        value = md.find(v => {
          if (v && typeof v === "object") return String(v.stage || "") === stage;
          try { return JSON.parse(v)?.stage === stage; } catch { return false; }
        });
      } else if (md && typeof md === "object") {
        value = md[stage];
      }
      out[name][stage] = normalizeStageRule(value, stage);
    }
  }
  return out;
}

app.get("/api/challenge-rules", async (req, res) => {
  try {
    const mongo = await getMongoDb();
    const doc = await mongo.collection("challenge_rules").findOne({ _id: "global" });
    const saved = doc?.rules && typeof doc.rules === "object" ? doc.rules : null;
    const isStructured = saved && typeof saved["1 Step"] === "object" && !Array.isArray(saved["1 Step"]);
    const rules = isStructured ? normalizeChallengeRulesPayload(saved) : DEFAULT_STRUCTURED_CHALLENGE_RULES;
    res.set("Cache-Control", "no-store");
    res.json({ rules });
  } catch (e) {
    console.error("challenge-rules GET error:", e?.message || e);
    res.status(500).json({ error: "Could not load challenge rules" });
  }
});

app.put("/api/challenge-rules", requireAuth, requireAdmin, async (req, res) => {
  try {
    const incoming = req.body?.rules || {};
    const rules = normalizeChallengeRulesPayload(incoming);
    const mongo = await getMongoDb();
    await mongo.collection("challenge_rules").updateOne(
      { _id: "global" },
      {
        $set: {
          rules,
          updatedAt: new Date(),
          updatedBy: req.user?.uid || req.user?.email || "admin"
        }
      },
      { upsert: true }
    );
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, rules });
  } catch (e) {
    console.error("challenge-rules PUT error:", e?.message || e);
    res.status(500).json({ error: "Could not save challenge rules" });
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
      accountSize: Number(x.accountSize), price: Number(x.price), discountPercent: Math.min(100, Math.max(0, Number(x.discountPercent) || 0)),
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

    const challengeId = String(req.body?.challengeId || "").trim();
    const transactionId = String(req.body?.transactionId || "").trim();
    const method = String(req.body?.method || "UPI").trim().toUpperCase();
    const currency = String(req.body?.currency || (method === "USDT" ? "USDT" : "INR")).trim().toUpperCase();
    const amount = positiveAmount(req.body?.amount);

    if (!challengeId || !transactionId || amount === null) {
      return res.status(400).json({ error:"challengeId, transactionId and valid amount are required" });
    }
    if (!["INR","USDT"].includes(currency)) {
      return res.status(400).json({ error:"Currency must be INR or USDT" });
    }

    const catalog = await getChallengeCatalog();
    const challenge = catalog.find(x => x.id === challengeId);
    if (!challenge) return res.status(404).json({ error:"Challenge not found" });

    const discountPercent = Math.min(100, Math.max(0, Number(challenge.discountPercent) || 0));
    const discountedPrice = Math.round(Number(challenge.price) * (1 - discountPercent / 100) * 100) / 100;
    const expectedAmount = currency === "INR" ? Math.round(discountedPrice * 98) : discountedPrice;

    if (Math.abs(expectedAmount - amount) > 0.01) {
      return res.status(400).json({
        error:"Payment amount does not match selected currency price",
        expectedAmount,
        receivedAmount:amount,
        currency
      });
    }

    // Make repeated submits idempotent for the same logged-in user.
    // A previous successful submit should not look like a new failure on retry.
    const duplicate = await db.collection("payments")
      .where("transactionId","==",transactionId)
      .limit(5)
      .get();

    if (!duplicate.empty) {
      const existingDoc = duplicate.docs.find(d => d.data()?.userId === req.user.uid);
      if (existingDoc) {
        const existing = existingDoc.data() || {};
        if (existing.type === "challenge" && existing.challengeId === challengeId) {
          return res.status(200).json({
            id:existingDoc.id,
            status:existing.status || "pending",
            message:existing.status === "approved"
              ? "This payment was already approved."
              : existing.status === "rejected"
                ? "This payment was already rejected."
                : "Payment already submitted. It is waiting for admin review."
          });
        }
        return res.status(409).json({ error:"This transaction/reference ID is already linked to another payment." });
      }
      return res.status(409).json({ error:"This transaction/reference ID was already submitted" });
    }

    let screenshotUrl = "";
    let screenshotPath = "";

    if (req.file) {
      const safe = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0,120);
      const stamp = Date.now();
      screenshotPath = "payment-proofs/" + req.user.uid + "/" + stamp + "-" + safe;

      if (bucket) {
        try {
          const screenshotToken = crypto.randomUUID();
          const file = bucket.file(screenshotPath);
          await file.save(req.file.buffer, {
            resumable:false,
            metadata:{
              contentType:req.file.mimetype,
              metadata:{firebaseStorageDownloadTokens:screenshotToken}
            }
          });
          screenshotUrl =
            "https://firebasestorage.googleapis.com/v0/b/" +
            encodeURIComponent(bucket.name) +
            "/o/" + encodeURIComponent(screenshotPath) +
            "?alt=media&token=" + encodeURIComponent(screenshotToken);
        } catch (storageError) {
          console.warn("Payment screenshot Storage upload failed; using Firestore fallback:", storageError?.message || storageError);
          screenshotPath = "";
        }
      }

      // Storage is optional. For small mobile screenshots, keep the proof in the
      // payment document so submission can still succeed when Storage is unavailable.
      if (!screenshotUrl) {
        if (req.file.buffer.length > 650000) {
          return res.status(400).json({
            error:"Payment screenshot could not be uploaded. Please choose a smaller screenshot and try again."
          });
        }
        screenshotUrl = "data:" + req.file.mimetype + ";base64," + req.file.buffer.toString("base64");
      }
    }

    const ref = db.collection("payments").doc();
    await ref.set({
      userId:req.user.uid,
      userEmail:req.user.email || "",
      type:"challenge",
      challengeId,
      challengeModel:challenge.model,
      challengeSize:challenge.size,
      accountSize:Number(challenge.accountSize),
      courseId:"",
      courseTitle:"Aura Farming " + challenge.model + " " + challenge.size,
      method,
      currency,
      transactionId,
      amount,
      screenshotUrl,
      screenshotPath,
      status:"pending",
      submittedAt:admin.firestore.FieldValue.serverTimestamp(),
      reviewedAt:null,
      reviewedBy:null
    });

    res.status(201).json({
      id:ref.id,
      status:"pending",
      message:"Challenge payment submitted for verification"
    });
  } catch(e) {
    console.error("CHALLENGE_PAYMENT_ERROR", e);
    res.status(500).json({
      error:"Could not submit challenge payment",
      detail:e?.message || "Unknown server error"
    });
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
      const catalog = await getChallengeCatalog();
      const challenge = catalog.find(x => x.id === payment.challengeId);
      if (!challenge) return res.status(400).json({ error: "Challenge is no longer available" });
      const accountId = "AF-ACC-" + new Date().getFullYear() + "-" + crypto.randomBytes(4).toString("hex").toUpperCase();
      const accountRef = db.collection("users").doc(payment.userId).collection("trading").doc("account");
      // Create full payload first (without terminalCredentialId), then issue credentials
      const basePayload = buildChallengeAccountPayload(challenge, req.params.id, accountId);
      await accountRef.set(basePayload);
      const credentialBundle = await createTerminalCredentials(accountRef, payment.userId, {
        accountId, status: "active"
      });
      const fullPayload = buildChallengeAccountPayload(challenge, req.params.id, accountId, credentialBundle.id);
      await accountRef.set(fullPayload);
      await db.collection("users").doc(payment.userId).collection("challengeAccounts").doc(accountId).set({
        accountId, paymentId: req.params.id, challengeId: challenge.id, model: challenge.model, size: challenge.size,
        accountSize: Number(challenge.accountSize), status: "active",
        phase: fullPayload.phase, funded: fullPayload.funded,
        terminalCredentialId: credentialBundle.id,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      await db.collection("users").doc(payment.userId).collection("tradingAccounts").doc(accountId).set(fullPayload);
      await ref.update({
        accountId,
        terminalCredentialId: credentialBundle.id,
        ...(credentialBundle.credentials ? { terminalLoginId: credentialBundle.credentials.loginId } : {}),
        ...(credentialBundle.credentials ? { terminalCredentialsIssued: true } : {})
      });
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

app.get("/api/trading-accounts", requireAuth, async (req, res) => {
  try {
    initFirebase();
    const base = db.collection("users").doc(req.user.uid);
    const snap = await base.collection("tradingAccounts").orderBy("createdAt", "desc").limit(5).get();
    const accounts = snap.docs.map(d => ({ id:d.id, ...(d.data() || {}) }));
    if (!accounts.length) {
      const current = await base.collection("trading").doc("account").get();
      if (current.exists) return res.json({ accounts:[{ id:current.id, ...(current.data() || {}) }] });
    }
    return res.json({ accounts });
  } catch (e) {
    return res.status(500).json({ error:"Could not load trading accounts", detail:e.message });
  }
});

app.post("/api/trading-account/select", requireAuth, async (req, res) => {
  try {
    initFirebase();
    const accountId = String(req.body?.accountId || "").trim();
    if (!accountId) return res.status(400).json({ error:"accountId is required" });
    const userRef = db.collection("users").doc(req.user.uid);
    const selectedRef = userRef.collection("tradingAccounts").doc(accountId);
    const selectedSnap = await selectedRef.get();
    if (!selectedSnap.exists) return res.status(404).json({ error:"Trading account not found" });
    const selected = selectedSnap.data() || {};
    if (selected.status && selected.status !== "active") return res.status(403).json({ error:"Trading account is not active" });
    // Always mirror with canonical accountId = doc id (prevents stale balance/credentials mix)
    const mirror = {
      ...selected,
      accountId,
      id: accountId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    await userRef.collection("trading").doc("account").set(mirror, { merge: false });
    // Keep tradingAccounts doc accountId field consistent
    try {
      await selectedRef.set({ accountId, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    } catch (_) {}
    console.log("ACCOUNT_SELECT", req.user.uid, accountId, "balance=", mirror.balance, "challenge=", mirror.challenge);
    return res.json({
      account: {
        id: accountId,
        accountId,
        startingBalance: Number(mirror.startingBalance || 0),
        balance: Number(mirror.balance ?? mirror.startingBalance ?? 0),
        equity: Number(mirror.equity ?? mirror.balance ?? mirror.startingBalance ?? 0),
        pnl: Number(mirror.pnl ?? 0),
        challenge: mirror.challenge || "",
        status: mirror.status || "active",
        phase: mirror.phase || mirror.stage || "",
        dailyDrawdownPct: Number(mirror.dailyDrawdownPct || 0),
        maxDrawdownPct: Number(mirror.maxDrawdownPct || 0)
      }
    });
  } catch (e) {
    console.error("ACCOUNT_SELECT_ERR", e);
    return res.status(500).json({ error:"Could not select trading account", detail:e.message });
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
          maxDrawdownLimit: accountRules(account).maxDrawdownPct,
          profitTargetPct: (function(){ try { const r = accountRules(account); return r.profitTargetPct; } catch(e){ return null; } })(),
          phase: account.phase || account.stage || '',
          funded: account.funded === true,
          startingBalance: Number(account.startingBalance || account.accountSize || 0),
          floatingLossHits: Number(account.floatingLossHits || 0),
          floatingLossActive: account.floatingLossActive === true,
          lastRiskWarning: account.lastRiskWarning || "",
          riskWarning: account.lastRiskWarning || ""
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
          maxDrawdownLimit: accountRules(account).maxDrawdownPct,
          floatingLossHits: Number(account.floatingLossHits || 0),
          floatingLossActive: account.floatingLossActive === true,
          lastRiskWarning: account.lastRiskWarning || "",
          riskWarning: account.lastRiskWarning || ""
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

async function loadTradingAccount(uid, accountId = "") {
  initFirebase();
  const userRef = db.collection("users").doc(uid);
  const id = String(accountId || "").trim();
  if (id) {
    const accountRef = userRef.collection("tradingAccounts").doc(id);
    const snap = await accountRef.get();
    if (snap.exists && String(snap.data()?.accountId || snap.id) === id) {
      return { ref:accountRef, data:snap.data() || {} };
    }
  }
  const ref = userRef.collection("trading").doc("account");
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Trading account not found");
  return { ref, data:snap.data() || {} };
}

function accountRules(account) {
  const model = String(account.model || account.challengeModel || account.challenge || "").toLowerCase();
  const isInstant = model.includes("instant");
  const dailyDefault = isInstant ? 3 : 4;
  const maxDefault = isInstant ? 100 : 8; // Instant often has no hard total DD in catalog
  return {
    dailyDrawdownPct: parsePercent(account.dailyDrawdown ?? account.dailyDrawdownLimit, dailyDefault),
    maxDrawdownPct: parsePercent(account.maxDrawdown ?? account.maxDrawdownLimit ?? account.totalDrawdown, maxDefault),
    profitTargetPct: (() => {
      const phase = String(account.phase || account.stage || "").toLowerCase();
      if (phase.includes("funded") || account.funded === true) return null;
      if (phase.includes("phase 2") || phase.includes("step 2")) {
        return parsePercent(account.phase2Profit ?? account.profitTarget, 6);
      }
      // Phase 1 or 1-Step
      if (model.includes("1 step") || model.includes("1-step") || model.includes("one step")) {
        return parsePercent(account.profitTarget ?? account.phase1Profit, 10);
      }
      return parsePercent(account.phase1Profit ?? account.profitTarget, 8);
    })(),
    minTradingDays: Number(account.minTradingDays) > 0 ? Number(account.minTradingDays) : 5
  };
}

function buildChallengeAccountPayload(challenge, paymentId, accountId, terminalCredentialId = null) {
  const size = Number(challenge.accountSize);
  const model = String(challenge.model || "").trim();
  const isInstant = /instant/i.test(model);
  const phase = isInstant ? "Funded" : "Phase 1";
  const dailyDd = parsePercent(challenge.dailyDrawdown, isInstant ? 3 : 4);
  const maxDd = parsePercent(challenge.totalDrawdown, isInstant ? 100 : 8);
  let profitTarget = null;
  if (!isInstant) {
    if (/1\s*step|one\s*step|1-step/i.test(model)) {
      profitTarget = parsePercent(challenge.profitTarget, 10);
    } else {
      profitTarget = parsePercent(challenge.phase1Profit, 8);
    }
  }
  const payload = {
    accountId,
    startingBalance: size,
    balance: size,
    equity: size,
    pnl: 0,
    openPnl: 0,
    currency: "USD",
    challenge: model + " " + String(challenge.size || ""),
    challengeId: challenge.id,
    model,
    challengeModel: model,
    phase,
    stage: phase,
    funded: isInstant,
    status: "active",
    dailyDrawdown: dailyDd,
    maxDrawdown: maxDd,
    dailyDrawdownLimit: dailyDd,
    maxDrawdownLimit: maxDd,
    profitTarget: profitTarget,
    phase1Profit: challenge.phase1Profit ? parsePercent(challenge.phase1Profit, 8) : null,
    phase2Profit: challenge.phase2Profit ? parsePercent(challenge.phase2Profit, 6) : null,
    phaseStartBalance: size,
    staticDrawdownBase: size,
    peakEquity: size,
    floatingLossHits: 0,
    floatingLossActive: false,
    tradingDays: 0,
    tradingDayKeys: [],
    sourcePaymentId: paymentId,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  if (terminalCredentialId) payload.terminalCredentialId = terminalCredentialId;
  return payload;
}


async function resolveFloatingRule(account) {
  const phase = String(account?.phase || account?.stage || "Phase 1");
  const modelRaw = String(account?.model || account?.challengeModel || account?.challenge || "");
  let model = "1 Step";
  if (/instant/i.test(modelRaw)) model = "Instant";
  else if (/2\s*step/i.test(modelRaw)) model = "2 Step";
  else if (/1\s*step/i.test(modelRaw)) model = "1 Step";

  let stageKey = "Phase 1";
  if (/funded/i.test(phase) || account?.funded === true) stageKey = "Funded";
  else if (/phase\s*2/i.test(phase)) stageKey = "Phase 2";
  else if (/phase\s*1/i.test(phase)) stageKey = "Phase 1";
  if (model === "Instant") stageKey = "Funded";

  const accEnabled = account?.floatingLossEnabled;
  const accPct = Number(account?.floatingLossPercent ?? account?.floatingLossPct);

  try {
    const mongo = await getMongoDb();
    const doc = await mongo.collection("challenge_rules").findOne({ _id: "global" });
    const saved = doc?.rules && typeof doc.rules === "object" ? doc.rules : null;
    const rules = saved ? normalizeChallengeRulesPayload(saved) : DEFAULT_STRUCTURED_CHALLENGE_RULES;
    const stageRule = rules?.[model]?.[stageKey] || {};
    const enabled = accEnabled != null ? accEnabled !== false : stageRule.floatingLossEnabled !== false;
    const pct = Number.isFinite(accPct) && accPct > 0 ? accPct : Number(stageRule.floatingLossPercent || 1);
    return {
      enabled,
      percent: Math.min(2.5, Math.max(0.25, pct || 1)),
      model,
      stageKey,
      isFundedStage: stageKey === "Funded" || account?.funded === true || /funded/i.test(phase)
    };
  } catch (e) {
    console.warn("FLOATING_RULE_FALLBACK", e?.message || e);
    return {
      enabled: accEnabled !== false,
      percent: Number.isFinite(accPct) && accPct > 0 ? accPct : 1,
      model,
      stageKey,
      isFundedStage: stageKey === "Funded" || account?.funded === true || /funded/i.test(phase)
    };
  }
}


async function closeAllOpenPositions(ref, positions, quotes, reason) {
  let realized = 0;
  const closed = [];
  for (const p of positions) {
    const q = Number(quotes?.[p.symbol]?.price || p.currentPrice || p.entryPrice || 0);
    if (!q) continue;
    const pnl = tradePnl(p, q);
    realized += pnl;
    await ref.collection("positions").doc(p.id).update({
      status: "closed",
      closePrice: q,
      realizedPnl: pnl,
      closeReason: String(reason || "Risk limit").slice(0, 120),
      closedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    closed.push(p.id);
  }
  return { realized, closed };
}

async function refreshTradingAccount(uid, quotes, accountId = "") {
  const { ref, data } = await loadTradingAccount(uid, accountId);
  const positionSnap = await ref.collection("positions").where("status","==","open").get();
  const missingSymbols=[...new Set(positionSnap.docs.map(d=>d.data()?.symbol).filter(s=>s && !quotes?.[s]))];
  if(missingSymbols.length){
    const extra=await getMarketQuotes(missingSymbols);
    quotes={...(quotes||{}),...extra};
  }
  let balance = Number(data.balance ?? data.startingBalance ?? 0);
  let openPnl = 0;
  let realizedFromStops = 0;
  let positions = [];

  for (const d of positionSnap.docs) {
    const p = { id:d.id, ...d.data() };
    const q = Number(quotes?.[p.symbol]?.price || 0);
    let exitPrice = null;
    let closeReason = "";
    if (q && p.stopLoss != null) {
      if (p.side === "BUY" && q <= Number(p.stopLoss)) { exitPrice=Number(p.stopLoss); closeReason="Stop Loss"; }
      if (p.side === "SELL" && q >= Number(p.stopLoss)) { exitPrice=Number(p.stopLoss); closeReason="Stop Loss"; }
    }
    if (q && exitPrice === null && p.takeProfit != null) {
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

  // Floating loss basket protection (admin on/off + % from challenge rules)
  const starting = Number(data.startingBalance ?? data.accountSize ?? balance);
  const staticBase = Number(data.staticDrawdownBase ?? data.startingBalance ?? starting);
  const phaseStart = Number(data.phaseStartBalance ?? data.startingBalance ?? starting);
  let floatingLossHits = Number(data.floatingLossHits || 0);
  let floatingLossActive = data.floatingLossActive === true;
  let riskWarning = "";
  let profitSplitPct = data.profitSplitPct == null ? null : Number(data.profitSplitPct);
  let status = data.status || "active";
  let breach = data.breachReason || "";
  let phase = String(data.phase || data.stage || "Phase 1");
  let funded = data.funded === true || /funded/i.test(phase);
  let phaseStartBalance = phaseStart;

  const floatRule = await resolveFloatingRule({ ...data, phase, funded });
  const floatPct = floatRule.percent;
  const floatingLimit = (floatRule.enabled && starting > 0) ? starting * (floatPct / 100) : 0;
  const isFundedStage = floatRule.isFundedStage;

  if (status === "active" && floatingLimit > 0 && openPnl <= -floatingLimit && positions.length) {
    let realized = 0;
    for (const p of positions) {
      const q = Number(quotes?.[p.symbol]?.price || p.currentPrice || 0);
      if (!q) continue;
      const pnl = tradePnl(p, q);
      realized += pnl;
      await ref.collection("positions").doc(p.id).update({
        status: "closed",
        closePrice: q,
        realizedPnl: pnl,
        closeReason: floatPct + "% floating loss limit",
        closedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    balance += realized;
    realizedFromStops += realized;
    openPnl = 0;
    positions = [];
    floatingLossHits += 1;
    floatingLossActive = true;

    if (isFundedStage) {
      status = "breached";
      breach = "Funded/Instant account breached on " + floatPct + "% floating-loss hit";
      riskWarning = "Floating loss limit hit. Account breached.";
    } else if (floatingLossHits >= 2) {
      status = "breached";
      breach = "Challenge account breached after 2 floating-loss hits (" + floatPct + "%)";
      riskWarning = "2nd floating loss hit. Account breached.";
    } else {
      riskWarning = "1st floating hit (" + floatPct + "%). Next hit will breach the account.";
    }
  } else if (floatingLimit <= 0 || openPnl > -floatingLimit) {
    floatingLossActive = false;
  }

  let equity = balance + openPnl;
  const peak = Math.max(Number(data.peakEquity || starting), equity);

  // Daily drawdown trading day resets at 06:30 Asia/Kolkata
  function dailyDrawdownTradingDayKey(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(now);
    const get = type => parts.find(p => p.type === type)?.value || '';
    let y = Number(get('year')), m = Number(get('month')), d = Number(get('day'));
    const h = Number(get('hour')), min = Number(get('minute'));
    if (h < 6 || (h === 6 && min < 30)) {
      const previous = new Date(Date.UTC(y, m - 1, d) - 86400000);
      y = previous.getUTCFullYear(); m = previous.getUTCMonth() + 1; d = previous.getUTCDate();
    }
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const todayKey = dailyDrawdownTradingDayKey(new Date());
  const dayChanged = data.dailyResetDate !== todayKey;
  const dailyStart = dayChanged ? equity : Number(data.dailyStartEquity || starting);
  const dailyDd = dailyStart > 0 ? Math.max(0, (dailyStart - equity) / dailyStart * 100) : 0;
  // Static maximum drawdown measured from original account size / static base
  const maxDd = staticBase > 0 ? Math.max(0, (staticBase - equity) / staticBase * 100) : 0;
  const rules = accountRules(data);

  if (status === "active" && dailyDd >= rules.dailyDrawdownPct) {
    status = "breached";
    breach = `Daily drawdown limit reached (${rules.dailyDrawdownPct}%)`;
    if (positions.length) {
      const r = await closeAllOpenPositions(ref, positions, quotes, breach);
      balance += r.realized;
      realizedFromStops += r.realized;
      openPnl = 0;
      positions = [];
    }
  }
  if (status === "active" && maxDd >= rules.maxDrawdownPct) {
    status = "breached";
    breach = `Maximum drawdown limit reached (${rules.maxDrawdownPct}%)`;
    if (positions.length) {
      const r = await closeAllOpenPositions(ref, positions, quotes, breach);
      balance += r.realized;
      realizedFromStops += r.realized;
      openPnl = 0;
      positions = [];
    }
  }

  // --- Trading days tracking (unique calendar days with at least one closed trade) ---
  let tradingDayKeys = Array.isArray(data.tradingDayKeys) ? [...data.tradingDayKeys] : [];
  try {
    const closedSnap = await ref.collection("positions").where("status", "==", "closed").limit(200).get();
    const daySet = new Set(tradingDayKeys);
    for (const d of closedSnap.docs) {
      const c = d.data() || {};
      const ts = c.closedAt?.toDate?.() || (c.closedAt ? new Date(c.closedAt) : null);
      if (!ts || Number.isNaN(ts.getTime())) continue;
      const key = dailyDrawdownTradingDayKey(ts);
      daySet.add(key);
    }
    tradingDayKeys = [...daySet].slice(-60);
  } catch (_) {}
  const tradingDays = tradingDayKeys.length;

  // --- Profit target / phase progression ---
  let phasePassed = false;
  let newPhase = phase;
  let newFunded = funded;
  let newPhaseStartBalance = phaseStartBalance;
  if (status === "active" && !funded && rules.profitTargetPct != null && phaseStartBalance > 0) {
    const profitPct = ((equity - phaseStartBalance) / phaseStartBalance) * 100;
    const daysOk = tradingDays >= (rules.minTradingDays || 5);
    if (profitPct >= rules.profitTargetPct && daysOk) {
      phasePassed = true;
      const model = String(data.model || data.challengeModel || data.challenge || "").toLowerCase();
      if (/2\\s*step|two\\s*step|2-step/i.test(model) && /phase\\s*1/i.test(phase)) {
        // Promote Phase 1 -> Phase 2
        newPhase = "Phase 2";
        newPhaseStartBalance = equity; // reset base for next target
        riskWarning = riskWarning || `Phase 1 passed (${profitPct.toFixed(2)}%). Moved to Phase 2.`;
      } else {
        // 1-Step or Phase 2 -> Funded: close ALL open trades
        newPhase = "Funded";
        newFunded = true;
        newPhaseStartBalance = equity;
        riskWarning = riskWarning || `Challenge passed (${profitPct.toFixed(2)}%). Account is now Funded.`;
        if (positions.length) {
          const r = await closeAllOpenPositions(ref, positions, quotes, "Phase target complete — positions closed");
          balance += r.realized;
          realizedFromStops += r.realized;
          openPnl = 0;
          positions = [];
          // recompute equity after closes
          // equity updated below from balance + openPnl
        }
      }
    }
  }

  equity = balance + openPnl; // recompute after risk closes

  if (status === "breached" && data.status !== "breached") {
    await revokeTerminalCredentials({ ...data, terminalCredentialId: data.terminalCredentialId }, breach || "Account breached");
  }

  const updatePayload = {
    balance, equity, pnl: balance - starting, openPnl, peakEquity: peak,
    dailyStartEquity: dailyStart, dailyResetDate: todayKey,
    dailyDrawdownPct: Number(dailyDd.toFixed(4)),
    maxDrawdownPct: Number(maxDd.toFixed(4)),
    floatingLossHits, floatingLossActive,
    tradingDays, tradingDayKeys,
    phase: newPhase, stage: newPhase, funded: newFunded,
    phaseStartBalance: newPhaseStartBalance,
    status, breachReason: breach,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  if (profitSplitPct != null) updatePayload.profitSplitPct = profitSplitPct;
  if (riskWarning) {
    updatePayload.lastRiskWarning = riskWarning;
    updatePayload.lastRiskWarningAt = admin.firestore.FieldValue.serverTimestamp();
  }
  if (phasePassed) {
    updatePayload.phasePassedAt = admin.firestore.FieldValue.serverTimestamp();
  }

  await ref.update(updatePayload);

  // Keep selected account mirror in sync when this is a tradingAccounts doc
  try {
    const accId = String(data.accountId || accountId || "").trim();
    if (accId && ref.path.includes("tradingAccounts")) {
      const selected = db.collection("users").doc(uid).collection("trading").doc("account");
      const selSnap = await selected.get();
      if (selSnap.exists && String(selSnap.data()?.accountId || "") === accId) {
        await selected.set(updatePayload, { merge: true });
      }
    }
  } catch (_) {}

  return {
    ...data, ...updatePayload,
    accountId: data.accountId || accountId || "account",
    positions, realizedFromStops, riskWarning, phasePassed
  };
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
    const {ref,data}=await loadTradingAccount(req.terminal.uid, req.terminal.accountId);
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
      if (symbols.length) trackRiskAccount(req.terminal.uid, req.terminal.accountId);
      const refreshed=await refreshTradingAccount(req.terminal.uid, quotes, req.terminal.accountId);
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
    // Reuse the account snapshot already loaded by terminal auth.
    // This removes an extra Firestore read from every market order.
    const ref=req.terminal.accountRef || (await loadTradingAccount(req.terminal.uid, req.terminal.accountId)).ref;
    const data=req.terminal.account || (await loadTradingAccount(req.terminal.uid, req.terminal.accountId)).data;
    if ((data.status||"active")!=="active") return res.status(403).json({error:"Trading account is not active",status:data.status||"inactive"});
    if (req.terminal?.terminalRole !== "trader") return res.status(403).json({error:"Investor password is read-only. Use the trading password to place orders."});
    // Capital-based margin guard: crypto 1:10, gold 1:50, forex 1:100.
    const marginLeverage = kind => ({ crypto:10, gold:50, forex:100, "forex-jpy":100 }[String(kind||"")] || null);
    const orderSpec = MARKET_SYMBOLS[symbol];
    const orderLeverage = marginLeverage(orderSpec?.kind);
    let orderMargin = 0;
    if (orderLeverage) {
      const existingSnap = await ref.collection("positions").where("status","==","open").get();
      const existingSymbols = existingSnap.docs.map(d => d.data()?.symbol).filter(Boolean);
      const marginQuotes = await getMarketQuotes([...new Set([symbol, ...existingSymbols])]);
      const marginFor = (position, quote) => {
        const spec = MARKET_SYMBOLS[position.symbol];
        const leverage = marginLeverage(spec?.kind);
        const lotSize = Number(position.lot || 0);
        const price = Number(quote?.price || position.currentPrice || position.entryPrice || 0);
        if (!spec || !leverage || !lotSize || !price) return 0;
        const notional = spec.kind === "forex-jpy"
          ? Math.abs(lotSize * spec.contractSize)
          : Math.abs(price * lotSize * spec.contractSize);
        return notional / leverage;
      };
      let usedMargin = 0;
      for (const doc of existingSnap.docs) usedMargin += marginFor(doc.data() || {}, marginQuotes[doc.data()?.symbol]);
      orderMargin = marginFor({ symbol, lot, entryPrice }, marginQuotes[symbol]);
      const balanceNow = Number(data.balance ?? data.startingBalance ?? 0);
      const equityNow = Number(data.equity ?? (balanceNow + Number(data.openPnl ?? 0)));
      const freeMargin = equityNow - usedMargin;
      if (orderMargin > freeMargin + 0.01) {
        return res.status(400).json({ error:"Insufficient free margin", requiredMargin:Number(orderMargin.toFixed(2)), usedMargin:Number(usedMargin.toFixed(2)), freeMargin:Number(freeMargin.toFixed(2)), leverage:orderLeverage });
      }
    }
    const positionRef=ref.collection("positions").doc();
    const now=admin.firestore.FieldValue.serverTimestamp();
    await positionRef.set({
      accountId:String(req.terminal.accountId),
      symbol, side, lot:Number(lot.toFixed(4)), entryPrice,
      leverage:orderLeverage || null, marginUsed:orderMargin ? Number(orderMargin.toFixed(2)) : 0,
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
    trackRiskAccount(req.terminal.uid, req.terminal.accountId);
    refreshTradingAccount(req.terminal.uid, quotes, req.terminal.accountId).catch(()=>{});
  } catch(e) {
    console.error("TRADING_ORDER_ERROR", e);
    res.status(500).json({error:"Could not execute order",detail:e.message || "Unknown server error"});
  }
});

app.post("/api/trading/positions/:id/close", requireTerminalAuth, async (req,res) => {
  try {
    if (req.terminal?.terminalRole !== "trader") return res.status(403).json({error:"Investor password is read-only. Use the trading password to close trades."});
    const {ref,data}=await loadTradingAccount(req.terminal.uid, req.terminal.accountId);
    const positionRef=ref.collection("positions").doc(req.params.id);
    const snap=await positionRef.get();
    if(!snap.exists) return res.status(404).json({error:"Position not found"});
    const p=snap.data();
    if(p.status!=="open") return res.status(409).json({error:"Position is already closed"});
    // Use the latest server-side market tick first so closing a trade does not
    // wait on another external market-data request. The market websocket refreshes
    // quoteCache continuously; only fall back to the feed when no cached quote exists.
    let cachedQuote=quoteCache.get(p.symbol);
    let q=Number(cachedQuote?.price||0);
    if(!q){
      const quotes=await getMarketQuotes([p.symbol]);
      q=Number(quotes[p.symbol]?.price||0);
    }
    if(!q) return res.status(502).json({error:"No live market price available"});
    const pnl=tradePnl(p,q);
    await positionRef.update({
      status:"closed",closePrice:q,realizedPnl:pnl,
      closedAt:admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:admin.firestore.FieldValue.serverTimestamp()
    });
    const balance=Number(data.balance ?? data.startingBalance ?? 0)+pnl;
    await ref.update({
      balance,
      updatedAt:admin.firestore.FieldValue.serverTimestamp()
    });
    // Fast close response: do not run a second full account reconciliation here.
    // The client already has live market/account data and can update immediately.
    const account={
      id:data.accountId || "account",
      balance,
      equity:balance,
      pnl:balance-Number(data.startingBalance ?? balance),
      openPnl:0,
      status:data.status || "active"
    };
    res.json({message:"Position closed",closePrice:q,realizedPnl:pnl,account});
  } catch(e) {
    console.error("TRADING_CLOSE_ERROR", e);
    res.status(500).json({error:"Could not close position",detail:e.message || "Unknown server error"});
  }
});

// Website dashboard history — Firebase auth only (no terminal token needed)
app.get("/api/dashboard/history", requireAuth, async (req, res) => {
  try {
    initFirebase();
    const uid = req.user.uid;
    // Prefer selected trading account mirror
    let accountId = "";
    let accountData = {};
    const selected = await db.collection("users").doc(uid).collection("trading").doc("account").get();
    if (selected.exists) {
      accountData = selected.data() || {};
      accountId = String(accountData.accountId || "");
    }
    if (!accountId) {
      const list = await db.collection("users").doc(uid).collection("tradingAccounts").orderBy("createdAt", "desc").limit(1).get();
      if (!list.empty) {
        accountId = list.docs[0].id;
        accountData = list.docs[0].data() || {};
      }
    }
    if (!accountId) {
      return res.status(404).json({ error: "No trading account found" });
    }
    const ref = db.collection("users").doc(uid).collection("tradingAccounts").doc(accountId);
    const snap = await ref.collection("positions").get();
    const toIso = v => v?.toDate?.()?.toISOString?.() || (v?._seconds ? new Date(Number(v._seconds)*1000).toISOString() : (typeof v === "string" ? v : null));
    const all = snap.docs.map(d => {
      const p = { id: d.id, ...d.data() };
      p.openedAt = toIso(p.openedAt); p.closedAt = toIso(p.closedAt);
      p.createdAt = toIso(p.createdAt); p.updatedAt = toIso(p.updatedAt);
      if (p.realizedPnl == null && p.pnl != null) p.realizedPnl = Number(p.pnl);
      return p;
    });
    const open = all.filter(p => p.status === "open");
    const pending = all.filter(p => p.status === "pending");
    const closed = all.filter(p => p.status === "closed").sort((a,b) => {
      const at = Date.parse(a.closedAt || a.updatedAt || 0) || 0;
      const bt = Date.parse(b.closedAt || b.updatedAt || 0) || 0;
      return bt - at;
    });
    const starting = Number(accountData.startingBalance ?? accountData.accountSize ?? 0);
    const balance = Number(accountData.balance ?? starting);
    const equity = Number(accountData.equity ?? balance);
    const rules = accountRules(accountData);
    res.json({
      account: {
        id: accountId,
        startingBalance: starting,
        balance,
        equity,
        pnl: Number(accountData.pnl ?? (balance - starting)),
        openPnl: Number(accountData.openPnl ?? 0),
        status: accountData.status || "active",
        challenge: accountData.challenge || "",
        challengeId: accountData.challengeId || "",
        phase: accountData.phase || accountData.stage || "",
        funded: accountData.funded === true,
        dailyDrawdownPct: Number(accountData.dailyDrawdownPct || 0),
        maxDrawdownPct: Number(accountData.maxDrawdownPct || 0),
        dailyDrawdownLimit: Number(accountData.dailyDrawdownLimit ?? rules.dailyDrawdownPct ?? 4),
        maxDrawdownLimit: Number(accountData.maxDrawdownLimit ?? rules.maxDrawdownPct ?? 8)
      },
      open, pending, closed
    });
  } catch (e) {
    console.error("dashboard history error:", e?.message || e);
    res.status(500).json({ error: "Could not load dashboard history", detail: e.message });
  }
});

app.get("/api/trading/history", requireTerminalAuth, async (req,res) => {
  try {
    const {ref,data}=await loadTradingAccount(req.terminal.uid, req.terminal.accountId);
    // Refresh risk metrics so daily/max drawdown are current for the dashboard
    try {
      const openSnap = await ref.collection("positions").where("status","==","open").get();
      const symbols = [...new Set(openSnap.docs.map(d=>d.data()?.symbol).filter(Boolean))];
      const quotes = symbols.length ? await getMarketQuotes(symbols) : {};
      await refreshTradingAccount(req.terminal.uid, quotes, req.terminal.accountId);
    } catch (refreshErr) {
      console.warn("HISTORY_REFRESH_WARN", refreshErr?.message || refreshErr);
    }
    const { data: latest } = await loadTradingAccount(req.terminal.uid, req.terminal.accountId);
    const snap=await ref.collection("positions").get();
    const toIso=v=>{
      if(v==null||v==="")return null;
      if(typeof v==="string")return v;
      if(typeof v==="number"&&Number.isFinite(v))return new Date(v).toISOString();
      if(v instanceof Date&&!Number.isNaN(v.getTime()))return v.toISOString();
      if(typeof v?.toDate==="function"){try{const d=v.toDate();if(d&&!Number.isNaN(d.getTime()))return d.toISOString()}catch(_){}}
      if(v._seconds!=null)return new Date(Number(v._seconds)*1000+(Number(v._nanoseconds||0)/1e6)).toISOString();
      if(v.seconds!=null)return new Date(Number(v.seconds)*1000+(Number(v.nanoseconds||0)/1e6)).toISOString();
      if(v.$date!=null)return new Date(v.$date).toISOString();
      return null;
    };
    const all=snap.docs.map(d=>{
      const p={id:d.id,...d.data(),name:MARKET_SYMBOLS[d.data()?.symbol]?.name||d.data()?.symbol};
      p.openedAt=toIso(p.openedAt); p.closedAt=toIso(p.closedAt); p.createdAt=toIso(p.createdAt); p.updatedAt=toIso(p.updatedAt);
      if(p.realizedPnl==null && p.pnl!=null) p.realizedPnl=Number(p.pnl);
      return p;
    });
    const open=all.filter(p=>p.status==="open");
    const pending=all.filter(p=>p.status==="pending");
    const closed=all.filter(p=>p.status==="closed").sort((a,b)=>{
      const at=Date.parse(a.closedAt||a.updatedAt||0)||0;
      const bt=Date.parse(b.closedAt||b.updatedAt||0)||0;
      return bt-at;
    });
    const symbols=[...new Set(open.map(p=>p.symbol).filter(Boolean))];
    if(symbols.length){
      try {
        const quotes=await getMarketQuotes(symbols);
        for(const p of open){
          p.currentPrice=Number(quotes[p.symbol]?.price||p.currentPrice||p.entryPrice||0);
          p.pnl=tradePnl(p, p.currentPrice);
        }
      } catch(e) {}
    }
    const rules = accountRules(latest);
    const starting = Number(latest.startingBalance ?? latest.accountSize ?? 0);
    const balance = Number(latest.balance ?? starting);
    const equity = Number(latest.equity ?? balance);
    res.json({
      account:{
        id: latest.accountId || data.accountId || "account",
        startingBalance: starting,
        balance,
        equity,
        pnl: Number(latest.pnl ?? (balance - starting)),
        openPnl: Number(latest.openPnl ?? 0),
        status: latest.status || "active",
        challenge: latest.challenge || data.challenge || "",
        challengeId: latest.challengeId || "",
        phase: latest.phase || latest.stage || "",
        funded: latest.funded === true,
        dailyDrawdownPct: Number(latest.dailyDrawdownPct || 0),
        maxDrawdownPct: Number(latest.maxDrawdownPct || 0),
        dailyDrawdownLimit: Number(latest.dailyDrawdownLimit ?? rules.dailyDrawdownPct ?? 4),
        maxDrawdownLimit: Number(latest.maxDrawdownLimit ?? rules.maxDrawdownPct ?? 8),
        dailyDrawdown: Number(latest.dailyDrawdown ?? rules.dailyDrawdownPct ?? 4),
        maxDrawdown: Number(latest.maxDrawdown ?? rules.maxDrawdownPct ?? 8),
        floatingLossHits: Number(latest.floatingLossHits || 0),
        floatingLossActive: latest.floatingLossActive === true,
        lastRiskWarning: latest.lastRiskWarning || "",
        riskWarning: latest.lastRiskWarning || "" 
      },
      open,pending,closed
    });
  } catch(e) {
    res.status(500).json({error:"Could not load trade history",detail:e.message||"Unknown error"});
  }
});

app.patch("/api/trading/positions/:id", requireTerminalAuth, async (req,res) => {
  try {
    if (req.terminal?.terminalRole !== "trader") return res.status(403).json({error:"Investor password is read-only. Use the trading password to close trades."});
    const {ref}=await loadTradingAccount(req.terminal.uid, req.terminal.accountId);
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



// Email OTP password reset. This changes only the Firebase Auth password;
// the user's UID, email, profile, trading data and account records remain untouched.
const PASSWORD_RESET_COLLECTION = "passwordResetOtps";
const PASSWORD_RESET_TTL_MS = 10 * 60 * 1000;
const PASSWORD_RESET_RESEND_COOLDOWN_MS = 60 * 1000;
const PASSWORD_RESET_MAX_ATTEMPTS = 5;

function passwordResetEmailKey(email) {
  return crypto.createHash("sha256").update(String(email).trim().toLowerCase()).digest("hex");
}

function passwordResetCodeHash(email, code) {
  const secret = process.env.RESEND_API_KEY || process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "password-reset-fallback";
  return crypto.createHmac("sha256", String(secret))
    .update(passwordResetEmailKey(email) + ":" + String(code))
    .digest("hex");
}

function generatePasswordResetCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

async function sendPasswordResetOtp(email, code) {
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured");
  const from = process.env.RESEND_FROM_EMAIL || "Aura Farming <onboarding@resend.dev>";
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: "Aura Farming password reset code",
      html: `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px;color:#111">
          <h2 style="margin:0 0 12px">Aura Farming</h2>
          <p>Use this verification code to reset your password:</p>
          <div style="font-size:32px;font-weight:700;letter-spacing:8px;padding:18px 0">${code}</div>
          <p style="color:#666">This code expires in 10 minutes and can be used only once.</p>
          <p style="color:#666">If you did not request a password reset, you can ignore this email.</p>
        </div>`
    })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error("RESEND_EMAIL_ERROR", response.status, detail);
    throw new Error("Could not send reset email");
  }
}

app.post("/api/auth/password-reset/request", async (req, res) => {
  try {
    initFirebase();
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Please enter a valid email address" });
    }

    // Do not reveal whether an account exists for a given email.
    let user;
    try {
      user = await admin.auth().getUserByEmail(email);
    } catch (e) {
      if (e?.code === "auth/user-not-found") {
        return res.json({ message: "If an account exists for this email, a verification code has been sent.", next: "verify" });
      }
      throw e;
    }

    const ref = db.collection(PASSWORD_RESET_COLLECTION).doc(passwordResetEmailKey(email));
    const existing = await ref.get();
    const existingData = existing.exists ? existing.data() : {};
    const lastSentAt = Number(existingData?.sentAt || 0);
    if (lastSentAt && Date.now() - lastSentAt < PASSWORD_RESET_RESEND_COOLDOWN_MS) {
      return res.status(429).json({ error: "Please wait a minute before requesting another code" });
    }

    const code = generatePasswordResetCode();
    await ref.set({
      uid: user.uid,
      email,
      codeHash: passwordResetCodeHash(email, code),
      createdAt: Date.now(),
      sentAt: Date.now(),
      expiresAt: Date.now() + PASSWORD_RESET_TTL_MS,
      attempts: 0
    });

    try {
      await sendPasswordResetOtp(email, code);
    } catch (emailError) {
      await ref.delete().catch(() => {});
      console.error("PASSWORD_RESET_EMAIL_ERROR", emailError);
      return res.status(502).json({ error: "Could not send the verification email. Please try again." });
    }

    res.json({ message: "If an account exists for this email, a verification code has been sent.", next: "verify" });
  } catch (e) {
    console.error("PASSWORD_RESET_REQUEST_ERROR", e);
    res.status(500).json({ error: "Could not start password reset" });
  }
});

app.post("/api/auth/password-reset/confirm", async (req, res) => {
  try {
    initFirebase();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const code = String(req.body?.code || "").trim();
    const password = String(req.body?.password || "");
    const confirmPassword = String(req.body?.confirmPassword || "");

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Please enter a valid email address" });
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: "Enter the 6-digit verification code" });
    if (password.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters" });
    if (password !== confirmPassword) return res.status(400).json({ error: "Passwords do not match" });

    const ref = db.collection(PASSWORD_RESET_COLLECTION).doc(passwordResetEmailKey(email));
    const snap = await ref.get();
    if (!snap.exists) return res.status(400).json({ error: "Invalid or expired verification code" });

    const data = snap.data() || {};
    if (Number(data.expiresAt || 0) < Date.now()) {
      await ref.delete().catch(() => {});
      return res.status(400).json({ error: "Verification code has expired. Request a new code." });
    }
    if (Number(data.attempts || 0) >= PASSWORD_RESET_MAX_ATTEMPTS) {
      await ref.delete().catch(() => {});
      return res.status(429).json({ error: "Too many incorrect attempts. Request a new code." });
    }

    const suppliedHash = passwordResetCodeHash(email, code);
    if (String(data.codeHash || "") !== suppliedHash) {
      await ref.update({ attempts: admin.firestore.FieldValue.increment(1) });
      return res.status(400).json({ error: "Invalid verification code" });
    }

    const user = await admin.auth().getUserByEmail(email);
    if (user.uid !== data.uid) return res.status(400).json({ error: "Invalid password reset request" });

    await admin.auth().updateUser(user.uid, { password });
    await admin.auth().revokeRefreshTokens(user.uid);
    await ref.delete();

    res.json({ message: "Password reset successfully. Please log in with your new password." });
  } catch (e) {
    console.error("PASSWORD_RESET_CONFIRM_ERROR", e);
    res.status(500).json({ error: "Could not reset password" });
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

function marketWsSubscribe(ws, symbol) {
  const clean = String(symbol || "").trim();
  if (!MARKET_SYMBOLS[clean]) return;
  for (const set of marketClients.values()) set.delete(ws);
  if (!marketClients.has(clean)) marketClients.set(clean, new Set());
  marketClients.get(clean).add(ws);
  ws.marketSymbol = clean;
}

async function broadcastMarketTick() {
  if (!marketClients.size) return;
  const symbols = [...marketClients.keys()];
  try {
    const quotes = await getMarketQuotes(symbols);
    for (const [symbol, clients] of marketClients) {
      const quote = quotes[symbol];
      if (!quote) continue;
      const payload = JSON.stringify({ type: "quote", quote });
      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(payload);
      }
    }
  } catch {}
}

function ensureMarketStream() {
  if (marketStreamTimer) return;
  marketStreamTimer = setInterval(() => {
    broadcastMarketTick().catch(() => {});
    if (!marketClients.size) {
      clearInterval(marketStreamTimer);
      marketStreamTimer = null;
    }
  }, 500);
}

async function verifyMarketSocket(req) {
  const url = new URL(req.url || "", "http://localhost");
  const token = url.searchParams.get("token") || "";
  if (!token) throw new Error("Terminal authentication required");
  const payload = verifyTerminalSessionToken(token);
  if (!payload.credentialId || !payload.accountId || !payload.uid || !["trader","investor"].includes(payload.role)) {
    throw new Error("Valid terminal credentials are required");
  }
  initFirebase();
  const credentialSnap = await db.collection("terminalCredentials").doc(String(payload.credentialId)).get();
  if (!credentialSnap.exists) throw new Error("Terminal credentials revoked");
  const credential = credentialSnap.data() || {};
  if (credential.status !== "active" || credential.userId !== payload.uid || credential.accountId !== payload.accountId) {
    throw new Error("Terminal credentials revoked");
  }
  return payload;
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

marketWss.on("connection", (ws) => {
  ws.on("message", raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "subscribe") marketWsSubscribe(ws, msg.symbol);
    } catch {}
  });
  ws.on("close", () => {
    for (const set of marketClients.values()) set.delete(ws);
    for (const [symbol, set] of marketClients) if (!set.size) marketClients.delete(symbol);
  });
});

httpServer.on("upgrade", async (req, socket, head) => {
  try {
    const url = new URL(req.url || "", "http://localhost");
    if (url.pathname === "/ws/market") {
      await verifyMarketSocket(req);
      marketWss.handleUpgrade(req, socket, head, ws => {
        marketWss.emit("connection", ws, req);
      });
      ensureMarketStream();
      return;
    }
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
