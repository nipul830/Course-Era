import { readFileSync, writeFileSync } from "node:fs";
import { getMongoDb } from "./mongodb.js";

const path = new URL("./server.js", import.meta.url);
let s = readFileSync(path, "utf8");

// Always attach the MongoDB driver before touching challenge routes.
if (!s.includes('import { getMongoDb } from "./mongodb.js";')) {
  const importAnchor = 'import { fileURLToPath } from "node:url";';
  if (!s.includes(importAnchor)) throw new Error("server.js import anchor not found");
  s = s.replace(importAnchor, importAnchor + '\nimport { getMongoDb } from "./mongodb.js";', 1);
}

const catalogStart = s.indexOf('async function getChallengeCatalog() {');
const catalogEnd = catalogStart >= 0 ? s.indexOf('\n}\n\nconst DEFAULT_CHALLENGE_RULES', catalogStart) : -1;
if (catalogStart < 0 || catalogEnd < 0) throw new Error("challenge catalog function not found");
s = s.slice(0, catalogStart) + `async function getChallengeCatalog() {
  const mongo = await getMongoDb();
  const saved = await mongo.collection("settings").findOne({ _id: "challengeCatalog" });
  const items = saved && Array.isArray(saved.items) ? saved.items : null;
  return items && items.length ? items : DEFAULT_CHALLENGES;
}` + s.slice(catalogEnd + 2);

const rulesGetStart = s.indexOf('app.get("/api/challenge-rules"');
const rulesGetEnd = rulesGetStart >= 0 ? s.indexOf('\n});', rulesGetStart) + 3 : -1;
if (rulesGetStart < 0 || rulesGetEnd < 3) throw new Error("challenge rules GET route not found");
s = s.slice(0, rulesGetStart) + `app.get("/api/challenge-rules", async (req,res) => {
  try {
    const mongo = await getMongoDb();
    const saved = await mongo.collection("settings").findOne({ _id: "challengeRules" });
    const rules = saved && saved.rules && typeof saved.rules === "object" ? saved.rules : null;
    res.json({ rules: rules || DEFAULT_CHALLENGE_RULES });
  } catch(e) {
    console.error("MONGO_CHALLENGE_RULES_GET:", e);
    res.status(500).json({ error:"Could not load challenge rules" });
  }
});` + s.slice(rulesGetEnd);

const rulesPutStart = s.indexOf('app.put("/api/challenge-rules"');
const rulesPutEnd = rulesPutStart >= 0 ? s.indexOf('\n});', rulesPutStart) + 3 : -1;
if (rulesPutStart < 0 || rulesPutEnd < 3) throw new Error("challenge rules PUT route not found");
const rulesPut = s.slice(rulesPutStart, rulesPutEnd)
  .replace(/\s*initFirebase\(\);/, "")
  .replace(/await db\.collection\("settings"\)\.doc\("challengeRules"\)\.set\(\{[\s\S]*?\n\s*\}, \{ merge:true \}\);/, `const mongo = await getMongoDb();
    await mongo.collection("settings").updateOne(
      { _id: "challengeRules" },
      { $set: { rules, updatedAt: new Date(), updatedBy: req.user.uid } },
      { upsert: true }
    );`);
s = s.slice(0, rulesPutStart) + rulesPut + s.slice(rulesPutEnd);

const catalogPutStart = s.indexOf('app.put("/api/challenges"');
const catalogPutEnd = catalogPutStart >= 0 ? s.indexOf('\n});', catalogPutStart) + 3 : -1;
if (catalogPutStart < 0 || catalogPutEnd < 3) throw new Error("challenge catalog PUT route not found");
const catalogPut = s.slice(catalogPutStart, catalogPutEnd)
  .replace(/\s*initFirebase\(\);/, "")
  .replace(/await db\.collection\("settings"\)\.doc\("challengeCatalog"\)\.set\(\{[\s\S]*?\n\s*\}\);/, `const mongo = await getMongoDb();
    await mongo.collection("settings").updateOne(
      { _id: "challengeCatalog" },
      { $set: { items, updatedAt: new Date(), updatedBy: req.user.uid } },
      { upsert: true }
    );`);
s = s.slice(0, catalogPutStart) + catalogPut + s.slice(catalogPutEnd);

writeFileSync(path, s);

// Fail the deployment instead of silently leaving Firebase-backed challenge routes.
const verify = readFileSync(path, "utf8");
if (!verify.includes('import { getMongoDb } from "./mongodb.js";')) throw new Error("MongoDB import was not attached");
if (!verify.includes('const saved = await mongo.collection("settings").findOne({ _id: "challengeCatalog" });')) throw new Error("MongoDB challenge catalog GET was not attached");
if (!verify.includes('const mongo = await getMongoDb();')) throw new Error("MongoDB challenge routes were not attached");

const mongo = await getMongoDb();
await mongo.collection("settings").updateOne(
  { _id: "challengeCatalog" },
  { $setOnInsert: { items: [], createdAt: new Date() } },
  { upsert: true }
);
console.log("MongoDB challenge route preparation complete");
