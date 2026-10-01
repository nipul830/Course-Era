import { readFileSync, writeFileSync } from "node:fs";

const target = new URL("./server.js", import.meta.url);
let source = readFileSync(target, "utf8");

const mongoImport = 'import { getMongoDb } from "./mongodb.js";';
if (!source.includes(mongoImport)) {
  const marker = 'import { fileURLToPath } from "node:url";';
  if (!source.includes(marker)) throw new Error("Could not find server import marker");
  source = source.replace(marker, marker + "\n" + mongoImport);
}

const startMarker = 'app.post("/api/challenge-payments"';
const endMarker = 'app.get("/api/challenge-payments/my"';
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);
if (start < 0) throw new Error("Challenge payment POST route not found");
if (end < 0) throw new Error("Challenge payment history route not found");

const route = `/* CHALLENGE_PAYMENT_MONGO_ROUTE_V3 */
app.post("/api/challenge-payments", requireAuth, upload.single("screenshot"), async (req, res) => {
  try {
    const mongo = await getMongoDb();
    const challengeId = String(req.body?.challengeId || "").trim();
    const transactionId = String(req.body?.transactionId || "").trim();
    const method = String(req.body?.method || "UPI").trim().toUpperCase();
    const currency = String(req.body?.currency || "INR").trim().toUpperCase();
    const amount = positiveAmount(req.body?.amount);

    if (!challengeId || !transactionId || amount === null) {
      return res.status(400).json({ error: "challengeId, transactionId and valid amount are required" });
    }
    if (!["INR", "USDT"].includes(currency)) {
      return res.status(400).json({ error: "Currency must be INR or USDT" });
    }

    const catalog = await getChallengeCatalog();
    const challenge = catalog.find(x => x.id === challengeId);
    if (!challenge) return res.status(404).json({ error: "Challenge not found" });

    const discountPercent = Math.min(100, Math.max(0, Number(challenge.discountPercent) || 0));
    const discountedPrice = Math.round(Number(challenge.price) * (1 - discountPercent / 100) * 100) / 100;
    const expectedAmount = currency === "INR" ? Math.round(discountedPrice * 98) : discountedPrice;
    if (Math.abs(expectedAmount - amount) > 0.01) {
      return res.status(400).json({
        error: "Payment amount does not match selected currency price",
        expectedAmount,
        receivedAmount: amount,
        currency
      });
    }

    const payments = mongo.collection("payments");
    const duplicate = await payments.findOne({ transactionId });
    if (duplicate) {
      if (String(duplicate.userId) === String(req.user.uid) && duplicate.type === "challenge" && duplicate.challengeId === challengeId) {
        return res.status(200).json({
          id: String(duplicate._id),
          status: duplicate.status || "pending",
          message: duplicate.status === "approved"
            ? "This payment was already approved."
            : duplicate.status === "rejected"
              ? "This payment was already rejected."
              : "Payment already submitted. It is waiting for admin review."
        });
      }
      return res.status(409).json({ error: "This transaction/reference ID was already submitted" });
    }

    let screenshotUrl = "";
    let screenshotPath = "";
    if (req.file) {
      if (!String(req.file.mimetype || "").startsWith("image/")) {
        return res.status(400).json({ error: "Payment screenshot must be an image" });
      }
      if (req.file.buffer.length > 650000) {
        return res.status(400).json({ error: "Payment screenshot could not be uploaded. Please choose a smaller screenshot and try again." });
      }
      screenshotUrl = "data:" + req.file.mimetype + ";base64," + req.file.buffer.toString("base64");
    }

    const id = crypto.randomUUID();
    await payments.insertOne({
      _id: id,
      userId: req.user.uid,
      userEmail: req.user.email || "",
      type: "challenge",
      challengeId,
      challengeModel: challenge.model,
      challengeSize: challenge.size,
      accountSize: Number(challenge.accountSize),
      courseId: "",
      courseTitle: "Aura Farming " + challenge.model + " " + challenge.size,
      method,
      currency,
      transactionId,
      amount,
      screenshotUrl,
      screenshotPath,
      status: "pending",
      submittedAt: new Date(),
      reviewedAt: null,
      reviewedBy: null
    });

    res.status(201).json({
      id,
      status: "pending",
      message: "Challenge payment submitted for verification"
    });
  } catch (e) {
    console.error("CHALLENGE_PAYMENT_MONGO_ERROR", e);
    res.status(500).json({
      error: "Could not submit challenge payment",
      detail: e?.message || "Unknown server error"
    });
  }
});

`;

source = source.slice(0, start) + route + source.slice(end);
writeFileSync(target, source);
console.log("CHALLENGE_PAYMENT_MONGO_ROUTE_V3=APPLIED");
