import "dotenv/config";
import express from "express";
import admin from "firebase-admin";
import { readFileSync } from "node:fs";
import { getMongoDb } from "./mongodb.js";

export const CHALLENGE_RULES = Object.freeze({
  phase1Target: 0.08, phase2Target: 0.06, minDailyProfit: 0.01,
  phase1Days: 3, phase2Days: 2, minTradingDays: 5,
  dailyLoss: 0.04, staticDrawdown: 0.10, floatingLoss: 0.01,
  phaseFloatingHitsToBreach: 2, fundedFloatingHitsToBreach: 3,
  fundedSecondHitProfitSplit: 70, breachRetentionDays: 7, resetHourIST: 6
});

const n = (v,d=0) => Number.isFinite(Number(v)) ? Number(v) : d;
const model = a => String(a.model || a.challengeModel || a.accountModel || "").toLowerCase();
const funded = a => a.funded === true || /funded/i.test(String(a.stage || a.phase || ""));
const phase = a => funded(a) ? "Funded" : /phase\s*2|step\s*2/i.test(String(a.phase || a.stage || "")) ? "Phase 2" : "Phase 1";

let firebaseReady = false;
let adminRulesCache = null;
let adminRulesCacheAt = 0;
const ADMIN_RULES_CACHE_MS = 10000;

function initFirebaseForRiskMonitor() {
  if (firebaseReady || admin.apps.length) { firebaseReady = true; return; }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const file = process.env.GOOGLE_APPLICATION_CREDENTIALS || "/etc/secrets/firebase-service-account.json";
  try {
    if (raw) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
    else admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(file, "utf8"))) });
    firebaseReady = true;
  } catch (e) { console.error("FLOATING_RISK_FIREBASE_INIT_ERROR", e?.message || e); }
}

function primaryAdmin(req) {
  const email = String(req.user?.email || "").toLowerCase();
  const allowed = (process.env.ADMIN_EMAILS || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
  return req.user?.admin === true || (email && (email === "lipupoddar@gmail.com" || allowed.includes(email)));
}

async function verifyAdmin(req, res, next) {
  try {
    initFirebaseForRiskMonitor();
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) return res.status(401).json({ error: "Authentication required" });
    req.user = await admin.auth().verifyIdToken(header.slice(7));
    if (!primaryAdmin(req)) return res.status(403).json({ error: "Admin access required" });
    next();
  } catch { return res.status(401).json({ error: "Invalid or expired Firebase ID token" }); }
}

function normalizeRuleStage(value, stage) {
  let raw = value;
  if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { raw = {}; } }
  raw = raw && typeof raw === "object" ? raw : {};
  return {
    stage: String(raw.stage || stage),
    floatingLossEnabled: raw.floatingLossEnabled !== false,
    floatingLossPercent: Math.min(2.5, Math.max(0.25, n(raw.floatingLossPercent, 1))),
    minimumTradingDays: Math.min(10, Math.max(0, Math.round(n(raw.minimumTradingDays, 5))))
  };
}

function normalizeRulesPayload(input) {
  const source = input && typeof input === "object" ? input : {};
  const models = { "1 Step":["Phase 1","Funded"], "2 Step":["Phase 1","Phase 2","Funded"], "Instant":["Funded"] };
  const out = {};
  for (const [name, stages] of Object.entries(models)) {
    out[name] = {};
    for (const stage of stages) {
      const modelData = source[name] || {};
      let value;
      if (Array.isArray(modelData)) {
        value = modelData.find(v => {
          if (v && typeof v === "object") return String(v.stage || "") === stage;
          try { return JSON.parse(v)?.stage === stage; } catch { return false; }
        });
      } else value = modelData[stage];
      out[name][stage] = normalizeRuleStage(value, stage);
    }
  }
  return out;
}

async function getStoredChallengeRules(force = false) {
  initFirebaseForRiskMonitor();
  if (!firebaseReady) return {};
  if (!force && adminRulesCache && Date.now() - adminRulesCacheAt < ADMIN_RULES_CACHE_MS) return adminRulesCache;
  const snap = await admin.firestore().collection("challengeRules").doc("global").get();
  adminRulesCache = snap.exists ? (snap.data()?.rules || {}) : {};
  adminRulesCacheAt = Date.now();
  return adminRulesCache;
}

function ruleModelName(account) {
  const m = model(account);
  if (/2\s*step|two\s*step|2step/.test(m)) return "2 Step";
  if (/1\s*step|one\s*step|1step/.test(m)) return "1 Step";
  if (/instant/.test(m)) return "Instant";
  return "";
}

