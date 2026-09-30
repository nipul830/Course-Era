import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";

const target = "/root/Course-Era/backend/server.js";
const positionTarget = "/root/Course-Era/position.html";
let source = readFileSync(target, "utf8");
let position = readFileSync(positionTarget, "utf8");
let changed = false;

if (!source.includes('app.post("/api/auth/password-reset/request"')) {
  const marker = 'app.post("/api/terminal/login", terminalLoginRateLimit, async (req, res) => {';
  if (!source.includes(marker)) throw new Error("Could not find safe insertion point in server.js");

  const block = String.raw`
const PASSWORD_RESET_CODE_TTL_MS = 10 * 60 * 1000;
const PASSWORD_RESET_RESEND_MS = 60 * 1000;
const PASSWORD_RESET_MAX_ATTEMPTS = 5;
const PASSWORD_RESET_REQUEST_LIMIT = 5;
const passwordResetRequestTimes = new Map();

function normalizeResetEmail(value) {
  return String(value || "").trim().toLowerCase().slice(0, 320);
}

function hashResetCode(code) {
  return crypto.createHash("sha256").update(String(code)).digest("hex");
}

function generateResetCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

function passwordResetFromEmail() {
  return String(process.env.RESEND_FROM_EMAIL || process.env.RESEND_FROM || "Aura Farming <onboarding@resend.dev>").trim();
}

async function sendPasswordResetEmail({ to, code }) {
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured on the server");

  const from = passwordResetFromEmail();
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: "Aura Farming password reset code",
      html: '<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto"><h2>Aura Farming</h2><p>Use this verification code to reset your password:</p><div style="font-size:32px;font-weight:700;letter-spacing:8px;padding:18px 0">' + code + '</div><p>This code expires in 10 minutes.</p><p>If you did not request a password reset, you can ignore this email.</p></div>'
    })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error("Resend rejected the email request" + (detail ? ": " + detail.slice(0, 500) : ""));
  }
}

app.post("/api/auth/password-reset/request", async (req, res) => {
  try {
    initFirebase();
    const email = normalizeResetEmail(req.body?.email);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Enter a valid email address" });
    }

    const now = Date.now();
    const recent = passwordResetRequestTimes.get(email) || [];
    const validRecent = recent.filter(ts => now - ts < 15 * 60 * 1000);
    if (validRecent.length >= PASSWORD_RESET_REQUEST_LIMIT) {
      return res.status(429).json({ error: "Too many reset requests. Please try again later." });
    }
    if (validRecent.some(ts => now - ts < PASSWORD_RESET_RESEND_MS)) {
      return res.status(429).json({ error: "Please wait one minute before requesting another code." });
    }

    let user;
    try {
      user = await admin.auth().getUserByEmail(email);
    } catch {
      passwordResetRequestTimes.set(email, [...validRecent, now]);
      return res.json({ message: "If an account exists for this email, a verification code has been sent." });
    }

    const code = generateResetCode();
    const resetRef = db.collection("passwordResetCodes").doc(user.uid);
    await resetRef.set({
      uid: user.uid,
      email,
      codeHash: hashResetCode(code),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: new Date(now + PASSWORD_RESET_CODE_TTL_MS),
      attempts: 0,
      used: false
    });

    try {
      await sendPasswordResetEmail({ to: email, code });
    } catch (mailError) {
      await resetRef.delete().catch(() => {});
      console.error("PASSWORD_RESET_EMAIL_ERROR:", mailError?.message || mailError);
      return res.status(502).json({ error: "Could not send the verification email. Please try again." });
    }

    passwordResetRequestTimes.set(email, [...validRecent, now]);
    res.json({ message: "If an account exists for this email, a verification code has been sent." });
  } catch (e) {
    console.error("PASSWORD_RESET_REQUEST_ERROR:", e);
    res.status(500).json({ error: "Could not start password reset" });
  }
});

app.post("/api/auth/password-reset/confirm", async (req, res) => {
  try {
    initFirebase();
    const email = normalizeResetEmail(req.body?.email);
    const code = String(req.body?.code || "").trim();
    const password = String(req.body?.password || "");
    const confirmPassword = String(req.body?.confirmPassword || "");

    if (!email || !/^\d{6}$/.test(code)) return res.status(400).json({ error: "Enter the 6-digit verification code" });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
    if (password !== confirmPassword) return res.status(400).json({ error: "Passwords do not match" });

    const snap = await db.collection("passwordResetCodes").where("email", "==", email).limit(10).get();
    const doc = snap.docs
      .filter(d => d.data()?.used !== true)
      .sort((a, b) => Number(b.data()?.createdAt?.toMillis?.() || 0) - Number(a.data()?.createdAt?.toMillis?.() || 0))[0];
    if (!doc) return res.status(400).json({ error: "Invalid or expired verification code" });

    const data = doc.data() || {};
    const expiresAtMs = data.expiresAt?.toMillis?.() ?? new Date(data.expiresAt || 0).getTime();
    const attempts = Number(data.attempts || 0);
    if (!expiresAtMs || expiresAtMs < Date.now() || attempts >= PASSWORD_RESET_MAX_ATTEMPTS) {
      return res.status(400).json({ error: "Invalid or expired verification code" });
    }

    if (data.codeHash !== hashResetCode(code)) {
      await doc.ref.update({ attempts: attempts + 1 });
      return res.status(400).json({ error: attempts + 1 >= PASSWORD_RESET_MAX_ATTEMPTS ? "Too many incorrect attempts. Request a new code." : "Invalid verification code" });
    }

    await admin.auth().updateUser(data.uid, { password });
    await admin.auth().revokeRefreshTokens(data.uid);
    await doc.ref.update({ used: true, usedAt: admin.firestore.FieldValue.serverTimestamp() });

    res.json({ message: "Password reset successfully" });
  } catch (e) {
    console.error("PASSWORD_RESET_CONFIRM_ERROR:", e);
    res.status(500).json({ error: "Could not reset password" });
  }
});

`;
  source = source.replace(marker, block + marker);
  changed = true;
}

