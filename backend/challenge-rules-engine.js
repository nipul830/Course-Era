import "dotenv/config";
import fs from "node:fs";
import admin from "firebase-admin";

const RULES = Object.freeze({
  phase1Target: 0.08,
  phase2Target: 0.06,
  minDailyProfit: 0.01,
  phase1Days: 3,
  phase2Days: 2,
  minTradingDays: 5,
  dailyLoss: 0.04,
  staticDrawdown: 0.10,
  floatingLoss: 0.01,
  phaseFloatingHitsToBreach: 2,
  fundedFloatingHitsToBreach: 3,
  fundedSecondHitProfitSplit: 70,
  breachRetentionDays: 7,
  resetHourIST: 6
});

function istDayStart(date = new Date()) {
  const shifted = new Date(date.getTime() + 330 * 60 * 1000);
  shifted.setUTCHours(0, 30, 0, 0);
  if (shifted.getTime() > date.getTime() + 330 * 60 * 1000) shifted.setUTCDate(shifted.getUTCDate() - 1);
  return new Date(shifted.getTime() - 330 * 60 * 1000);
}
function num(v, fallback = 0) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function pct(v) { return Number((v * 100).toFixed(4)); }
function serverTs() { return admin.firestore.FieldValue.serverTimestamp(); }
function rulesFor(a) {
  const r = a.challengeRules || a.rules || {};
  return {
    phase1Target: num(r.phase1Target, RULES.phase1Target), phase2Target: num(r.phase2Target, RULES.phase2Target),
    minDailyProfit: num(r.minDailyProfit, RULES.minDailyProfit), phase1Days: num(r.phase1Days, RULES.phase1Days),
    phase2Days: num(r.phase2Days, RULES.phase2Days), minTradingDays: num(r.minTradingDays, RULES.minTradingDays),
    dailyLoss: num(r.dailyLoss, RULES.dailyLoss), staticDrawdown: num(r.staticDrawdown, RULES.staticDrawdown),
    floatingLoss: num(r.floatingLoss, RULES.floatingLoss), phaseFloatingHitsToBreach: num(r.phaseFloatingHitsToBreach, RULES.phaseFloatingHitsToBreach),
    fundedFloatingHitsToBreach: num(r.fundedFloatingHitsToBreach, RULES.fundedFloatingHitsToBreach),
    fundedSecondHitProfitSplit: num(r.fundedSecondHitProfitSplit, RULES.fundedSecondHitProfitSplit),
    breachRetentionDays: num(r.breachRetentionDays, RULES.breachRetentionDays), resetHourIST: 6
  };
}
function modelOf(a) { return String(a.model || a.challengeModel || a.accountModel || "").toLowerCase().replace(/\s+/g, " "); }
function isFunded(a) { return String(a.stage || a.phase || "").toLowerCase() === "funded" || a.funded === true || String(a.status || "").toLowerCase() === "funded"; }
function phaseOf(a) {
  if (isFunded(a)) return "Funded";
  const p = String(a.phase || a.stage || "Phase 1");
  if (/phase\s*2/i.test(p) || /2/.test(p)) return "Phase 2";
  return "Phase 1";
}
function targetFor(a, r) { return phaseOf(a) === "Phase 2" ? r.phase2Target : r.phase1Target; }
function tradingDayKey(start) { return start.toISOString().slice(0, 10); }
function baseBalance(a) { return num(a.startingBalance, num(a.accountSize, num(a.balance))); }

async function init() {
  if (admin.apps.length) return admin.firestore();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const file = process.env.GOOGLE_APPLICATION_CREDENTIALS || "/etc/secrets/firebase-service-account.json";
  if (raw) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), storageBucket: process.env.FIREBASE_STORAGE_BUCKET || undefined });
  else {
    try { admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync(file, "utf8"))), storageBucket: process.env.FIREBASE_STORAGE_BUCKET || undefined }); }
    catch { admin.initializeApp({ credential: admin.credential.applicationDefault(), storageBucket: process.env.FIREBASE_STORAGE_BUCKET || undefined }); }
  }
  return admin.firestore();
}

