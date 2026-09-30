import { readFileSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";
import admin from "firebase-admin";
import { getMongoDb, closeMongoDb } from "./mongodb.js";

const path = new URL("./server.js", import.meta.url);
let source = readFileSync(path, "utf8");

const mongoImport = 'import { getMongoDb } from "./mongodb.js";';
if (!source.includes(mongoImport)) {
  const anchor = 'import { fileURLToPath } from "node:url";';
  if (!source.includes(anchor)) throw new Error("Mongo import anchor not found");
  source = source.replace(anchor, anchor + "\n" + mongoImport, 1);
}

function replaceBetween(startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(label + " start not found");
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(label + " end not found");
  source = source.slice(0, start) + replacement + source.slice(end);
}

const challengePaymentRoute = `app.post("/api/challenge-payments", requireAuth, upload.single("screenshot"), async (req,res)=>{
  try {
    initFirebase();
    const mongo = await getMongoDb();
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
      return res.status(400).json({ error:"Payment amount does not match selected currency price", expectedAmount, receivedAmount:amount, currency });
    }

    const duplicate = await mongo.collection("payments").findOne({ transactionId });
    if (duplicate) {
      if (String(duplicate.userId) === String(req.user.uid) && duplicate.type === "challenge" && duplicate.challengeId === challengeId) {
        return res.status(200).json({
          id:String(duplicate._id), status:duplicate.status || "pending",
          message:duplicate.status === "approved" ? "This payment was already approved." : duplicate.status === "rejected" ? "This payment was already rejected." : "Payment already submitted. It is waiting for admin review."
        });
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
          await file.save(req.file.buffer, { resumable:false, metadata:{ contentType:req.file.mimetype, metadata:{firebaseStorageDownloadTokens:screenshotToken} } });
          screenshotUrl = "https://firebasestorage.googleapis.com/v0/b/" + encodeURIComponent(bucket.name) + "/o/" + encodeURIComponent(screenshotPath) + "?alt=media&token=" + encodeURIComponent(screenshotToken);
        } catch (storageError) {
          console.warn("Payment screenshot Storage upload failed; using Mongo fallback:", storageError?.message || storageError);
          screenshotPath = "";
        }
      }
      if (!screenshotUrl) {
        if (req.file.buffer.length > 650000) return res.status(400).json({ error:"Payment screenshot could not be uploaded. Please choose a smaller screenshot and try again." });
        screenshotUrl = "data:" + req.file.mimetype + ";base64," + req.file.buffer.toString("base64");
      }
    }

    const id = crypto.randomUUID();
    await mongo.collection("payments").insertOne({
      _id:id, userId:req.user.uid, userEmail:req.user.email || "", type:"challenge", challengeId,
      challengeModel:challenge.model, challengeSize:challenge.size, accountSize:Number(challenge.accountSize),
      courseId:"", courseTitle:"Aura Farming " + challenge.model + " " + challenge.size,
      method, currency, transactionId, amount, screenshotUrl, screenshotPath,
      status:"pending", submittedAt:new Date(), reviewedAt:null, reviewedBy:null
    });

    res.status(201).json({ id, status:"pending", message:"Challenge payment submitted for verification" });
  } catch(e) {
    console.error("CHALLENGE_PAYMENT_MONGO_ERROR", e);
    res.status(500).json({ error:"Could not submit challenge payment", detail:e?.message || "Unknown server error" });
  }
});

`;
replaceBetween('app.post("/api/challenge-payments"', 'app.get("/api/challenge-payments/my"', challengePaymentRoute, "challenge payment route");

const challengeMyRoute = `app.get("/api/challenge-payments/my", requireAuth, async (req,res)=>{
  try {
    const mongo = await getMongoDb();
    const payments = await mongo.collection("payments").find({ userId:req.user.uid, type:"challenge" }).sort({submittedAt:-1}).toArray();
    res.json({payments:payments.map(({_id,...p})=>({id:String(_id),...p}))});
  } catch(e) {
    res.status(500).json({error:"Could not load challenge payments", detail:e?.message || "Unknown server error"});
  }
});

`;
replaceBetween('app.get("/api/challenge-payments/my"', 'app.get("/api/payment-settings"', challengeMyRoute, "challenge payment history route");

const coursePaymentRoute = `app.post("/api/payments", requireAuth, upload.single("screenshot"), async (req, res) => {
  try {
    initFirebase();
    const mongo = await getMongoDb();
    const { courseId, method = "UPI", transactionId } = req.body;
    const amount = positiveAmount(req.body.amount);
    if (!courseId || !transactionId || amount === null) return res.status(400).json({ error:"courseId, transactionId and a valid amount are required" });

    const course = await db.collection("courses").doc(courseId).get();
    if (!course.exists) return res.status(404).json({ error:"Course not found" });
    const courseData = course.data();
    if (courseData.published !== true) return res.status(400).json({ error:"Course is not available for purchase" });
    if (Math.abs(Number(courseData.price || 0) - amount) > 0.01) return res.status(400).json({ error:"Payment amount does not match the course price" });

    const normalizedTransactionId = String(transactionId).trim();
    const duplicate = await mongo.collection("payments").findOne({ transactionId:normalizedTransactionId });
    if (duplicate) return res.status(409).json({ error:"This transaction/reference ID was already submitted" });

    let screenshotUrl = "";
    let screenshotPath = "";
    if (req.file && bucket) {
      const safe = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      screenshotPath = "payment-proofs/" + req.user.uid + "/" + Date.now() + "-" + safe;
      const file = bucket.file(screenshotPath);
      await file.save(req.file.buffer, { metadata:{ contentType:req.file.mimetype } });
      const [signedUrl] = await file.getSignedUrl({ action:"read", expires:Date.now()+7*24*60*60*1000 });
      screenshotUrl = signedUrl;
    } else if (req.file) {
      if (req.file.buffer.length > 650000) return res.status(400).json({error:"Payment screenshot could not be uploaded. Please choose a smaller screenshot and try again."});
      screenshotUrl = "data:" + req.file.mimetype + ";base64," + req.file.buffer.toString("base64");
    }

    const id = crypto.randomUUID();
    await mongo.collection("payments").insertOne({
      _id:id, userId:req.user.uid, userEmail:req.user.email || "", type:"course", courseId,
      courseTitle:courseData.title || "", method:String(method), transactionId:normalizedTransactionId,
      amount, screenshotUrl, screenshotPath, status:"pending", submittedAt:new Date(), reviewedAt:null, reviewedBy:null
    });
    res.status(201).json({ id, status:"pending", message:"Payment submitted for verification" });
  } catch (e) {
    console.error("COURSE_PAYMENT_MONGO_ERROR", e);
    res.status(500).json({ error:"Could not submit payment", detail:e?.message || "Unknown server error" });
  }
});

`;
replaceBetween('app.post("/api/payments"', 'app.get("/api/payments/my"', coursePaymentRoute, "course payment route");

const paymentsMyRoute = `app.get("/api/payments/my", requireAuth, async (req, res) => {
  try {
    const mongo = await getMongoDb();
    const payments = await mongo.collection("payments").find({userId:req.user.uid}).sort({submittedAt:-1}).toArray();
    res.json({payments:payments.map(({_id,...p})=>({id:String(_id),...p}))});
  } catch (e) {
    res.status(500).json({ error:"Could not load payments", detail:e?.message || "Unknown server error" });
  }
});

`;
replaceBetween('app.get("/api/payments/my"', 'app.get("/api/admin/courses"', paymentsMyRoute, "payment history route");

const adminStatsRoute = `app.get("/api/admin/stats", requireAuth, requireAdmin, async (req, res) => {
  try {
    initFirebase();
    const mongo = await getMongoDb();
    const [coursesSnap, authPage, payments] = await Promise.all([
      db.collection("courses").get(),
      admin.auth().listUsers(1000),
      mongo.collection("payments").find({}).toArray()
    ]);
    res.json({
      courses:coursesSnap.size,
      publishedCourses:coursesSnap.docs.filter(d=>d.data().published===true).length,
      users:authPage.users.length,
      payments:payments.length,
      pendingPayments:payments.filter(p=>p.status==="pending").length,
      approvedPayments:payments.filter(p=>p.status==="approved").length,
      rejectedPayments:payments.filter(p=>p.status==="rejected").length,
      approvedRevenue:payments.filter(p=>p.status==="approved").reduce((sum,p)=>sum+Number(p.amount||0),0)
    });
  } catch(e) {
    res.status(500).json({error:"Could not load admin stats", detail:e?.message || "Unknown server error"});
  }
});

`;
replaceBetween('app.get("/api/admin/stats"', 'app.get("/api/admin/users"', adminStatsRoute, "admin stats route");

const adminPaymentRoutes = `app.get("/api/admin/payments", requireAuth, requireAdmin, async (req, res) => {
  try {
    initFirebase();
    const mongo = await getMongoDb();
    const docs = await mongo.collection("payments").find({}).sort({submittedAt:-1}).toArray();
    const payments = [];
    for (const d of docs) {
      const p = {...d, id:String(d._id)};
      delete p._id;
      if (p.screenshotPath && bucket) {
        try {
          const [url] = await bucket.file(p.screenshotPath).getSignedUrl({action:"read", expires:Date.now()+60*60*1000});
          p.screenshotUrl = url;
        } catch {}
      }
      payments.push(p);
    }
    res.json({payments});
  } catch(e) {
    console.error("ADMIN_PAYMENT_QUEUE_MONGO_ERROR", e);
    res.status(500).json({error:"Could not load payment queue", detail:e?.message || "Unknown server error"});
  }
});

app.patch("/api/admin/payments/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    initFirebase();
    const mongo = await getMongoDb();
    const status = req.body.status;
    if (!["approved","rejected"].includes(status)) return res.status(400).json({error:"Status must be approved or rejected"});

    const ref = mongo.collection("payments");
    const payment = await ref.findOne({_id:String(req.params.id)});
    if (!payment) return res.status(404).json({error:"Payment not found"});
    if (payment.status === status) return res.json({message:"Payment already "+status});
    if (payment.status !== "pending") return res.status(409).json({error:"Only pending payments can be reviewed"});

    if (status === "approved") {
      if (payment.type === "challenge") {
        const catalog = await getChallengeCatalog();
        if (!catalog.find(x=>x.id===payment.challengeId)) return res.status(400).json({error:"Challenge is no longer available"});
      } else {
        const course = await db.collection("courses").doc(payment.courseId).get();
        if (!course.exists || course.data().published !== true) return res.status(400).json({error:"Course is no longer available"});
      }
    }

    const reviewedAt = new Date();
    const update = {status, reviewedAt, reviewedBy:req.user.uid};
    if (status === "approved" && payment.type === "challenge") {
      const accountRef = db.collection("users").doc(payment.userId).collection("trading").doc("account");
      const catalog = await getChallengeCatalog();
      const challenge = catalog.find(x=>x.id===payment.challengeId);
      const accountId = "AF-ACC-" + new Date().getFullYear() + "-" + crypto.randomBytes(4).toString("hex").toUpperCase();
      await accountRef.set({accountId,startingBalance:Number(challenge.accountSize),balance:Number(challenge.accountSize),equity:Number(challenge.accountSize),pnl:0,currency:"USD",challenge:challenge.model+" "+challenge.size,challengeId:challenge.id,sourcePaymentId:String(req.params.id),status:"active",createdAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()});
      const credentialBundle = await createTerminalCredentials(accountRef,payment.userId,{accountId,status:"active"});
      await db.collection("users").doc(payment.userId).collection("challengeAccounts").doc(accountId).set({accountId,paymentId:String(req.params.id),challengeId:challenge.id,model:challenge.model,size:challenge.size,accountSize:Number(challenge.accountSize),status:"active",terminalCredentialId:credentialBundle.id,createdAt:admin.firestore.FieldValue.serverTimestamp()});
      await db.collection("users").doc(payment.userId).collection("tradingAccounts").doc(accountId).set({accountId,startingBalance:Number(challenge.accountSize),balance:Number(challenge.accountSize),equity:Number(challenge.accountSize),pnl:0,currency:"USD",challenge:challenge.model+" "+challenge.size,challengeId:challenge.id,sourcePaymentId:String(req.params.id),status:"active",terminalCredentialId:credentialBundle.id,createdAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()});
      update.accountId = accountId;
      update.terminalCredentialId = credentialBundle.id;
      if (credentialBundle.credentials) {
        update.terminalLoginId = credentialBundle.credentials.loginId;
        update.terminalCredentialsIssued = true;
      }
    } else if (status === "approved") {
      await db.collection("users").doc(payment.userId).collection("courses").doc(payment.courseId).set({courseId:payment.courseId,paymentId:String(req.params.id),grantedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
    }

    await ref.updateOne({_id:String(req.params.id),status:"pending"},{$set:update});
    res.json({message:"Payment "+status});
  } catch(e) {
    console.error("ADMIN_PAYMENT_REVIEW_MONGO_ERROR", e);
    res.status(500).json({error:"Could not review payment", detail:e?.message || "Unknown server error"});
  }
});

`;
replaceBetween('app.get("/api/admin/payments"', 'app.post("/api/admin/trading-accounts/:uid/breach"', adminPaymentRoutes, "admin payment routes");

writeFileSync(path, source);

console.log("ADMIN_PAYMENT_STORAGE=MONGODB");
await closeMongoDb();
