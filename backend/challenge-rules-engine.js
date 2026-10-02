import "dotenv/config";
import express from "express";
import admin from "firebase-admin";
import { readFileSync } from "node:fs";
import { getMongoDb } from "./mongodb.js";

export const CHALLENGE_RULES = Object.freeze({
  phase1Target:0.08,
  phase2Target:0.06,
  minDailyProfit:0.01,
  phase1Days:3,
  phase2Days:2,
  minTradingDays:5,
  dailyLoss:0.04,
  staticDrawdown:0.08,
  floatingLoss:0.01,
  phaseFloatingHitsToBreach:2,
  fundedFloatingHitsToBreach:3,
  fundedSecondHitProfitSplit:70,
  breachRetentionDays:7,
  resetHourIST:6
});

const n=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;
const model=a=>String(a.model||a.challengeModel||a.accountModel||a.challengeType||a.type||"").toLowerCase();
const funded=a=>a.funded===true||/funded/i.test(String(a.stage||a.phase||a.statusStage||""));
const phase=a=>funded(a)?"Funded":/phase\s*2|step\s*2/i.test(String(a.phase||a.stage||a.statusStage||""))?"Phase 2":"Phase 1";

let firebaseReady=false,adminRulesCache=null,adminRulesCacheAt=0,challengeCatalogCache=null,challengeCatalogCacheAt=0;

function initFirebaseForRiskMonitor(){
  if(firebaseReady||admin.apps.length){firebaseReady=true;return}
  const raw=process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const file=process.env.GOOGLE_APPLICATION_CREDENTIALS||"/etc/secrets/firebase-service-account.json";
  try{
    if(raw)admin.initializeApp({credential:admin.credential.cert(JSON.parse(raw))});
    else admin.initializeApp({credential:admin.credential.cert(JSON.parse(readFileSync(file,"utf8")))});
    firebaseReady=true;
  }catch(e){console.error("CHALLENGE_RULES_FIREBASE_INIT_ERROR",e?.message||e)}
}

function primaryAdmin(req){
  const email=String(req.user?.email||"").toLowerCase();
  const allowed=(process.env.ADMIN_EMAILS||"").split(",").map(x=>x.trim().toLowerCase()).filter(Boolean);
  return req.user?.admin===true||(email&&(email==="lipupoddar@gmail.com"||allowed.includes(email)));
}

async function verifyAdmin(req,res,next){
  try{
    initFirebaseForRiskMonitor();
    const h=req.headers.authorization||"";
    if(!h.startsWith("Bearer "))return res.status(401).json({error:"Authentication required"});
    req.user=await admin.auth().verifyIdToken(h.slice(7));
    if(!primaryAdmin(req))return res.status(403).json({error:"Admin access required"});
    next();
  }catch{return res.status(401).json({error:"Invalid or expired Firebase ID token"})}
}

function normalizeRuleStage(value,stage){
  let raw=value;
  if(typeof raw==="string"){try{raw=JSON.parse(raw)}catch{raw={}}}
  raw=raw&&typeof raw==="object"?raw:{};
  return{
    stage:String(raw.stage||stage),
    floatingLossEnabled:raw.floatingLossEnabled===true,
    floatingLossPercent:Math.min(2.5,Math.max(.25,n(raw.floatingLossPercent,1))),
    minimumTradingDays:Math.min(10,Math.max(0,Math.round(n(raw.minimumTradingDays,5))))
  };
}

function normalizeRulesPayload(input){
  const source=input&&typeof input==="object"?input:{};
  const models={"1 Step":["Phase 1","Funded"],"2 Step":["Phase 1","Phase 2","Funded"],"Instant":["Funded"]};
  const out={};
  for(const[name,stages]of Object.entries(models)){
    out[name]={};
    for(const stage of stages){
      const md=source[name]||{};
      let value;
      if(Array.isArray(md))value=md.find(v=>v&&typeof v==="object"?String(v.stage||"")===stage:(()=>{try{return JSON.parse(v)?.stage===stage}catch{return false}})());
      else value=md[stage];
      out[name][stage]=normalizeRuleStage(value,stage);
    }
  }
  return out;
}

async function getStoredChallengeRules(force=false){
  initFirebaseForRiskMonitor();
  if(!firebaseReady)return{};
  if(!force&&adminRulesCache&&Date.now()-adminRulesCacheAt<10000)return adminRulesCache;
  const snap=await admin.firestore().collection("challengeRules").doc("global").get();
  adminRulesCache=snap.exists?(snap.data()?.rules||{}):{};
  adminRulesCacheAt=Date.now();
  return adminRulesCache;
}

async function getChallengeCatalog(force=false){
  initFirebaseForRiskMonitor();
  if(!firebaseReady)return[];
  if(!force&&challengeCatalogCache&&Date.now()-challengeCatalogCacheAt<10000)return challengeCatalogCache;
  const snap=await admin.firestore().collection("settings").doc("challengeCatalog").get();
  const items=snap.exists&&Array.isArray(snap.data()?.items)?snap.data().items:[];
  challengeCatalogCache=items;
  challengeCatalogCacheAt=Date.now();
  return items;
}