if (!source.includes('const leverageForKind = kind =>')) {
  const historyAnchor = `    res.json({\n      account:{id:data.accountId||"account",balance:Number(data.balance??data.startingBalance??0),equity:Number(data.equity??data.balance??data.startingBalance??0),challenge:data.challenge||data.accountType||data.plan||""},\n      open,pending,closed\n    });`;
  const historyReplacement = `    const leverageForKind = kind => ({ crypto:10, gold:50, forex:100, "forex-jpy":100 }[String(kind||"")] || null);\n    const accountBalance = Number(data.balance??data.startingBalance??0);\n    const accountEquity = Number(data.equity??accountBalance);\n    let usedMargin = 0;\n    for (const p of open) {\n      const spec = MARKET_SYMBOLS[p.symbol];\n      const leverage = leverageForKind(spec?.kind);\n      const px = Number(p.currentPrice||p.entryPrice||0);\n      const lot = Number(p.lot||0);\n      if (!spec || !leverage || !px || !lot) { p.leverage = leverage || null; p.marginUsed = 0; continue; }\n      const notional = spec.kind === "forex-jpy" ? Math.abs(lot * spec.contractSize) : Math.abs(px * lot * spec.contractSize);\n      p.leverage = leverage;\n      p.marginUsed = Number((notional / leverage).toFixed(2));\n      usedMargin += p.marginUsed;\n    }\n    usedMargin = Number(usedMargin.toFixed(2));\n    const freeMargin = Number((accountEquity - usedMargin).toFixed(2));\n    const marginLevel = usedMargin > 0 ? Number(((accountEquity / usedMargin) * 100).toFixed(2)) : null;\n    const riskFactor = usedMargin <= 0 ? "Safe" : marginLevel >= 200 ? "Safe" : marginLevel >= 100 ? "Medium" : "High";\n    res.json({\n      account:{id:data.accountId||"account",balance:accountBalance,equity:accountEquity,challenge:data.challenge||data.accountType||data.plan||"",leverage:open.length ? leverageForKind(MARKET_SYMBOLS[open[0].symbol]?.kind) : null,margin:usedMargin,freeMargin,marginLevel,riskFactor},\n      open,pending,closed\n    });`;
  if (!source.includes(historyAnchor)) throw new Error("Trading history response anchor not found");
  source = source.replace(historyAnchor, historyReplacement);
  changed = true;
}