function storedStageRule(stored, account) {
  const name = ruleModelName(account), stageName = phase(account);
  const config = name && stored?.[name]?.[stageName] ? stored[name][stageName] : null;
  return config ? normalizeRuleStage(config, stageName) : null;
}

async function effectiveRules(account) {
  const stored = await getStoredChallengeRules();
  const stageRule = storedStageRule(stored, account);
  if (!stageRule) return { ...CHALLENGE_RULES };
  return { ...CHALLENGE_RULES, floatingLoss: stageRule.floatingLossPercent / 100, floatingLossEnabled: stageRule.floatingLossEnabled, minTradingDays: stageRule.minimumTradingDays };
}

const rules = a => ({ ...CHALLENGE_RULES, ...(a.challengeRules || a.rules || {}) });
const dayStart = () => {
  const now = new Date(), ist = new Date(now.getTime()+330*60000);
  ist.setUTCHours(0,30,0,0);
  if (ist.getTime() > now.getTime()+330*60000) ist.setUTCDate(ist.getUTCDate()-1);
  return new Date(ist.getTime()-330*60000);
};
const dayKey = d => d.toISOString().slice(0,10);

async function evaluate(col, doc) {
  const a = { ...doc };
  if (!a.accountId || String(a.status || "active") === "deleted") return;
  const r = await effectiveRules(a), size = Math.max(0,n(a.accountSize,n(a.startingBalance,n(a.balance))));
  const balance = n(a.balance,n(a.startingBalance,size)), equity = n(a.equity,balance+n(a.openPnl));
  const start = dayStart(), key = dayKey(start), set = { challengeRules: r };
  if (!a.staticDrawdownBase) set.staticDrawdownBase=n(a.startingBalance,size);
  if (!a.phaseStartBalance) set.phaseStartBalance=balance;
  if (!a.dailyDayKey || a.dailyDayKey!==key) { set.dailyDayKey=key; set.dailyStartBalance=balance; set.dailyStartEquity=equity; set.dailyStartAt=start; }

  const dailyStart=n(a.dailyStartEquity,n(a.dailyStartBalance,balance)), staticBase=n(a.staticDrawdownBase,n(a.startingBalance,size));
  if (dailyStart>0 && equity<=dailyStart*(1-r.dailyLoss)) { set.status="breached"; set.breachReason="Daily loss limit 4%"; set.breachedAt=new Date(); set.breachDeleteAt=new Date(Date.now()+r.breachRetentionDays*86400000); }
  else if (staticBase>0 && equity<=staticBase*(1-r.staticDrawdown)) { set.status="breached"; set.breachReason="Static drawdown limit 10%"; set.breachedAt=new Date(); set.breachDeleteAt=new Date(Date.now()+r.breachRetentionDays*86400000); }

  const floatingHit=r.floatingLossEnabled !== false && size>0 && n(a.openPnl)<=-(size*r.floatingLoss);
  let hits=n(a.floatingLossHits);
  if (floatingHit && !a.floatingLossActive) {
    hits++; set.floatingLossHits=hits; set.floatingLossActive=true; set.lastFloatingLossAt=new Date(); set.lastFloatingLossWarning=`${(r.floatingLoss*100).toFixed(2)}% floating loss hit #${hits}`;
    if (funded(a) && hits===2) set.profitSplitPercent=r.fundedSecondHitProfitSplit;
    const limit=funded(a)?r.fundedFloatingHitsToBreach:r.phaseFloatingHitsToBreach;
    if (hits>=limit) { set.status="breached"; set.breachReason=`${(r.floatingLoss*100).toFixed(2)}% floating loss hit ${hits} time(s)`; set.breachedAt=new Date(); set.breachDeleteAt=new Date(Date.now()+r.breachRetentionDays*86400000); }
  } else if (!floatingHit && a.floatingLossActive) set.floatingLossActive=false;

  if (/instant/i.test(model(a)) && !funded(a)) { set.phase="Funded"; set.stage="Funded"; set.funded=true; set.fundedAt=new Date(); set.status="active"; }

  const days=Array.isArray(a.tradingDays)?[...a.tradingDays]:[], totalDays=Array.isArray(a.totalTradingDays)?[...a.totalTradingDays]:[];
  const dailyProfit=size>0?(balance-n(a.dailyStartBalance,balance))/size:0;
  if (dailyProfit>=r.minDailyProfit) { if(!days.includes(key)) days.push(key); if(!totalDays.includes(key)) totalDays.push(key); }
  set.tradingDays=days; set.tradingDaysCount=days.length; set.totalTradingDays=totalDays; set.totalTradingDaysCount=totalDays.length;

  const currentPhase=phase(a), target=currentPhase==="Phase 2"?r.phase2Target:r.phase1Target, phaseStart=n(a.phaseStartBalance,balance), phaseProfit=size>0?(balance-phaseStart)/size:0;
  set.phaseProgressPercent=Math.min(100,Math.max(0,(phaseProfit/target)*100));
  if(String(set.status||a.status||"active")==="active" && phaseProfit>=target && !funded(a)) {
    const requiredDays=currentPhase==="Phase 2"?r.phase2Days:r.phase1Days;
    if(days.length>=requiredDays && totalDays.length>=r.minTradingDays) {
      if(currentPhase==="Phase 1" && /2\s*step|two\s*step/i.test(model(a))) { set.phase="Phase 2"; set.stage="Phase 2"; set.phaseStartBalance=balance; set.tradingDays=[]; set.tradingDaysCount=0; set.phaseProgressPercent=0; }
      else { set.phase="Funded"; set.stage="Funded"; set.funded=true; set.fundedAt=new Date(); set.status="active"; set.phaseStartBalance=balance; set.tradingDays=[]; set.tradingDaysCount=0; set.phaseProgressPercent=100; }
    }
  }
  await col.updateOne({_id:doc._id},{$set:set});
}

