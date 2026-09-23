import express from "express";
import cors from "cors";
import multer from "multer";
import admin from "firebase-admin";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

app.use(cors({ origin: process.env.FRONTEND_ORIGIN ? process.env.FRONTEND_ORIGIN.split(",") : true }));
app.use(express.json({ limit: "1mb" }));

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
  if (process.env.FIREBASE_STORAGE_BUCKET) bucket = admin.storage().bucket();
}

async function requireAuth(req, res, next) {
  try {
    initFirebase();
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) return res.status(401).json({ error: "Authentication required" });
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
    const allowed = (process.env.ADMIN_EMAILS || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
    if (req.user?.admin === true || (email && allowed.includes(email))) return next();
    return res.status(403).json({ error: "Admin access required" });
  } catch {
    res.status(500).json({ error: "Admin authorization failed" });
  }
}

function cleanId(value) {
  return String(value || "").toLowerCase().trim().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

app.get("/health", (req, res) => res.json({ ok: true, service: "Course Era API", time: new Date().toISOString() }));

app.get("/api/config", (req, res) => res.json({
  siteName: "Course Era",
  status: "backend-ready",
  firebase: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS)
}));

app.get("/api/courses", async (req, res) => {
  try {
    initFirebase();
    const snap = await db.collection("courses").where("published", "==", true).get();
    const courses = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ courses });
  } catch (e) {
    res.status(500).json({ error: "Could not load courses", detail: e.message });
  }
});

app.post("/api/courses", requireAuth, requireAdmin, async (req, res) => {
  try {
    initFirebase();
    const { title, description = "", price = 0, thumbnail = "", videoUrl = "", published = true } = req.body;
    if (!title) return res.status(400).json({ error: "Course title is required" });
    const id = cleanId(req.body.id || title);
    await db.collection("courses").doc(id).set({
      title, description, price: Number(price), thumbnail, videoUrl,
      published: Boolean(published), createdAt: admin.firestore.FieldValue.serverTimestamp(),
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
    await db.collection("courses").doc(req.params.id).set({
      ...req.body,
      price: Number(req.body.price || 0),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
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
    const { courseId, method = "UPI", transactionId, amount } = req.body;
    if (!courseId || !transactionId || !amount) return res.status(400).json({ error: "courseId, transactionId and amount are required" });
    const course = await db.collection("courses").doc(courseId).get();
    if (!course.exists) return res.status(404).json({ error: "Course not found" });

    let screenshotUrl = "";
    if (req.file && bucket) {
      const safe = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = "payment-proofs/" + req.user.uid + "/" + Date.now() + "-" + safe;
      const file = bucket.file(path);
      await file.save(req.file.buffer, { metadata: { contentType: req.file.mimetype } });
      await file.makePublic();
      screenshotUrl = file.publicUrl();
    }

    const ref = db.collection("payments").doc();
    await ref.set({
      userId: req.user.uid,
      userEmail: req.user.email || "",
      courseId,
      courseTitle: course.data().title || "",
      method,
      transactionId: String(transactionId).trim(),
      amount: Number(amount),
      screenshotUrl,
      status: "pending",
      submittedAt: admin.firestore.FieldValue.serverTimestamp(),
      reviewedAt: null,
      reviewedBy: null
    });
    res.status(201).json({ id: ref.id, status: "pending", message: "Payment submitted for verification" });
  } catch (e) {
    res.status(500).json({ error: "Could not submit payment", detail: e.message });
  }
});

app.get("/api/payments/my", requireAuth, async (req, res) => {
  try {
    initFirebase();
    const snap = await db.collection("payments").where("userId", "==", req.user.uid).get();
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
    if (!["approved", "rejected"].includes(status)) return res.status(400).json({ error: "Status must be approved or rejected" });
    const ref = db.collection("payments").doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "Payment not found" });
    const payment = snap.data();

    await ref.update({
      status,
      reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
      reviewedBy: req.user.uid
    });

    if (status === "approved") {
      await db.collection("users").doc(payment.userId).collection("courses").doc(payment.courseId).set({
        courseId: payment.courseId,
        paymentId: req.params.id,
        grantedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    res.json({ message: "Payment " + status });
  } catch (e) {
    res.status(500).json({ error: "Could not review payment", detail: e.message });
  }
});

app.get("/api/my-courses", requireAuth, async (req, res) => {
  try {
    initFirebase();
    const snap = await db.collection("users").doc(req.user.uid).collection("courses").get();
    const courses = [];
    for (const d of snap.docs) {
      const c = await db.collection("courses").doc(d.id).get();
      if (c.exists) courses.push({ id: c.id, ...c.data(), grantedAt: d.data().grantedAt || null });
    }
    res.json({ courses });
  } catch (e) {
    res.status(500).json({ error: "Could not load your courses", detail: e.message });
  }
});

app.get("/api/courses/:id/access", requireAuth, async (req, res) => {
  try {
    initFirebase();
    const grant = await db.collection("users").doc(req.user.uid).collection("courses").doc(req.params.id).get();
    if (!grant.exists) return res.status(403).json({ error: "Course access not granted" });
    const course = await db.collection("courses").doc(req.params.id).get();
    if (!course.exists) return res.status(404).json({ error: "Course not found" });
    res.json({ access: true, course: { id: course.id, ...course.data() } });
  } catch (e) {
    res.status(500).json({ error: "Could not verify course access", detail: e.message });
  }
});

app.listen(PORT, () => console.log("Course Era API running on port " + PORT));
