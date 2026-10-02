import { readFileSync, writeFileSync } from "node:fs";

const target = new URL("./server.js", import.meta.url);
let source = readFileSync(target, "utf8");
const MARKER = "// AURA_DASHBOARD_STATS_API_V1";

if (source.includes(MARKER)) {
  console.log("DASHBOARD_STATS_API=ALREADY_APPLIED");
  process.exit(0);
}

const anchor = 'app.get("/api/trading-account", requireAuth, async (req, res) => {';
if (!source.includes(anchor)) throw new Error("Dashboard account route anchor not found");

const route = `${MARKER}
app.get("/api/dashboard-stats", requireAuth, async (req, res) => {
  try {
    const { ref, data } = await loadTradingAccount(req.user.uid);
    const snap = await ref.collection("positions").get();
    const all = snap.docs.map(d => ({ id:d.id, ...(d.data() || {}) }));
    const closed = all.filter(p => String(p.status || "") === "closed");
    const open = all.filter(p => String(p.status || "") === "open");

    const timeOf = p => {
      const v = p.closedAt || p.closeTime || p.updatedAt || p.createdAt;
      if (v instanceof Date) return v.getTime();
      if (v?.toDate) return v.toDate().getTime();
      if (v?._seconds != null) return Number(v._seconds) * 1000 + Number(v._nanoseconds || 0) / 1e6;
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
      const parsed = Date.parse(String(v || ""));
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const pnlOf = p => Number(p.realizedPnl ?? p.pnl ?? 0) || 0;
    const sortedClosed = [...closed].sort((a,b) => timeOf(b) - timeOf(a));
    const wins = closed.filter(p => pnlOf(p) > 0);
    const losses = closed.filter(p => pnlOf(p) < 0);
    const breakeven = closed.filter(p => pnlOf(p) === 0);
    const grossWin = wins.reduce((s,p) => s + pnlOf(p), 0);
    const grossLoss = Math.abs(losses.reduce((s,p) => s + pnlOf(p), 0));
    const avgWin = wins.length ? grossWin / wins.length : null;
    const avgLoss = losses.length ? grossLoss / losses.length : null;
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? null : 0);

    let currentWinStreak = 0, currentLossStreak = 0;
    for (const p of sortedClosed) {
      const v = pnlOf(p);
      if (v > 0 && currentLossStreak === 0) currentWinStreak++;
      else break;
    }
    for (const p of sortedClosed) {
      const v = pnlOf(p);
      if (v < 0 && currentWinStreak === 0) currentLossStreak++;
      else break;
    }

    const byDay = new Map();
    const bySymbol = new Map();
    for (const p of closed) {
      const v = pnlOf(p);
      const t = timeOf(p);
      const day = t ? new Intl.DateTimeFormat("en-CA", { timeZone:"Asia/Kolkata", year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date(t)) : "Unknown";
      const symbol = String(p.symbol || "Unknown");
      byDay.set(day, (byDay.get(day) || 0) + v);
      bySymbol.set(symbol, (bySymbol.get(symbol) || 0) + v);
    }

    const account = {
      ...data,
      balance: Number(data.balance ?? data.startingBalance ?? 0),
      equity: Number(data.equity ?? data.balance ?? data.startingBalance ?? 0),
      pnl: Number(data.pnl ?? 0),
      openPnl: Number(data.openPnl ?? 0),
      dailyDrawdownPct: Number(data.dailyDrawdownPct || 0),
      maxDrawdownPct: Number(data.maxDrawdownPct || 0),
      dailyDrawdownLimit: Number(data.dailyDrawdownLimit ?? data.dailyDrawdown ?? 4),
      maxDrawdownLimit: Number(data.maxDrawdownLimit ?? data.maxDrawdown ?? 10),
      openPositionsCount: open.length,
      totalTrades: closed.length,
      winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
      avgWin, avgLoss,
      profitFactor,
      bestTrade: wins.length ? Math.max(...wins.map(pnlOf)) : null,
      worstTrade: losses.length ? Math.min(...losses.map(pnlOf)) : null,
      currentWinStreak,
      currentLossStreak,
      breakevenTrades: breakeven.length,
      performanceByDay: [...byDay.entries()].sort((a,b) => b[0].localeCompare(a[0])).slice(0,10).map(([day,value]) => ({day,value})),
      performanceBySymbol: [...bySymbol.entries()].sort((a,b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0,10).map(([symbol,value]) => ({symbol,value}))
    };

    res.set("Cache-Control", "no-store");
    res.json({ account });
  } catch (e) {
    console.error("DASHBOARD_STATS_ERROR", e);
    res.status(500).json({ error:"Could not load dashboard statistics" });
  }
});
`;

source = source.replace(anchor, route + "\n" + anchor);
writeFileSync(target, source);
console.log("DASHBOARD_STATS_API=OK");