async function cleanup(col) { const old=await col.find({status:"breached",breachDeleteAt:{$lte:new Date()}}).toArray(); for(const a of old) await col.deleteOne({_id:a._id}); }

const MARKET = {
  "OANDA:XAUUSD": { code:"XAUUSD", contractSize:100 }, "FX:EURUSD": { code:"EURUSD", contractSize:100000 }, "FX:GBPUSD": { code:"GBPUSD", contractSize:100000 }, "FX:USDJPY": { code:"USDJPY", contractSize:100000, jpy:true }, "FX:AUDUSD": { code:"AUDUSD", contractSize:100000 },
  "BINANCE:BTCUSDT": { code:"BTCUSD", contractSize:1 }, "BINANCE:ETHUSDT": { code:"ETHUSD", contractSize:1 }, "BINANCE:SOLUSDT": { code:"SOLUSD", contractSize:1 }, "BINANCE:XRPUSDT": { code:"XRPUSD", contractSize:1 },
  "INDEX:NAS100": { code:"INDEX:NAS100", contractSize:1 }, "INDEX:DEX40": { code:"INDEX:DEX40", contractSize:1 }, "INDEX:US30": { code:"INDEX:US30", contractSize:1 }, "OIL:USOIL": { code:"USOIL", contractSize:1 }, "NASDAQ:AAPL": { code:"AAPL", contractSize:1 }, "NASDAQ:NVDA": { code:"NVDA", contractSize:1 }
};

async function livePrice(symbol) {
  const spec=MARKET[symbol]; if(!spec) return null;
  const r=await fetch("https://biquote.io/api/"+encodeURIComponent(spec.code),{headers:{Accept:"application/json",User-Agent:"AuraFarming-Risk/1.0"}}); if(!r.ok) return null;
  const d=await r.json(), p=Number(d.mid||d.price||d.ask||d.bid); return Number.isFinite(p)&&p>0?p:null;
}
function positionPnl(p, price) {
  const spec=MARKET[p.symbol], entry=n(p.entryPrice), lot=n(p.lot); if(!spec || !entry || !price || !lot) return 0;
  let v=(String(p.side).toUpperCase()==="BUY" ? price-entry : entry-price)*lot*spec.contractSize; if(spec.jpy) v/=price; return Number.isFinite(v)?v:0;
}