function ruleModelName(a){
  const m=model(a);
  if(/instant|instant\s*account|instant\s*challenge/.test(m))return"Instant";
  if(/2\s*step|two\s*step|2step/.test(m))return"2 Step";
  if(/1\s*step|one\s*step|1step/.test(m))return"1 Step";
  return"";
}

function storedStageRule(stored,a){
  const name=ruleModelName(a);
  if(!name)return null;
  const stageName=phase(a);
  let config=stored?.[name]?.[stageName]||null;
  if(name==="Instant")config=stored?.Instant?.Funded||config;
  return config?normalizeRuleStage(config,stageName):null;
}

function parsePercent(value,fallback){
  const raw=String(value??"").trim().replace("%","");
  const v=Number(raw);
  return Number.isFinite(v)?Math.max(0,v)/100:fallback;
}

function accountChallengeId(a){return String(a.challengeId||a.challengeID||a.planId||"").trim();}
function accountChallengeSize(a){return String(a.size||a.challengeSize||a.accountSizeLabel||"").trim().toLowerCase();}

function findCatalogChallenge(catalog,a){
  const id=accountChallengeId(a);
  if(id){const exact=catalog.find(x=>String(x?.id||"")===id);if(exact)return exact;}
  const size=accountChallengeSize(a);
  const wantedModel=ruleModelName(a);
  return catalog.find(x=>{
    const xm=String(x?.model||"");
    const xs=String(x?.size||"").trim().toLowerCase();
    return (!wantedModel||xm===wantedModel)&&(!size||xs===size);
  })||null;
}

async function effectiveRules(a){
  const catalog=await getChallengeCatalog();
  const challenge=findCatalogChallenge(catalog,a);
  const catalogDaily=parsePercent(challenge?.dailyDrawdown,NaN);
  const catalogMax=parsePercent(challenge?.totalDrawdown,NaN);
  const accountDaily=parsePercent(a.dailyDrawdown,NaN);
  const accountMax=parsePercent(a.maxDrawdown,NaN);
  const sr=storedStageRule(await getStoredChallengeRules(),a);
  return{
    ...CHALLENGE_RULES,
    dailyLoss:Number.isFinite(catalogDaily)?catalogDaily:(Number.isFinite(accountDaily)?accountDaily:CHALLENGE_RULES.dailyLoss),
    staticDrawdown:Number.isFinite(catalogMax)?catalogMax:(Number.isFinite(accountMax)?accountMax:CHALLENGE_RULES.staticDrawdown),
    floatingLoss:sr?sr.floatingLossPercent/100:CHALLENGE_RULES.floatingLoss,
    floatingLossEnabled:sr?sr.floatingLossEnabled:false,
    minTradingDays:sr?sr.minimumTradingDays:CHALLENGE_RULES.minTradingDays,
    sourceChallengeId:challenge?.id||accountChallengeId(a)||""
  };
}

const dayStart=()=>{
  const now=new Date(),ist=new Date(now.getTime()+330*60000);
  ist.setUTCHours(0,30,0,0);
  return new Date(ist.getTime()-330*60000);
};
const dayKey=d=>d.toISOString().slice(0,10);

async function syncFirebaseAccountRules(a,r,extra={}){
  try{
    initFirebaseForRiskMonitor();
    const uid=String(a.userId||a.uid||"").trim();
    const accountId=String(a.accountId||"").trim();
    if(!uid||!accountId||!firebaseReady)return;
    const db=admin.firestore();
    const primary=db.collection("users").doc(uid).collection("tradingAccounts").doc(accountId);
    const selected=db.collection("users").doc(uid).collection("trading").doc("account");
    const patch={
      dailyDrawdown:Number((r.dailyLoss*100).toFixed(4)),
      maxDrawdown:Number((r.staticDrawdown*100).toFixed(4)),
      dailyDrawdownLimit:Number((r.dailyLoss*100).toFixed(4)),
      maxDrawdownLimit:Number((r.staticDrawdown*100).toFixed(4)),
      challengeRulesSource:r.sourceChallengeId||accountChallengeId(a)||"",
      ...extra,
      updatedAt:admin.firestore.FieldValue.serverTimestamp()
    };
    await primary.set(patch,{merge:true});
    const selectedSnap=await selected.get();
    if(selectedSnap.exists&&String(selectedSnap.data()?.accountId||"")===accountId)await selected.set(patch,{merge:true});
  }catch(e){console.warn("CHALLENGE_RULE_FIRESTORE_SYNC_ERROR",e?.message||e)}
}

