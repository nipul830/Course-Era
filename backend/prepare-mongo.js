import { readFileSync, writeFileSync } from "node:fs";
import { getMongoDb } from "./mongodb.js";

const path = new URL("./server.js", import.meta.url);
let s = readFileSync(path, "utf8");

if (!s.includes('import { getMongoDb } from "./mongodb.js";')) {
  s = s.replace(
    'import { fileURLToPath } from "node:url";',
    'import { fileURLToPath } from "node:url";\nimport { getMongoDb } from "./mongodb.js";',
  );
}

const oldCatalog = `async function getChallengeCatalog() {
  initFirebase();
  const snap = await db.collection("settings").doc("challengeCatalog").get();
  const saved = snap.exists && Array.isArray(snap.data()?.items) ? snap.data().items : null;
  return saved && saved.length ? saved : DEFAULT_CHALLENGES;
}`;
const newCatalog = `async function getChallengeCatalog() {
  const mongo = await getMongoDb();
  const saved = await mongo.collection("settings").findOne({ _id: "challengeCatalog" });
  const items = saved && Array.isArray(saved.items) ? saved.items : null;
  return items && items.length ? items : DEFAULT_CHALLENGES;
}`;
if (s.includes(oldCatalog)) s = s.replace(oldCatalog, newCatalog);

const oldRulesGet = `app.get("/api/challenge-rules", async (req,res) => {
  try {
    initFirebase();
    const snap = await db.collection("settings").doc("challengeRules").get();
    const saved = snap.exists && snap.data()?.rules && typeof snap.data().rules === "object" ? snap.data().rules : null;
    res.json({ rules: saved || DEFAULT_CHALLENGE_RULES });
  } catch(e) {
    res.status(500).json({ error:"Could not load challenge rules" });
  }
});`;
const newRulesGet = `app.get("/api/challenge-rules", async (req,res) => {
  try {
    const mongo = await getMongoDb();
    const saved = await mongo.collection("settings").findOne({ _id: "challengeRules" });
    const rules = saved && saved.rules && typeof saved.rules === "object" ? saved.rules : null;
    res.json({ rules: rules || DEFAULT_CHALLENGE_RULES });
  } catch(e) {
    res.status(500).json({ error:"Could not load challenge rules" });
  }
});`;
if (s.includes(oldRulesGet)) s = s.replace(oldRulesGet, newRulesGet);

const oldRulesPut = `    initFirebase();
    const clean = v => String(v ?? "").trim().slice(0,300);`;
const rulesMarker = 'app.put("/api/challenge-rules", requireAuth, requireAdmin, async (req,res) => {';
const rulesPos = s.indexOf(rulesMarker);
if (rulesPos >= 0) {
  const pos = s.indexOf(oldRulesPut, rulesPos);
  if (pos >= 0) s = s.slice(0, pos) + '    const clean = v => String(v ?? "").trim().slice(0,300);' + s.slice(pos + oldRulesPut.length);
}

const oldRulesSet = `    await db.collection("settings").doc("challengeRules").set({
      rules,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: req.user.uid
    }, { merge:true });`;
const newRulesSet = `    const mongo = await getMongoDb();
    await mongo.collection("settings").updateOne(
      { _id: "challengeRules" },
      { $set: { rules, updatedAt: new Date(), updatedBy: req.user.uid } },
      { upsert: true }
    );`;
if (s.includes(oldRulesSet)) s = s.replace(oldRulesSet, newRulesSet);

const oldCatalogPut = `    initFirebase();
    if (!Array.isArray(req.body.challenges) || !req.body.challenges.length) {`;
const catalogMarker = 'app.put("/api/challenges", requireAuth, requireAdmin, async (req, res) => {';
const catalogPos = s.indexOf(catalogMarker);
if (catalogPos >= 0) {
  const pos = s.indexOf(oldCatalogPut, catalogPos);
  if (pos >= 0) s = s.slice(0, pos) + '    if (!Array.isArray(req.body.challenges) || !req.body.challenges.length) {' + s.slice(pos + oldCatalogPut.length);
}

const oldCatalogSet = `    await db.collection("settings").doc("challengeCatalog").set({
      items, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy:req.user.uid
    });`;
const newCatalogSet = `    const mongo = await getMongoDb();
    await mongo.collection("settings").updateOne(
      { _id: "challengeCatalog" },
      { $set: { items, updatedAt: new Date(), updatedBy: req.user.uid } },
      { upsert: true }
    );`;
if (s.includes(oldCatalogSet)) s = s.replace(oldCatalogSet, newCatalogSet);

writeFileSync(path, s);
const mongo = await getMongoDb();
await mongo.collection("settings").updateOne(
  { _id: "challengeCatalog" },
  { $setOnInsert: { items: [], createdAt: new Date() } },
  { upsert: true }
);
console.log("MongoDB challenge route preparation complete");
