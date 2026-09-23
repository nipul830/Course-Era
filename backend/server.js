import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import admin from "firebase-admin";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }
});

const allowedOrigins = (process.env.FRONTEND_ORIGIN || "")
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);

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

app.get("/api/courses", requireAuth, async (req, res) => {
  try {
    initFirebase();
    let snap = await db.collection("courses")
      .where("published", "==", true)
      .get();

    if (snap.empty) {
      const defaults = [
        { id: "trading-foundation", title: "Trading Foundation", description: "Market structure, risk management, chart reading and trading psychology.", price: 4999, thumbnail: "", videoUrl: "", published: true },
        { id: "price-action", title: "Price Action Mastery", description: "Structured price-action concepts, setups and trade planning.", price: 6999, thumbnail: "", videoUrl: "", published: true },
        { id: "indicator-pro", title: "Indicator Pro", description: "Understand indicators, confirmation and practical chart workflows.", price: 2999, thumbnail: "", videoUrl: "", published: true }
      ];
      const batch = db.batch();
      defaults.forEach(c => {
        const ref = db.collection("courses").doc(c.id);
        batch.set(ref, {
          ...c,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      });
      await batch.commit();
      snap = await db.collection("courses").where("published", "==", true).get();
    }

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

      screenshotUrl = file.publicUrl();
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

app.get("/api/admin/payments", requireAuth, requireAdmin, async (req, res) => {
  try {
    initFirebase();

    const snap = await db.collection("payments").get();
    const payments = snap.docs.map(d => ({ id: d.id, ...d.data() }));

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

app.listen(PORT, () => {
  console.log("Course Era API running on port " + PORT);
});