async function evaluateAccount(db, ref, a) {
  if (!a || !a.accountId || String(a.status || "active") === "deleted") return;
  const r = rulesFor(a);
  const size = Math.max(0, num(a.accountSize, baseBalance(a)));
  const balance = num(a.balance, baseBalance(a));
  const equity = num(a.equity, balance + num(a.openPnl, 0));
  const dayStart = istDayStart();
  const key = tradingDayKey(dayStart);
  const updates = {};

  if (!a.challengeRules) updates.challengeRules = { ...RULES };
  if (!a.staticDrawdownBase) updates.staticDrawdownBase = baseBalance(a);
  if (!a.phaseStartBalance) updates.phaseStartBalance = balance;
  if (!a.phaseStartedAt) updates.phaseStartedAt = serverTs();
  if (!a.tradingDays) updates.tradingDays = [];
  if (!a.floatingLossHits) updates.floatingLossHits = 0;
  if (a.floatingLossActive == null) updates.floatingLossActive = false;
  if (!a.dailyStartAt || String(a.dailyDayKey || "") !== key) {
    updates.dailyDayKey = key;
    updates.dailyStartAt = dayStart;
    updates.dailyStartBalance = balance;
    updates.dailyStartEquity = equity;
    updates.dailyLossBreached = false;
  }

  const dailyStart = num(a.dailyStartEquity, num(a.dailyStartBalance, balance));
  const staticBase = num(a.staticDrawdownBase, baseBalance(a));
  const dailyLossHit = dailyStart > 0 && equity <= dailyStart * (1 - r.dailyLoss);
  const staticHit = staticBase > 0 && equity <= staticBase * (1 - r.staticDrawdown);
  if (dailyLossHit || staticHit) {
    updates.status = "breached";
    updates.breachReason = dailyLossHit ? "Daily loss limit 4%" : "Static drawdown limit 10%";
    updates.breachedAt = serverTs();
    updates.breachDeleteAt = new Date(Date.now() + r.breachRetentionDays * 86400000);
  }

  const floatingThreshold = size * r.floatingLoss;
  const floatingHit = num(a.openPnl, 0) <= -floatingThreshold && floatingThreshold > 0;
  let hits = num(a.floatingLossHits, 0);
  if (floatingHit && !a.floatingLossActive) {
    hits += 1;
    updates.floatingLossHits = hits;
    updates.floatingLossActive = true;
    updates.lastFloatingLossAt = serverTs();
    updates.lastFloatingLossWarning = `1% floating loss hit #${hits}`;
    const funded = isFunded(a);
    const limit = funded ? r.fundedFloatingHitsToBreach : r.phaseFloatingHitsToBreach;
    if (funded && hits === 2) updates.profitSplitPercent = r.fundedSecondHitProfitSplit;
    if (hits >= limit) {
      updates.status = "breached";
      updates.breachReason = `1% floating loss hit ${hits} time(s)`;
      updates.breachedAt = serverTs();
      updates.breachDeleteAt = new Date(Date.now() + r.breachRetentionDays * 86400000);
    }
  } else if (!floatingHit && a.floatingLossActive) {
    updates.floatingLossActive = false;
  }

  const currentPhase = phaseOf(a);
  const phaseStart = num(a.phaseStartBalance, balance);
  const phaseProfit = size > 0 ? (balance - phaseStart) / size : 0;
  const dailyProfit = size > 0 ? (balance - num(a.dailyStartBalance, balance)) / size : 0;
  const days = Array.isArray(a.tradingDays) ? [...a.tradingDays] : [];
  if (dailyProfit >= r.minDailyProfit && !days.includes(key)) days.push(key);
  updates.tradingDays = days;
  updates.tradingDaysCount = days.length;
  updates.phaseProgressPercent = pct(Math.max(0, phaseProfit / Math.max(targetFor(a, r), 0.0001)));

  if (String(updates.status || a.status || "active") === "active" && phaseProfit >= targetFor(a, r) && !isFunded(a)) {
    const qualifying = currentPhase === "Phase 2" ? r.phase2Days : r.phase1Days;
    if (days.length >= qualifying && days.length >= r.minTradingDays) {
      const model = modelOf(a);
      if (currentPhase === "Phase 1" && model.includes("2 step")) {
        updates.phase = "Phase 2";
        updates.stage = "Phase 2";
        updates.phaseStartBalance = balance;
        updates.phaseStartedAt = serverTs();
        updates.tradingDays = [];
        updates.tradingDaysCount = 0;
        updates.phaseProgressPercent = 0;
      } else {
        updates.phase = "Funded";
        updates.stage = "Funded";
        updates.funded = true;
        updates.status = "active";
        updates.fundedAt = serverTs();
        updates.phaseStartBalance = balance;
        updates.tradingDays = [];
        updates.tradingDaysCount = 0;
      }
    }
  }

  if (Object.keys(updates).length) await ref.set({ ...updates, rulesUpdatedAt: serverTs() }, { merge: true });
}

async function cleanupBreached(db) {
  const snap = await db.collectionGroup("tradingAccounts").where("status", "==", "breached").get();
  const now = Date.now();
  for (const d of snap.docs) {
    const a = d.data() || {};
    const deleteAt = a.breachDeleteAt?.toDate?.()?.getTime?.() || (a.breachDeleteAt?._seconds ? Number(a.breachDeleteAt._seconds) * 1000 : 0);
    if (deleteAt && deleteAt <= now) {
      await d.ref.delete();
      if (a.terminalCredentialId) await db.collection("terminalCredentials").doc(String(a.terminalCredentialId)).set({ status: "revoked", revokedReason: "Account auto-deleted after 7 days", revokedAt: serverTs() }, { merge: true });
    }
  }
}

async function tick() {
  try {
    const db = await init();
    const snap = await db.collectionGroup("tradingAccounts").get();
    for (const d of snap.docs) {
      try { await evaluateAccount(db, d.ref, d.data() || {}); } catch (e) { console.error("CHALLENGE_RULE_ERROR", d.id, e?.message || e); }
    }
    await cleanupBreached(db);
  } catch (e) { console.error("CHALLENGE_ENGINE_ERROR", e?.message || e); }
}

setTimeout(() => { tick(); setInterval(tick, 5000); }, 1500);
export { RULES };