async function evaluate(col,doc){
  const a={...doc};
  if(!a.accountId||String(a.status||"active")==="deleted")return;
  const r=await effectiveRules(a);
  const size=Math.max(0,n(a.accountSize,n(a.startingBalance,n(a.balance))));
  const balance=n(a.balance,n(a.startingBalance,size));
  const equity=n(a.equity,balance+n(a.openPnl));
  const key=dayKey(dayStart());
  const set={challengeRules:r};
  if(!a.staticDrawdownBase)set.staticDrawdownBase=n(a.startingBalance,size);
  if(!a.phaseStartBalance)set.phaseStartBalance=balance;
  if(!a.dailyDayKey||a.dailyDayKey!==key){set.dailyDayKey=key;set.dailyStartBalance=balance;set.dailyStartEquity=equity}
  const dailyStart=n(a.dailyStartEquity,n(a.dailyStartBalance,balance));
  const staticBase=n(a.staticDrawdownBase,n(a.startingBalance,size));
  const dailyDd=dailyStart>0?Math.max(0,(dailyStart-equity)/dailyStart):0;
  const maxDd=staticBase>0?Math.max(0,(staticBase-equity)/staticBase):0;
  set.dailyDrawdownPct=Number((dailyDd*100).toFixed(4));
  set.maxDrawdownPct=Number((maxDd*100).toFixed(4));
  set.dailyDrawdown=Number((r.dailyLoss*100).toFixed(4));
  set.maxDrawdown=Number((r.staticDrawdown*100).toFixed(4));
  set.dailyDrawdownLimit=Number((r.dailyLoss*100).toFixed(4));
  set.maxDrawdownLimit=Number((r.staticDrawdown*100).toFixed(4));

  let status=a.status||"active";
  let breach=a.breachReason||"";
  if(status==="active"&&dailyDd>=r.dailyLoss){
    status="breached";
    breach=`Daily drawdown limit reached (${(r.dailyLoss*100).toFixed(2)}%)`;
  }else if(status==="active"&&maxDd>=r.staticDrawdown){
    status="breached";
    breach=`Maximum drawdown limit reached (${(r.staticDrawdown*100).toFixed(2)}%)`;
  }

  const floatingHit=r.floatingLossEnabled===true&&size>0&&n(a.openPnl)<=-(size*r.floatingLoss);
  if(floatingHit&&!a.floatingLossActive){
    const hits=n(a.floatingLossHits)+1;
    set.floatingLossHits=hits;
    set.floatingLossActive=true;
    set.lastFloatingLossWarning=`${(r.floatingLoss*100).toFixed(2)}% floating loss hit #${hits}`;
    if(hits>=(funded(a)?r.fundedFloatingHitsToBreach:r.phaseFloatingHitsToBreach))status="breached";
  }else if(!floatingHit&&a.floatingLossActive){
    set.floatingLossActive=false;
  }

  if(status==="breached"&&a.status!=="breached"){
    set.breachedAt=new Date();
    await syncFirebaseAccountRules(a,r,{status:"breached",breachReason:breach||"Account breached"});
  }else{
    await syncFirebaseAccountRules(a,r,{status});
  }

  set.status=status;
  set.breachReason=breach;
  await col.updateOne({_id:doc._id},{$set:set});
}

function installChallengeRuleRoutes(app){
  if(app.__auraChallengeRulesRoutesInstalled)return;
  app.__auraChallengeRulesRoutesInstalled=true;
  app.get("/api/challenge-rules",verifyAdmin,async(req,res)=>{
    try{res.set("Cache-Control","no-store");res.json({rules:await getStoredChallengeRules(true)})}
    catch(e){res.status(500).json({error:"Could not load challenge rules"})}
  });
  app.put("/api/challenge-rules",verifyAdmin,async(req,res)=>{
    try{
      const rules=normalizeRulesPayload(req.body?.rules||{});
      await admin.firestore().collection("challengeRules").doc("global").set({rules,updatedAt:admin.firestore.FieldValue.serverTimestamp(),updatedBy:req.user?.email||req.user?.uid||"admin"},{merge:true});
      adminRulesCache=rules;
      adminRulesCacheAt=Date.now();
      res.json({ok:true,rules});
    }catch(e){res.status(500).json({error:"Could not save challenge rules"})}
  });
}

const originalUse=express.application.use;
let useCalls=0;
express.application.use=function(...args){
  const result=originalUse.apply(this,args);
  useCalls++;
  if(useCalls===4)installChallengeRuleRoutes(this);
  return result;
};

async function tick(){
  try{
    const db=await getMongoDb();
    for(const name of ["tradingAccounts","challengeAccounts","accounts","challenge_accounts"]){
      const col=db.collection(name),docs=await col.find({accountId:{$exists:true}}).toArray();
      for(const doc of docs)try{await evaluate(col,doc)}catch(e){console.error("CHALLENGE_RULE_ERROR",e?.message||e)}
    }
  }catch(e){console.error("CHALLENGE_ENGINE_ERROR",e?.message||e)}
}

setTimeout(()=>{tick();setInterval(tick,5000)},1500);