async function closeFloatingLossAccounts() {
  try {
    initFirebaseForRiskMonitor(); if (!firebaseReady) return;
    const db=admin.firestore(), accounts=await db.collectionGroup("trading").where("status","==","active").get();
    for (const accountDoc of accounts.docs) {
      const account=accountDoc.data()||{}, size=Math.max(0,n(account.startingBalance,n(account.accountSize,n(account.balance)))); if (!size || accountDoc.id!=="account") continue;
      const accountRules = await effectiveRules(account), posSnap=await accountDoc.ref.collection("positions").where("status","==","open").get();
      if (posSnap.empty) { if (account.floatingLossActive) await accountDoc.ref.update({floatingLossActive:false}); continue; }
      const symbols=[...new Set(posSnap.docs.map(d=>d.data()?.symbol).filter(Boolean))], prices={};
      await Promise.all(symbols.map(async s=>{ prices[s]=await livePrice(s); }));
      const positions=posSnap.docs.map(d=>({id:d.id,...d.data()})); if (symbols.some(s=>!Number.isFinite(Number(prices[s])) || Number(prices[s])<=0)) continue;
      let openPnl=0; for(const p of positions) openPnl+=positionPnl(p,prices[p.symbol]);
      const threshold=-(size*accountRules.floatingLoss), hit=accountRules.floatingLossEnabled !== false && openPnl<=threshold;
      if(!hit) { if(account.floatingLossActive) await accountDoc.ref.update({floatingLossActive:false,openPnl:Number(openPnl.toFixed(2)),equity:n(account.balance)+openPnl}); continue; }
      if(account.floatingLossActive) continue;
      let balance=n(account.balance,n(account.startingBalance));
      for(const p of positions) { const price=Number(prices[p.symbol]||0); if(!price) continue; const pnl=positionPnl(p,price); balance+=pnl; await accountDoc.ref.collection("positions").doc(p.id).update({status:"closed",closePrice:price,realizedPnl:pnl,closeReason:`${(accountRules.floatingLoss*100).toFixed(2)}% floating loss limit`,closedAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()}); }
      const hits=n(account.floatingLossHits)+1, isFunded=funded(account), limit=isFunded?accountRules.fundedFloatingHitsToBreach:accountRules.phaseFloatingHitsToBreach;
      const update={balance,equity:balance,pnl:balance-n(account.startingBalance,balance),openPnl:0,floatingLossHits:hits,floatingLossActive:true,lastFloatingLossAt:admin.firestore.FieldValue.serverTimestamp(),lastFloatingLossWarning:`${(accountRules.floatingLoss*100).toFixed(2)}% floating loss hit #${hits}`,updatedAt:admin.firestore.FieldValue.serverTimestamp()};
      if(isFunded && hits===2) update.profitSplitPercent=accountRules.fundedSecondHitProfitSplit;
      if(hits>=limit) { update.status="breached"; update.breachReason=`${(accountRules.floatingLoss*100).toFixed(2)}% floating loss hit ${hits} time(s)`; update.breachedAt=admin.firestore.FieldValue.serverTimestamp(); update.breachDeleteAt=new Date(Date.now()+accountRules.breachRetentionDays*86400000); }
      await accountDoc.ref.update(update); console.log("FLOATING_RISK_CLOSE",account.accountId,"hit",hits,"openPnl",openPnl.toFixed(2));
    }
  } catch(e) { console.error("FLOATING_RISK_ERROR",e?.message||e); }
}

function installChallengeRuleRoutes(app) {
  if (app.__auraChallengeRulesRoutesInstalled) return;
  app.__auraChallengeRulesRoutesInstalled = true;
  app.get("/api/challenge-rules", verifyAdmin, async (req,res)=>{ try { const rules=await getStoredChallengeRules(true); res.set("Cache-Control","no-store"); res.json({rules}); } catch(e) { console.error("CHALLENGE_RULES_GET_ERROR",e?.message||e); res.status(500).json({error:"Could not load challenge rules"}); } });
  app.put("/api/challenge-rules", verifyAdmin, async (req,res)=>{ try { const rules=normalizeRulesPayload(req.body?.rules||{}); await admin.firestore().collection("challengeRules").doc("global").set({rules,updatedAt:admin.firestore.FieldValue.serverTimestamp(),updatedBy:req.user?.email||req.user?.uid||"admin"},{merge:true}); adminRulesCache=rules; adminRulesCacheAt=Date.now(); res.json({ok:true,rules}); } catch(e) { console.error("CHALLENGE_RULES_SAVE_ERROR",e?.message||e); res.status(500).json({error:"Could not save challenge rules"}); } });
}

const originalUse = express.application.use;
let useCalls = 0;
express.application.use = function (...args) {
  const result = originalUse.apply(this,args);
  useCalls += 1;
  // Install after express.json() (the 3rd app.use in the current server), so
  // PUT /api/challenge-rules receives a parsed JSON body while retaining the
  // existing server middleware and routing unchanged.
  if (useCalls === 4) installChallengeRuleRoutes(this);
  return result;
};

async function tick() {
  try { const db=await getMongoDb(); for(const name of ["tradingAccounts","challengeAccounts","accounts","challenge_accounts"]) { const col=db.collection(name), docs=await col.find({accountId:{$exists:true}}).toArray(); for(const doc of docs) try { await evaluate(col,doc); } catch(e) { console.error("CHALLENGE_RULE_ERROR",name,doc._id,e?.message||e); } await cleanup(col); } }
  catch(e) { console.error("CHALLENGE_ENGINE_ERROR",e?.message||e); }
}
setTimeout(()=>{tick();setInterval(tick,5000)},1500);
setTimeout(()=>{closeFloatingLossAccounts();setInterval(closeFloatingLossAccounts,1000)},2000);
