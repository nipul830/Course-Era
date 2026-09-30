import { readFileSync, writeFileSync } from 'node:fs';

const path = new URL('./server.js', import.meta.url);
let text = readFileSync(path, 'utf8');

const patches = [
  [
`async function refreshTradingAccount(uid, quotes) {
  const { ref, data } = await loadTradingAccount(uid);
  const positionSnap = await ref.collection("positions").where("status","==","open").get();
  const missingSymbols=[...new Set(positionSnap.docs.map(d=>d.data()?.symbol).filter(s=>s && !quotes?.[s]))];`,
`async function refreshTradingAccount(uid, quotes) {
  const { ref, data } = await loadTradingAccount(uid);
  const positionSnap = await ref.collection("positions").where("status","==","open").get();
  const missingSymbols=[...new Set(positionSnap.docs.map(d=>d.data()?.symbol).filter(s=>s && !quotes?.[s]))];
  // Keep old positions on the oldest purchased account and isolate all new
  // positions by the selected accountId.
  let legacyPositionOwnerId="";
  try {
    const legacySnap=await db.collection("users").doc(uid).collection("tradingAccounts")
      .orderBy("createdAt","asc").limit(1).get();
    if(!legacySnap.empty) legacyPositionOwnerId=String(legacySnap.docs[0].data()?.accountId||legacySnap.docs[0].id||"");
  } catch {}
  if(!legacyPositionOwnerId) legacyPositionOwnerId=String(data.accountId||"");`
  ],
  [
`  for (const d of positionSnap.docs) {
    const p = { id:d.id, ...d.data() };
    const q = Number(quotes[p.symbol]?.price || 0);`,
`  for (const d of positionSnap.docs) {
    const p = { id:d.id, ...d.data() };
    const positionAccountId=String(p.accountId||legacyPositionOwnerId||"");
    if(positionAccountId && positionAccountId!==String(data.accountId||"")) continue;
    const q = Number(quotes[p.symbol]?.price || 0);`
  ],
  [
`    await positionRef.set({
      symbol, side, lot:Number(lot.toFixed(4)), entryPrice,
      stopLoss:stopLoss===null?null:Number(stopLoss), takeProfit:takeProfit===null?null:Number(takeProfit),
      status:"open", openedAt:now, updatedAt:now
    });`,
`    await positionRef.set({
      accountId:String(data.accountId||""),
      symbol, side, lot:Number(lot.toFixed(4)), entryPrice,
      stopLoss:stopLoss===null?null:Number(stopLoss), takeProfit:takeProfit===null?null:Number(takeProfit),
      status:"open", openedAt:now, updatedAt:now
    });`
  ],
  [
`    const p=snap.data();
    if(p.status!=="open") return res.status(409).json({error:"Position is already closed"});`,
`    const p=snap.data();
    if(p.status!=="open") return res.status(409).json({error:"Position is already closed"});
    const currentAccountId=String(req.terminal?.account?.accountId||"");
    if(p.accountId && String(p.accountId)!==currentAccountId) {
      return res.status(403).json({error:"Position belongs to another trading account"});
    }`
  ]
];

for (const [from, to] of patches) {
  if (text.includes(to)) continue;
  if (!text.includes(from)) throw new Error('Selected-account patch anchor not found');
  text = text.replace(from, to);
}

writeFileSync(path, text);
console.log('SELECTED_ACCOUNT_TRADE_ISOLATION=OK');
