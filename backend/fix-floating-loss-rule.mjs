import { readFileSync, writeFileSync } from "node:fs";

const target = new URL("./server.js", import.meta.url);
let source = readFileSync(target, "utf8");

const oldLimit = "const floatingLimit = starting > 0 ? starting * 0.01 : 0;";
const oldCheck = "if (floatingLimit > 0 && openPnl <= -floatingLimit && positions.length) {";
const oldReason = 'const reason = "1% floating loss limit";';

if (!source.includes(oldLimit) || !source.includes(oldCheck) || !source.includes(oldReason)) {
  if (source.includes("AURA_FLOATING_RULE_V4")) {
    console.log("FLOATING_RULE_V4_ALREADY_APPLIED=OK");
    process.exit(0);
  }
  throw new Error("Could not find the active V3 floating-loss block in server.js");
}

const helperMarker = "// AURA_FLOATING_RULE_V4";
const helper = `${helperMarker}
async function getAdminFloatingLossRule(account) {
  initFirebase();
  const snap = await db.collection("challengeRules").doc("global").get();
  const rules = snap.exists ? (snap.data()?.rules || {}) : {};
  const text = String(account.challenge || account.model || account.challengeModel || account.accountModel || "").toLowerCase();
  const modelName = /instant/.test(text) ? "Instant" : /2\\s*step|2step|two\\s*step/.test(text) ? "2 Step" : "1 Step";
  const stageText = String(account.stage || account.phase || account.statusStage || account.accountStage || "").toLowerCase();
  let stageName = /phase\\s*2|step\\s*2/.test(stageText) ? "Phase 2" : /funded/.test(stageText) ? "Funded" : "Phase 1";
  if (modelName === "Instant") stageName = "Funded";
  const rule = rules?.[modelName]?.[stageName];
  return {
    enabled: rule?.floatingLossEnabled === true,
    percent: Number.isFinite(Number(rule?.floatingLossPercent)) ? Number(rule.floatingLossPercent) : 1
  };
}
`;

if (!source.includes(helperMarker)) {
  const insertAt = source.indexOf("async function refreshTradingAccount");
  if (insertAt < 0) throw new Error("refreshTradingAccount not found");
  source = source.slice(0, insertAt) + helper + "\n" + source.slice(insertAt);
}

source = source.replace(
  oldLimit,
  'const floatingRule = await getAdminFloatingLossRule(data);\n  const floatingPercent = floatingRule.percent;\n  const floatingLimit = floatingRule.enabled && starting > 0 ? starting * (floatingPercent / 100) : 0;'
);
source = source.replace(
  oldCheck,
  "if (floatingRule.enabled && floatingLimit > 0 && openPnl <= -floatingLimit && positions.length) {"
);
source = source.replace(
  oldReason,
  'const reason = `${floatingPercent}% floating loss limit`;'
);
source = source.replaceAll(
  'First 1% floating-loss warning.',
  'First floating-loss warning.'
);
source = source.replaceAll(
  'Second 1% floating-loss warning. Profit split set to 70%.',
  'Second floating-loss warning. Profit split set to 70%.'
);

writeFileSync(target, source);
console.log("FLOATING_RULE_V4_APPLIED=OK");
console.log("FLOATING_RULE_SOURCE=FIRESTORE_ADMIN_CHALLENGE_RULES");
console.log("FLOATING_LOSS_OFF=ENFORCEMENT_DISABLED");
console.log("INSTANT_USES=INSTANT_FUNDED_RULE");
