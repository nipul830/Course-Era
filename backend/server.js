import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import admin from "firebase-admin";
import crypto from "node:crypto";
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

function initFirebase() {
  if (admin.apps.length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (raw) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(raw)),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || undefined
    });
  } else {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || undefined
    });
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

app.get("/api/profile", requireAuth, async (req, res) => {
  try {
    initFirebase();
    const snap = await db.collection("users").doc(req.user.uid).get();
    const d = snap.exists ? snap.data() : {};
    res.json({
      name: req.user.name || d.name || "",
      email: req.user.email || "",
      mobile: d.mobile || "",
      photoURL: req.user.picture || d.photoURL || ""
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
    const photoURL = String(req.body.photoURL || "").trim().slice(0, 1000);
    if (!name) return res.status(400).json({ error: "Name is required" });
    if (mobile && !/^[0-9+()\-\s]{7,20}$/.test(mobile)) {
      return res.status(400).json({ error: "Enter a valid mobile number" });
    }
    await db.collection("users").doc(req.user.uid).set({
      name, mobile,
      ...(photoURL ? { photoURL } : {}),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    await admin.auth().updateUser(req.user.uid, {
      displayName: name,
      ...(photoURL ? { photoURL } : {})
    });
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

app.get("/api/payment-settings", requireAuth, async (req, res) => {
  try {
    initFirebase();
    const snap = await db.collection("settings").doc("payment").get();
    const d = snap.exists ? snap.data() : {};
    res.json({ settings: {
      googlePayUpi: d.googlePayUpi || "lipupoddar-3@okaxis",
      phonePeUpi: d.phonePeUpi || "nipukumar007@ibl",
      merchantName: d.merchantName || "Course Era",
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
    const merchantName = clean(req.body.merchantName) || "Course Era";
    const qrUpi = clean(req.body.qrUpi) || googlePayUpi;
    const usdtWallet = clean(req.body.usdtWallet);
    const qrImageUrl = clean(req.body.qrImageUrl);
    if (!googlePayUpi || !phonePeUpi || !qrUpi) {
      return res.status(400).json({ error: "Google Pay, PhonePe and QR UPI IDs are required" });
    }
    await db.collection("settings").doc("payment").set({
      googlePayUpi, phonePeUpi, merchantName, qrUpi, usdtWallet, qrImageUrl,
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
      const course = await db.collection("courses").doc(payment.courseId).get();
      if (!course.exists || course.data().published !== true) {
        return res.status(400).json({ error: "Course is no longer available" });
      }
    }

    await ref.update({
      status,
      reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
      reviewedBy: req.user.uid
    });

    if (status === "approved") {
      await db.collection("users")
        .doc(payment.userId)
        .collection("courses")
        .doc(payment.courseId)
        .set({
          courseId: payment.courseId,
          paymentId: req.params.id,
          grantedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    }

    res.json({ message: "Payment " + status });
  } catch (e) {
    res.status(500).json({ error: "Could not review payment", detail: e.message });
  }
});

app.get("/api/trading-account", requireAuth, async (req, res) => {
  try {
    initFirebase();

    const accountRef = db.collection("users").doc(req.user.uid).collection("trading").doc("account");
    const existing = await accountRef.get();

    if (existing.exists) {
      const account = existing.data() || {};
      return res.json({
        account: {
          id: "account",
          startingBalance: Number(account.startingBalance || 0),
          balance: Number(account.balance ?? account.startingBalance ?? 0),
          equity: Number(account.equity ?? account.balance ?? account.startingBalance ?? 0),
          pnl: Number(account.pnl ?? ((account.balance ?? 0) - (account.startingBalance ?? 0))),
          currency: account.currency || "USD",
          challenge: account.challenge || "Funded Account",
          sourcePaymentId: account.sourcePaymentId || ""
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
      startingBalance,
      balance: startingBalance,
      equity: startingBalance,
      pnl: 0,
      currency: "USD",
      challenge: course.title || "Funded Account",
      sourcePaymentId: payment.id,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await accountRef.create(account);

    res.json({
      account: {
        id: "account",
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
          id: "account",
          startingBalance: Number(account.startingBalance || 0),
          balance: Number(account.balance ?? account.startingBalance ?? 0),
          equity: Number(account.equity ?? account.balance ?? account.startingBalance ?? 0),
          pnl: Number(account.pnl ?? 0),
          currency: account.currency || "USD",
          challenge: account.challenge || "Funded Account",
          sourcePaymentId: account.sourcePaymentId || ""
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
        id: "account",
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
