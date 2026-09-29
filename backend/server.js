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
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendEmail } from "./email.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

const PORT = Number(process.env.PORT || 3000);
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
const FIREBASE_STORAGE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET;

let firebaseInitialized = false;
let db;
let bucket;

function initFirebase() {
  if (firebaseInitialized) return;
  if (!FIREBASE_SERVICE_ACCOUNT) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not configured");
  const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount), storageBucket: FIREBASE_STORAGE_BUCKET });
  db = admin.firestore();
  bucket = admin.storage().bucket();
  firebaseInitialized = true;
}

async function getChallengeCatalog() {
  const snap = await db.collection("challenges").where("active", "==", true).get();
  return snap.docs.map(d => ({ id:d.id, ...d.data() }));
}

async function createTerminalCredentials(accountRef, userId, data) {
  const id = "TC-" + crypto.randomBytes(6).toString("hex").toUpperCase();
  const loginId = "AF" + crypto.randomBytes(5).toString("hex").toUpperCase();
  const password = crypto.randomBytes(12).toString("base64url");
  const credentialRef = db.collection("terminalCredentials").doc(id);
  await credentialRef.set({ id, userId, accountId:data.accountId, loginId, passwordHash:crypto.createHash("sha256").update(password).digest("hex"), status:data.status, createdAt:admin.firestore.FieldValue.serverTimestamp() });
  return { id, credentials:{ loginId, password } };
}

// Existing middleware and routes remain unchanged above this point.

app.get("/api/admin/payments", async (req, res, next) => next());

app.patch("/api/admin/payments/:id", async (req, res) => {
  try {
    initFirebase();
    const status = req.body.status;
    if (!["approved", "rejected"].includes(status)) return res.status(400).json({ error:"Status must be approved or rejected" });
    const ref = db.collection("payments").doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error:"Payment not found" });
    const payment = snap.data();
    if (payment.status === status) return res.json({ message:"Payment already " + status });
    if (payment.status !== "pending") return res.status(409).json({ error:"Only pending payments can be reviewed" });

    if (status === "approved") {
      if (payment.type === "challenge") {
        const catalog = await getChallengeCatalog();
        const challenge = catalog.find(x => x.id === payment.challengeId);
        if (!challenge) return res.status(400).json({ error:"Challenge is no longer available" });
      } else {
        const course = await db.collection("courses").doc(payment.courseId).get();
        if (!course.exists || course.data().published !== true) return res.status(400).json({ error:"Course is no longer available" });
      }
    }

    await ref.update({ status, reviewedAt:admin.firestore.FieldValue.serverTimestamp(), reviewedBy:req.user.uid });

    if (status === "approved" && payment.type === "challenge") {
      const accountRef = db.collection("users").doc(payment.userId).collection("trading").doc("account");
      const catalog = await getChallengeCatalog();
      const challenge = catalog.find(x => x.id === payment.challengeId);
      const accountId = "AF-ACC-" + new Date().getFullYear() + "-" + crypto.randomBytes(4).toString("hex").toUpperCase();
      await accountRef.set({ accountId, startingBalance:Number(challenge.accountSize), balance:Number(challenge.accountSize), equity:Number(challenge.accountSize), pnl:0, currency:"USD", challenge:challenge.model+" "+challenge.size, challengeId:challenge.id, sourcePaymentId:req.params.id, status:"active", createdAt:admin.firestore.FieldValue.serverTimestamp(), updatedAt:admin.firestore.FieldValue.serverTimestamp() });
      const credentialBundle = await createTerminalCredentials(accountRef, payment.userId, { accountId, status:"active" });
      await db.collection("users").doc(payment.userId).collection("challengeAccounts").doc(accountId).set({ accountId, paymentId:req.params.id, challengeId:challenge.id, model:challenge.model, size:challenge.size, accountSize:Number(challenge.accountSize), status:"active", terminalCredentialId:credentialBundle.id, createdAt:admin.firestore.FieldValue.serverTimestamp() });
      await ref.update({ accountId, terminalCredentialId:credentialBundle.id, ...(credentialBundle.credentials ? { terminalLoginId:credentialBundle.credentials.loginId } : {}) });
      if (credentialBundle.credentials) await ref.update({ terminalCredentialsIssued:true });

      const userSnap = await db.collection("users").doc(payment.userId).get();
      const userData = userSnap.exists ? userSnap.data() : {};
      const email = payment.email || payment.userEmail || userData.email;
      if (email) {
        await sendEmail({
          to: email,
          subject: "Aura Farming — Challenge Account Approved",
          html: `<div style="font-family:Arial,sans-serif;line-height:1.6"><h2>Challenge Approved</h2><p>Your Aura Farming challenge has been approved and your trading account has been created.</p><p><b>Challenge:</b> ${challenge.model} ${challenge.size}<br><b>Account ID:</b> ${accountId}<br><b>Starting Balance:</b> $${Number(challenge.accountSize).toLocaleString()}</p><p>Your terminal login ID is <b>${credentialBundle.credentials?.loginId || "available in your dashboard"}</b>.</p><p>For security, your terminal password is not included in email. Please use your secure dashboard to access or manage credentials.</p></div>`
        });
      }
    } else if (status === "approved") {
      await db.collection("users").doc(payment.userId).collection("courses").doc(payment.courseId).set({ courseId:payment.courseId, paymentId:req.params.id, grantedAt:admin.firestore.FieldValue.serverTimestamp() }, { merge:true });
    }

    res.json({ message:"Payment " + status });
  } catch (e) {
    res.status(500).json({ error:"Could not review payment", detail:e.message });
  }
});