if (!position.includes('id="detailPositionLeverage"')) {
  const detailAnchor = '<div class="account-detail"><span class="detail-label">Margin</span><span class="detail-value" id="detailPositionMargin">—</span></div>';
  if (!position.includes(detailAnchor)) throw new Error("Position margin detail anchor not found");
  position = position.replace(detailAnchor, detailAnchor + '<div class="account-detail"><span class="detail-label">Leverage</span><span class="detail-value" id="detailPositionLeverage">—</span></div>', 1);
  const metricAnchor = "const eq=liveBalance+initialPnl; const setp=(id,v)=>{const el=document.getElementById(id);if(el)el.textContent=v}; setp('detailPositionEquity',money(eq)); setp('detailPositionMargin','—'); setp('detailPositionFreeMargin',money(eq)); setp('detailPositionMarginLevel','—'); setp('detailPositionRisk','Safe'); setp('detailPositionStatus','LIVE');";
  const metricReplacement = "const eq=liveBalance+initialPnl; const setp=(id,v)=>{const el=document.getElementById(id);if(el)el.textContent=v}; setp('detailPositionEquity',money(eq)); setp('detailPositionMargin',money(Number(data.account?.margin||0))); setp('detailPositionFreeMargin',money(Number(data.account?.freeMargin??eq))); setp('detailPositionMarginLevel',data.account?.marginLevel==null?'∞':Number(data.account.marginLevel).toFixed(2)+'%'); setp('detailPositionLeverage',data.account?.leverage?('1:'+data.account.leverage):'—'); setp('detailPositionRisk',data.account?.riskFactor||'Safe'); setp('detailPositionStatus','LIVE');";
  if (!position.includes(metricAnchor)) throw new Error("Position metric anchor not found");
  position = position.replace(metricAnchor, metricReplacement, 1);
  const paintAnchor = 'function paintLivePositions(){';
  const paintReplacement = `function updateLiveMarginMetrics(){\n  const eq=liveBalance+livePositions.reduce((sum,p)=>sum+calcLivePnl(p,Number(p.currentPrice||p.entryPrice||0)),0);\n  let margin=0;\n  for(const p of livePositions){\n    const lev=Number(p.leverage||0),lot=Number(p.lot||0),px=Number(p.currentPrice||p.entryPrice||0);\n    let spec=null;\n    if(p.symbol==='OANDA:XAUUSD')spec={contractSize:100,kind:'gold'};\n    else if(['FX:EURUSD','FX:GBPUSD','FX:AUDUSD'].includes(p.symbol))spec={contractSize:100000,kind:'forex'};\n    else if(p.symbol==='FX:USDJPY')spec={contractSize:100000,kind:'forex-jpy'};\n    else if(['BINANCE:BTCUSDT','BINANCE:ETHUSDT','BINANCE:SOLUSDT','BINANCE:XRPUSDT'].includes(p.symbol))spec={contractSize:1,kind:'crypto'};\n    if(!spec||!lev||!lot||!px)continue;\n    const notional=spec.kind==='forex-jpy'?Math.abs(lot*spec.contractSize):Math.abs(px*lot*spec.contractSize);\n    margin+=notional/lev;\n  }\n  margin=Number(margin.toFixed(2));\n  const free=Number((eq-margin).toFixed(2));\n  const level=margin>0?(eq/margin)*100:null;\n  const risk=margin<=0?'Safe':level>=200?'Safe':level>=100?'Medium':'High';\n  const setp=(id,v)=>{const el=document.getElementById(id);if(el)el.textContent=v};\n  setp('detailPositionEquity',money(eq)); setp('detailPositionMargin',money(margin)); setp('detailPositionFreeMargin',money(free)); setp('detailPositionMarginLevel',level==null?'∞':level.toFixed(2)+'%'); setp('detailPositionRisk',risk);\n}\n\nfunction paintLivePositions(){`;
  if (!position.includes(paintAnchor)) throw new Error("Live margin paint anchor not found");
  position = position.replace(paintAnchor, paintReplacement, 1);
  const paintCallAnchor = "  const dp=document.getElementById('detailPositionPnl'); if(dp){dp.textContent=(openPnl>=0?'+':'')+money(openPnl);dp.classList.toggle('negative',openPnl<0);}\n}";
  const paintCallReplacement = "  const dp=document.getElementById('detailPositionPnl'); if(dp){dp.textContent=(openPnl>=0?'+':'')+money(openPnl);dp.classList.toggle('negative',openPnl<0);} updateLiveMarginMetrics();\n}";
  if (!position.includes(paintCallAnchor)) throw new Error("Live margin call anchor not found");
  position = position.replace(paintCallAnchor, paintCallReplacement, 1);
  changed = true;
}

if (changed) {
  writeFileSync(target, source);
  writeFileSync(positionTarget, position);

  for (const cleanup of [
    "/root/Course-Era/.github/workflows/apply-margin-risk.yml",
    "/root/Course-Era/.github/workflows/apply-margin-risk-run.yml",
    "/root/Course-Era/scripts/apply-margin-risk.js",
    "/root/Course-Era/.margin-risk-trigger"
  ]) {
    try { if (existsSync(cleanup)) unlinkSync(cleanup); } catch {}
  }

  console.log("Trading margin/risk patch applied");
} else {
  console.log("Password reset and margin/risk patches already present; nothing to patch.");
}
