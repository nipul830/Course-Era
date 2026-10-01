import "dotenv/config";
import { getMongoDb } from "./mongodb.js";

export const CHALLENGE_RULES = Object.freeze({
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

const n = (v, d = 0) => Number.isFinite(Number(v)) ? Number(v) : d;
const model = a => String(a.model || a.challengeModel || a.accountModel || "").toLowerCase();
const funded = a => a.funded === true || /funded/i.test(String(a.stage || a.phase || ""));
const phase = a => funded(a) ? "Funded" : /phase\s*2|step\s*2/i.test(String(a.phase || a.stage || "")) ? "Phase 2" : "Phase 1";
const dayStart = () => {
  const now = new Date();
  const ist = new Date(now.getTime() + 330 * 60000);
  ist.setUTCHours(0, 30, 0, 0);
  if (ist.getTime() > now.getTime() + 330 * 60000) ist.setUTCDate(ist.getUTCDate() - 1);
  return new Date(ist.getTime() - 330 * 60000);
};
const dayKey = d => d.toISOString().slice(0, 10);
const rules = a => ({ ...CHALLENGE_RULES, ...(a.challengeRules || a.rules || {}) });

async function evaluate(col, doc) {
  const a = { ...doc };
  if (!a.accountId || String(a.status || "active") === "deleted") return;
  const r = rules(a);
  const size = Math.max(0, n(a.accountSize, n(a.startingBalance, n(a.balance))));
  const balance = n(a.balance, n(a.startingBalance, size));
  const equity = n(a.equity, balance + n(a.openPnl));
  const start = dayStart();
  const key = dayKey(start);
  const set = { challengeRules: CHALLENGE_RULES };
  if (!a.staticDrawdownBase) set.staticDrawdownBase = n(a.startingBalance, size);
  if (!a.phaseStartBalance) set.phaseStartBalance = balance;
  if (!a.dailyDayKey || a.dailyDayKey !== key) {
    set.dailyDayKey = key;
    set.dailyStartBalance = balance;
    set.dailyStartEquity = equity;
    set.dailyStartAt = start;
  }

  const dailyStart = n(a.dailyStartEquity, n(a.dailyStartBalance, balance));
  const staticBase = n(a.staticDrawdownBase, n(a.startingBalance, size));
  if (dailyStart > 0 && equity <= dailyStart * (1 - r.dailyLoss)) {
    set.status = "breached";
    set.breachReason = "Daily loss limit 4%";
    set.breachedAt = new Date();
    set.breachDeleteAt = new Date(Date.now() + r.breachRetentionDays * 86400000);
  } else if (staticBase > 0 && equity <= staticBase * (1 - r.staticDrawdown)) {
    set.status = "breached";
    set.breachReason = "Static drawdown limit 10%";
    set.breachedAt = new Date();
    set.breachDeleteAt = new Date(Date.now() + r.breachRetentionDays * 86400000);
  }

  const floatingHit = size > 0 && n(a.openPnl) <= -(size * r.floatingLoss);
  let hits = n(a.floatingLossHits);
  if (floatingHit && !a.floatingLossActive) {
    hits += 1;
    set.floatingLossHits = hits;
    set.floatingLossActive = true;
    set.lastFloatingLossAt = new Date();
    set.lastFloatingLossWarning = `1% floating loss hit #${hits}`;
    if (funded(a) && hits === 2) set.profitSplitPercent = r.fundedSecondHitProfitSplit;
    const limit = funded(a) ? r.fundedFloatingHitsToBreach : r.phaseFloatingHitsToBreach;
    if (hits >= limit) {
      set.status = "breached";
      set.breachReason = `1% floating loss hit ${hits} time(s)`;
      set.breachedAt = new Date();
      set.breachDeleteAt = new Date(Date.now() + r.breachRetentionDays * 86400000);
    }
  } else if (!floatingHit && a.floatingLossActive) set.floatingLossActive = false;

  const days = Array.isArray(a.tradingDays) ? [...a.tradingDays] : [];
  const dailyProfit = size > 0 ? (balance - n(a.dailyStartBalance, balance)) / size : 0;
  if (dailyProfit >= r.minDailyProfit && !days.includes(key)) days.push(key);
  set.tradingDays = days;
  set.tradingDaysCount = days.length;

  const currentPhase = phase(a);
  const target = currentPhase === "Phase 2" ? r.phase2Target : r.phase1Target;
  const phaseStart = n(a.phaseStartBalance, balance);
  const phaseProfit = size > 0 ? (balance - phaseStart) / size : 0;
  set.phaseProgressPercent = Math.min(100, Math.max(0, (phaseProfit / target) * 100));

  if (String(set.status || a.status || "active") === "active" && phaseProfit >= target && !funded(a)) {
    const requiredDays = currentPhase === "Phase 2" ? r.phase2Days : r.phase1Days;
    if (days.length >= requiredDays && days.length >= r.minTradingDays) {
      if (currentPhase === "Phase 1" && /2\s*step|two\s*step/i.test(model(a))) {
        set.phase = "Phase 2";
        set.stage = "Phase 2";
        set.phaseStartBalance = balance;
        set.tradingDays = [];
        set.tradingDaysCount = 0;
        set.phaseProgressPercent = 0;
      } else {
        set.phase = "Funded";
        set.stage = "Funded";
        set.funded = true;
        set.fundedAt = new Date();
        set.phaseStartBalance = balance;
        set.tradingDays = [];
        set.tradingDaysCount = 0;
      }
    }
  }
  await col.updateOne({ _id: doc._id }, { $set: set });
}

async function cleanup(col) {
  const now = new Date();
  const old = await col.find({ status: "breached", breachDeleteAt: { $lte: now } }).toArray();
  for (const a of old) await col.deleteOne({ _id: a._id });
}

async function tick() {
  try {
    const db = await getMongoDb();
    const names = ["tradingAccounts", "challengeAccounts", "accounts", "challenge_accounts"];
    for (const name of names) {
      const col = db.collection(name);
      const docs = await col.find({ accountId: { $exists: true } }).toArray();
      for (const doc of docs) {
        try { await evaluate(col, doc); } catch (e) { console.error("CHALLENGE_RULE_ERROR", name, doc._id, e?.message || e); }
      }
      await cleanup(col);
    }
  } catch (e) { console.error("CHALLENGE_ENGINE_ERROR", e?.message || e); }
}

setTimeout(() => { tick(); setInterval(tick, 5000); }, 1500);
