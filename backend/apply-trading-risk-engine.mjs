import { readFileSync, writeFileSync } from "node:fs";

const target = new URL("./server.js", import.meta.url);
let source = readFileSync(target, "utf8");

const MARKER = "// AURA_TRADING_RISK_ENGINE_V3";
if (source.includes(MARKER)) {
  console.log("TRADING_RISK_ENGINE_ALREADY_APPLIED=OK");
  process.exit(0);
}

const start = source.indexOf("async function refreshTradingAccount(uid, quotes) {");
const end = source.indexOf("\nasync function fetchMarketCandles", start);
if (start < 0 || end < 0) {
  throw new Error("Could not locate refreshTradingAccount function");
}

const replacement = `${MARKER}
function tradingDayKey(date = new Date()) {
  // Trading day resets at 06:00 Asia/Kolkata. Convert UTC -> IST and
  // subtract six hours, then use the resulting calendar date.
  return new Date(date.getTime() + (5.5 * 60 - 6 * 60) * 60 * 1000)
    .toISOString().slice(0, 10);
}

function floatingLossLimit(account) {
  const accountSize = Number(account.startingBalance ?? account.accountSize ?? 0);
  return accountSize > 0 ? accountSize * 0.01 : 0;
}

function riskStage(account) {
  const explicit = String(account.stage || account.accountStage || "").trim().toLowerCase();
  if (explicit.includes("funded")) return "funded";
  if (explicit.includes("phase")) return "phase";
  const challenge = String(account.challenge || account.model || "").toLowerCase();
  return challenge.includes("funded") ? "funded" : "phase";
}

async function closeAllOpenPositions(ref, positions, quotes, reason) {
  let realized = 0;
  const closed = [];
  for (const p of positions) {
    const q = Number(quotes?.[p.symbol]?.price || p.currentPrice || 0);
    if (!q) continue;
    const pnl = tradePnl(p, q);
    realized += pnl;
    await ref.collection("positions").doc(p.id).update({
      status: "closed",
      closePrice: q,
      realizedPnl: pnl,
      closeReason: reason,
      closedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    closed.push({ ...p, closePrice:q, realizedPnl:pnl, closeReason:reason });
  }
  return { realized, closed };
}

async function refreshTradingAccount(uid, quotes, accountId = "") {
  const { ref, data } = await loadTradingAccount(uid, accountId);
  const positionSnap = await ref.collection("positions").where("status", "==", "open").get();
  const missingSymbols=[...new Set(positionSnap.docs.map(d=>d.data()?.symbol).filter(s=>s && !quotes?.[s]))];
  if(missingSymbols.length){
    const extra=await getMarketQuotes(missingSymbols);
    quotes={...(quotes||{}),...extra};
  }

  let balance = Number(data.balance ?? data.startingBalance ?? 0);
  let openPnl = 0;
  let realizedFromStops = 0;
  let positions = [];

  // First reconcile SL/TP using the selected account's own positions.
  for (const d of positionSnap.docs) {
    const p = { id:d.id, ...d.data() };
    const q = Number(quotes?.[p.symbol]?.price || 0);
    let exitPrice = null;
    let closeReason = "";
    if (q && p.stopLoss != null) {
      if (p.side === "BUY" && q <= Number(p.stopLoss)) { exitPrice=Number(p.stopLoss); closeReason="Stop Loss"; }
      if (p.side === "SELL" && q >= Number(p.stopLoss)) { exitPrice=Number(p.stopLoss); closeReason="Stop Loss"; }
    }
    if (q && exitPrice === null && p.takeProfit != null) {
      if (p.side === "BUY" && q >= Number(p.takeProfit)) { exitPrice=Number(p.takeProfit); closeReason="Take Profit"; }
      if (p.side === "SELL" && q <= Number(p.takeProfit)) { exitPrice=Number(p.takeProfit); closeReason="Take Profit"; }
    }
    if (exitPrice !== null) {
      const pnl = tradePnl(p, exitPrice);
      balance += pnl;
      realizedFromStops += pnl;
      await ref.collection("positions").doc(p.id).update({
        status:"closed", closePrice:exitPrice, realizedPnl:pnl, closeReason,
        closedAt:admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:admin.firestore.FieldValue.serverTimestamp()
      });
      continue;
    }
    const pnl = q ? tradePnl(p, q) : 0;
    openPnl += pnl;
    positions.push({ ...p, currentPrice:q || p.entryPrice, pnl });
  }

  // 1% floating basket protection. It is based on the account's original size,
  // not the current balance, and closes every open trade for this account.
  const starting = Number(data.startingBalance ?? data.accountSize ?? balance);
  const floatingLimit = starting > 0 ? starting * 0.01 : 0;
  let floatingLossHits = Number(data.floatingLossHits || 0);
  let riskEvent = "";
  let riskWarning = "";
  let status = data.status || "active";
  let profitSplitPct = data.profitSplitPct == null ? null : Number(data.profitSplitPct);

  if (floatingLimit > 0 && openPnl <= -floatingLimit && positions.length) {
    const reason = "1% floating loss limit";
    const result = await closeAllOpenPositions(ref, positions, quotes, reason);
    balance += result.realized;
    realizedFromStops += result.realized;
    openPnl = 0;
    positions = [];
    floatingLossHits += 1;

    const stage = riskStage(data);
    const hit = floatingLossHits;
    if (stage === "funded") {
      if (hit >= 3) {
        status = "breached";
        riskEvent = "Funded account breached after 3 floating-loss hits";
      } else if (hit === 2) {
        profitSplitPct = 70;
        riskWarning = "Second 1% floating-loss warning. Profit split set to 70%.";
      } else {
        riskWarning = "First 1% floating-loss warning.";
      }
    } else {
      if (hit >= 2) {
        status = "breached";
        riskEvent = "Challenge account breached after 2 floating-loss hits";
      } else {
        riskWarning = "First 1% floating-loss warning.";
      }
    }
  }

  const equity = balance + openPnl;
  const todayKey = tradingDayKey();
  const dayChanged = data.dailyResetDate !== todayKey;
  const dailyStart = dayChanged ? equity : Number(data.dailyStartEquity || starting);
  const dailyDd = dailyStart > 0 ? Math.max(0, (dailyStart-equity)/dailyStart*100) : 0;
  // Static maximum drawdown: always measured from the original account size.
  const maxDd = starting > 0 ? Math.max(0, (starting-equity)/starting*100) : 0;
  const rules = accountRules(data);

  if (status === "active" && dailyDd >= rules.dailyDrawdownPct) {
    status = "breached";
    riskEvent = "Daily drawdown limit reached";
  }
  if (status === "active" && maxDd >= rules.maxDrawdownPct) {
    status = "breached";
    riskEvent = "Static maximum drawdown limit reached";
  }

  if (status === "breached" && data.status !== "breached") {
    await revokeTerminalCredentials({ ...data, terminalCredentialId:data.terminalCredentialId }, riskEvent || data.breachReason || "Account breached");
  }

  await ref.update({
    balance, equity, pnl:balance-starting, openPnl,
    peakEquity:Math.max(Number(data.peakEquity || starting), equity),
    dailyStartEquity:dailyStart, dailyResetDate:todayKey,
    dailyDrawdownPct:dailyDd, maxDrawdownPct:maxDd,
    floatingLossHits, profitSplitPct,
    status,
    breachReason:status === "breached" ? (riskEvent || data.breachReason || "Account breached") : (data.breachReason || ""),
    ...(riskWarning ? { lastRiskWarning:riskWarning, lastRiskWarningAt:admin.firestore.FieldValue.serverTimestamp() } : {}),
    updatedAt:admin.firestore.FieldValue.serverTimestamp()
  });

  return {
    ...data,
    balance, equity, pnl:balance-starting, openPnl,
    peakEquity:Math.max(Number(data.peakEquity || starting), equity),
    dailyStartEquity:dailyStart, dailyResetDate:todayKey,
    dailyDrawdownPct:dailyDd, maxDrawdownPct:maxDd,
    floatingLossHits, profitSplitPct, status,
    breachReason:status === "breached" ? (riskEvent || data.breachReason || "Account breached") : (data.breachReason || ""),
    positions, realizedFromStops, riskWarning
  };
}`;

