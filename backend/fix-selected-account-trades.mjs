import { readFileSync, writeFileSync } from 'node:fs';

const serverPath = new URL('./server.js', import.meta.url);
let server = readFileSync(serverPath, 'utf8');

const patches = [
  ['const now=Date.now(), out={}, freshForMs=200;', 'const now=Date.now(), out={}, freshForMs=1000;'],
  ['    const quotes=await getMarketQuotes([symbol]);\n    const quote=quotes[symbol];\n    if (!quote?.price) return res.status(502).json({error:"No live market price available"});', '    let quote=quoteCache.get(symbol);\n    if (!quote?.price || Date.now()-Number(quote.fetchedAt||0)>1500) {\n      const quotes=await getMarketQuotes([symbol]);\n      quote=quotes[symbol];\n    }\n    if (!quote?.price) return res.status(502).json({error:"No live market price available"});'],
  ['    await positionRef.set({\n      symbol, side, lot:Number(lot.toFixed(4)), entryPrice,', '    await positionRef.set({\n      accountId:String(data.accountId||""),\n      symbol, side, lot:Number(lot.toFixed(4)), entryPrice,'],
  ['    const symbols=[...new Set(open.map(p=>p.symbol).filter(Boolean))];\n    if(symbols.length){\n      try {\n        const quotes=await getMarketQuotes(symbols);\n        for(const p of open) p.currentPrice=Number(quotes[p.symbol]?.price||p.currentPrice||p.entryPrice||0);\n      } catch(e) {}\n    }', '    const selectedAccountId=String(data.accountId||"").trim();\n    const accountCreatedAt=(()=>{const v=data.createdAt;return v?.toMillis?.() || (v?._seconds ? Number(v._seconds)*1000 : 0);})();\n    const accountScoped=all.filter(p=>{\n      const pid=String(p.accountId||p.tradingAccountId||p.account?.accountId||"").trim();\n      if(pid) return !selectedAccountId || pid===selectedAccountId;\n      const tradeTime=Date.parse(p.openedAt||p.createdAt||p.closedAt||"")||0;\n      return !accountCreatedAt || !tradeTime || tradeTime>=accountCreatedAt;\n    });\n    const scopedOpen=accountScoped.filter(p=>p.status==="open");\n    const scopedPending=accountScoped.filter(p=>p.status==="pending");\n    const scopedClosed=accountScoped.filter(p=>p.status==="closed").sort((a,b)=>(Date.parse(b.closedAt||"")||0)-(Date.parse(a.closedAt||"")||0));\n    for(const p of scopedOpen){const cached=quoteCache.get(p.symbol);p.currentPrice=Number(cached?.price||p.currentPrice||p.entryPrice||0);}'],
  ['      open,pending,closed\n    });', '      open:scopedOpen,pending:scopedPending,closed:scopedClosed\n    });'],
  ['    const fastAccount={\n      id:data.accountId || "account",\n      balance:fastBalance,\n      equity:fastBalance+fastOpenPnl,\n      pnl:fastBalance-Number(data.startingBalance || fastBalance),\n      openPnl:fastOpenPnl,\n      status:data.status || "active"\n    };\n    res.status(201).json({\n      message:"Market order executed",\n      position:{id:positionRef.id,symbol,side,lot:lotValue,entryPrice,stopLoss,takeProfit},\n      account:fastAccount\n    });\n    refreshTradingAccount(req.user.uid,quotes).catch(()=>{});', '    const fastEquity=fastBalance+fastOpenPnl;\n    const fastAccount={\n      id:data.accountId || "account",\n      balance:fastBalance,\n      equity:fastEquity,\n      pnl:fastBalance-Number(data.startingBalance || fastBalance),\n      openPnl:fastOpenPnl,\n      status:data.status || "active"\n    };\n    // Persist opening-state equity immediately. Do not run full reconciliation\n    // in the order request; normal position polling performs SL/TP reconciliation.\n    await ref.update({\n      equity:fastEquity,\n      openPnl:fastOpenPnl,\n      updatedAt:admin.firestore.FieldValue.serverTimestamp()\n    });\n    res.status(201).json({\n      message:"Market order executed",\n      position:{id:positionRef.id,symbol,side,lot:lotValue,entryPrice,stopLoss,takeProfit},\n      account:fastAccount\n    });'],
  ['    refreshTradingAccount(req.user.uid,quotes).catch(()=>{});', ''],
  ['    if (q && p.stopLoss != null) {', '    const entryPrice=Number(p.entryPrice||0);\n    const stopLossValue=Number(p.stopLoss);\n    const takeProfitValue=Number(p.takeProfit);\n    const validStopLoss=Number.isFinite(stopLossValue) && stopLossValue>0 && ((p.side==="BUY" && stopLossValue<entryPrice) || (p.side==="SELL" && stopLossValue>entryPrice));\n    const validTakeProfit=Number.isFinite(takeProfitValue) && takeProfitValue>0 && ((p.side==="BUY" && takeProfitValue>entryPrice) || (p.side==="SELL" && takeProfitValue<entryPrice));\n    if (q && validStopLoss) {'],
  ['    if (q && !exitPrice && p.takeProfit != null) {', '    if (q && !exitPrice && validTakeProfit) {']
];

for (const [from,to] of patches) {
  if (server.includes(to)) continue;
  if (!server.includes(from)) continue;
  server = server.replace(from,to);
}

writeFileSync(serverPath,server);

const terminalPath = new URL('../terminal.html', import.meta.url);
let terminal = readFileSync(terminalPath,'utf8');
const terminalFrom='    const hitSL=Number.isFinite(sl)&&sl>0&&((side===\'BUY\'&&price<=sl)||(side===\'SELL\'&&price>=sl));\n    const hitTP=Number.isFinite(tp)&&tp>0&&((side===\'BUY\'&&price>=tp)||(side===\'SELL\'&&price<=tp));';
const terminalTo='    // Server is the single authority for SL/TP execution. Never close a trade from the UI tick loop.\n    const hitSL=false;\n    const hitTP=false;';
if(terminal.includes(terminalTo)===false && terminal.includes(terminalFrom)) terminal=terminal.replace(terminalFrom,terminalTo);
writeFileSync(terminalPath,terminal);

const positionPath = new URL('../position.html', import.meta.url);
let position = readFileSync(positionPath,'utf8');
const positionFrom=`  await loadActiveAccountMeta();\n  const data=filterHistoryForSelectedAccount(await positionApi('/api/trading/history'));\n  try{sessionStorage.setItem(cacheKey,JSON.stringify({data,at:Date.now()}));}catch{}\n  renderPositionData(data);`;
const positionTo=`  const rawData=await positionApi('/api/trading/history');\n  const data=filterHistoryForSelectedAccount(rawData);\n  try{sessionStorage.setItem(cacheKey,JSON.stringify({data,at:Date.now()}));}catch{}\n  renderPositionData(data);\n  loadActiveAccountMeta().then(()=>{\n    const filtered=filterHistoryForSelectedAccount(rawData);\n    try{sessionStorage.setItem(cacheKey,JSON.stringify({data:filtered,at:Date.now()}));}catch{}\n    renderPositionData(filtered);\n  }).catch(()=>{});`;
if(position.includes(positionFrom)) position=position.replace(positionFrom,positionTo);
writeFileSync(positionPath,position);

console.log('TERMINAL_POSITION_PERFORMANCE_PATCH=OK');
