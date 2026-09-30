import { readFileSync, writeFileSync } from "node:fs";
import { getMongoDb, closeMongoDb } from "./mongodb.js";

const path = new URL("./server.js", import.meta.url);
let s = readFileSync(path, "utf8");

const mongoImport = 'import { getMongoDb } from "./mongodb.js";';
if (!s.includes(mongoImport)) {
  const anchor = 'import { fileURLToPath } from "node:url";';
  if (!s.includes(anchor)) throw new Error("server.js import anchor not found");
  s = s.replace(anchor, anchor + "\n" + mongoImport, 1);
}

const mongoCatalogFn = `async function getChallengeCatalog() {
  const mongo = await getMongoDb();
  const docs = await mongo.collection("challenges").find({}).toArray();
  const items = docs
    .map(({ _id, ...item }) => item)
    .filter(x => x && x.id && x.model && Number.isFinite(Number(x.accountSize)) && Number.isFinite(Number(x.price)));
  if (items.length) return items;

  const saved = await mongo.collection("settings").findOne({ _id: "challengeCatalog" });
  const savedItems = saved && Array.isArray(saved.items) ? saved.items : null;
  return savedItems && savedItems.length ? savedItems : DEFAULT_CHALLENGES;
}`;

const catalogStart = s.indexOf("async function getChallengeCatalog() {");
const catalogEnd = catalogStart >= 0 ? s.indexOf("\n}\n\nconst DEFAULT_CHALLENGE_RULES", catalogStart) : -1;
if (catalogStart < 0 || catalogEnd < 0) throw new Error("challenge catalog function not found");
s = s.slice(0, catalogStart) + mongoCatalogFn + s.slice(catalogEnd + 2);

const rulesGetStart = s.indexOf('app.get("/api/challenge-rules"');
const rulesGetEnd = rulesGetStart >= 0 ? s.indexOf("\n});", rulesGetStart) + 3 : -1;
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
const rulesPutEnd = rulesPutStart >= 0 ? s.indexOf("\n});", rulesPutStart) + 3 : -1;
if (rulesPutStart < 0 || rulesPutEnd < 3) throw new Error("challenge rules PUT route not found");
const rulesPut = s.slice(rulesPutStart, rulesPutEnd)
  .replace(/\s*initFirebase\(\);/, "")
  .replace(
    /await db\.collection\("settings"\)\.doc\("challengeRules"\)\.set\(\{[\s\S]*?\n\s*\}, \{ merge:true \}\);/,
    `const mongo = await getMongoDb();
    await mongo.collection("settings").updateOne(
      { _id: "challengeRules" },
      { $set: { rules, updatedAt: new Date(), updatedBy: req.user.uid } },
      { upsert: true }
    );`
  );
s = s.slice(0, rulesPutStart) + rulesPut + s.slice(rulesPutEnd);

const catalogPutStart = s.indexOf('app.put("/api/challenges"');
const catalogPutEnd = catalogPutStart >= 0 ? s.indexOf("\n});", catalogPutStart) + 3 : -1;
if (catalogPutStart < 0 || catalogPutEnd < 3) throw new Error("challenge catalog PUT route not found");
const catalogPut = s.slice(catalogPutStart, catalogPutEnd)
  .replace(/\s*initFirebase\(\);/, "")
  .replace(
    /await db\.collection\("settings"\)\.doc\("challengeCatalog"\)\.set\(\{[\s\S]*?\n\s*\}\);/,
    `const mongo = await getMongoDb();
    const collection = mongo.collection("challenges");
    await collection.deleteMany({});
    if (items.length) {
      await collection.insertMany(items.map(item => ({ _id: item.id, ...item })));
    }`
  );
s = s.slice(0, catalogPutStart) + catalogPut + s.slice(catalogPutEnd);

writeFileSync(path, s);

// Seed/repair the Mongo challenge catalog so a fresh deploy is immediately usable.
const mongo = await getMongoDb();
const collection = mongo.collection("challenges");
const count = await collection.countDocuments();
if (!count) {
  const seed = [
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
  await collection.insertMany(seed.map(item => ({ _id: item.id, ...item })));
}

const verify = readFileSync(path, "utf8");
if (!verify.includes(mongoImport)) throw new Error("MongoDB import was not attached");
if (!verify.includes('mongo.collection("challenges").find({}).toArray()')) throw new Error("MongoDB challenge catalog GET was not attached");
if (!verify.includes('const mongo = await getMongoDb();')) throw new Error("MongoDB challenge routes were not attached");
console.log("MongoDB challenge routes ready; catalog documents=" + await collection.countDocuments());

// Close the MongoDB client so this one-time preparation script can exit cleanly.
await closeMongoDb();