source = source.slice(0, start) + replacement + source.slice(end);

// Every refresh must use the terminal's selected account. The old calls silently
// fell back to users/{uid}/trading/account, so a selected account's positions were
// never risk-checked.
source = source.replaceAll(
  "refreshTradingAccount(req.user.uid,quotes)",
  "refreshTradingAccount(req.terminal.uid,quotes,req.terminal.accountId)"
);
source = source.replaceAll(
  "refreshTradingAccount(req.user.uid, quotes)",
  "refreshTradingAccount(req.terminal.uid, quotes, req.terminal.accountId)"
);

// The default rules are the agreed Aura Farming rules: 4% daily and 10% static.
source = source.replace(
  /function accountRules\(account\) \{[\s\S]*?\n\}/,
  `function accountRules(account) {\n  return {\n    dailyDrawdownPct: parsePercent(account.dailyDrawdown, 4),\n    maxDrawdownPct: parsePercent(account.maxDrawdown, 10)\n  };\n}`
);

writeFileSync(target, source);
console.log("TRADING_RISK_ENGINE_APPLIED=OK");
console.log("SELECTED_ACCOUNT_RISK_PATH=OK");
console.log("FLOATING_LOSS_1PCT=OK");
console.log("STATIC_DRAWDOWN_10PCT=OK");
console.log("DAILY_RESET_06_IST=OK");