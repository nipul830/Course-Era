import { readFileSync, writeFileSync } from "node:fs";

const target = "/root/Course-Era/backend/server.js";
let source = readFileSync(target, "utf8");

if (source.includes('app.post("/api/auth/password-reset/request"')) {
  console.log("Password reset routes already present; nothing to patch.");
  process.exit(0);
}

const marker = 'app.post("/api/terminal/login", terminalLoginRateLimit, async (req, res) => {';
if (!source.includes(marker)) throw new Error("Could not find safe insertion point in server.js");

const block = String.raw`
const PASSWORD_RESET_CODE_TTL_MS = 10 * 60 * 1000;
const PASSWORD_RESET_RESEND_MS = 60 * 1000;
const PASSWORD_RESET_MAX_ATTEMPTS = 5;
const PASSWORD_RESET_REQUEST_LIMIT = 5;
const passwordResetRequestTimes = new Map();

function normalizeResetEmail(value) {
  return String(value || "").trim().toLowerCase().slice(0, 320);
}

function hashResetCode(code) {
  return crypto.createHash("sha256").update(String(code)).digest("hex");
}

function generateResetCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

function passwordResetFromEmail() {
  return String(process.env.RESEND_FROM_EMAIL || process.env.RESEND_FROM || "Aura Farming <noreply@aurafirming.in>").trim();
}

async function sendPasswordResetEmail({ to, code }) {
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured on the server");

  const from = passwordResetFromEmail();
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: "Aura Farming password reset code",
      html: `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto">
          <h2>Aura Farming</h2>
          <p>Use this verification code to reset your password:</p>
          <div style="font-size:32px;font-weight:700;letter-spacing:8px;padding:18px 0">${code}</div>
          <p>This code expires in 10 minutes.</p>
          <p>If you did not request a password reset, you can ignore this email.</p>
        </div>
      `
    })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error("Resend rejected the email request" + (detail ? ": " + detail.slice(0, 500) : ""));
  }
}

app.post("/api/auth/password-reset/request", async (req, res) => {
  try {
    initFirebase();
    const email = normalizeResetEmail(req.body?.email);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Enter a valid email address" });
    }

    const now = Date.now();
    const recent = passwordResetRequestTimes.get(email) || [];
    const validRecent = recent.filter(ts => now - ts < 15 * 60 * 1000);
    if (validRecent.length >= PASSWORD_RESET_REQUEST_LIMIT) {
      return res.status(429).json({ error: "Too many reset requests. Please try again later." });
    }
    if (validRecent.some(ts => now - ts < PASSWORD_RESET_RESEND_MS)) {
      return res.status(429).json({ error: "Please wait one minute before requesting another code." });
    }

    let user;
    try {
      user = await admin.auth().getUserByEmail(email);
    } catch {
      passwordResetRequestTimes.set(email, [...validRecent, now]);
      return res.json({ message: "If an account exists for this email, a verification code has been sent." });
    }

    const code = generateResetCode();
    const resetRef = db.collection("passwordResetCodes").doc(user.uid);
    await resetRef.set({
      uid: user.uid,
      email,
      codeHash: hashResetCode(code),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: new Date(now + PASSWORD_RESET_CODE_TTL_MS),
      attempts: 0,
      used: false
    });

    try {
      await sendPasswordResetEmail({ to: email, code });
    } catch (mailError) {
      await resetRef.delete().catch(() => {});
      console.error("PASSWORD_RESET_EMAIL_ERROR:", mailError?.message || mailError);
      return res.status(502).json({ error: "Could not send the verification email. Please try again." });
    }

    passwordResetRequestTimes.set(email, [...validRecent, now]);
    res.json({ message: "If an account exists for this email, a verification code has been sent." });
  } catch (e) {
    console.error("PASSWORD_RESET_REQUEST_ERROR:", e);
    res.status(500).json({ error: "Could not start password reset" });
  }
});

app.post("/api/auth/password-reset/confirm", async (req, res) => {
  try {
    initFirebase();
    const email = normalizeResetEmail(req.body?.email);
    const code = String(req.body?.code || "").trim();
    const password = String(req.body?.password || "");
    const confirmPassword = String(req.body?.confirmPassword || "");

    if (!email || !/^\d{6}$/.test(code)) return res.status(400).json({ error: "Enter the 6-digit verification code" });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
    if (password !== confirmPassword) return res.status(400).json({ error: "Passwords do not match" });

    const snap = await db.collection("passwordResetCodes").where("email", "==", email).limit(10).get();
    const doc = snap.docs
      .filter(d => d.data()?.used !== true)
      .sort((a, b) => Number(b.data()?.createdAt?.toMillis?.() || 0) - Number(a.data()?.createdAt?.toMillis?.() || 0))[0];
    if (!doc) return res.status(400).json({ error: "Invalid or expired verification code" });

    const data = doc.data() || {};
    const expiresAtMs = data.expiresAt?.toMillis?.() ?? new Date(data.expiresAt || 0).getTime();
    const attempts = Number(data.attempts || 0);
    if (!expiresAtMs || expiresAtMs < Date.now() || attempts >= PASSWORD_RESET_MAX_ATTEMPTS) {
      return res.status(400).json({ error: "Invalid or expired verification code" });
    }

    if (data.codeHash !== hashResetCode(code)) {
      await doc.ref.update({ attempts: attempts + 1 });
      return res.status(400).json({ error: attempts + 1 >= PASSWORD_RESET_MAX_ATTEMPTS ? "Too many incorrect attempts. Request a new code." : "Invalid verification code" });
    }

    await admin.auth().updateUser(data.uid, { password });
    await admin.auth().revokeRefreshTokens(data.uid);
    await doc.ref.update({ used: true, usedAt: admin.firestore.FieldValue.serverTimestamp() });

    res.json({ message: "Password reset successfully" });
  } catch (e) {
    console.error("PASSWORD_RESET_CONFIRM_ERROR:", e);
    res.status(500).json({ error: "Could not reset password" });
  }
});

`;

source = source.replace(marker, block + marker);
writeFileSync(target, source);
console.log("Password reset routes patched into server.js");
