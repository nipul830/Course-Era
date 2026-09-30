import fs from 'node:fs';

const serverPath = 'backend/server.js';
const positionPath = 'position.html';

let server = fs.readFileSync(serverPath, 'utf8');
let position = fs.readFileSync(positionPath, 'utf8');

const serverAnchor = `    res.json({\n      account:{id:data.accountId||"account",balance:Number(data.balance??data.startingBalance??0),equity:Number(data.equity??data.balance??data.startingBalance??0),challenge:data.challenge||data.accountType||data.plan||""},\n      open,pending,closed\n    });`;

const serverReplacement = `    const leverageForKind = kind => ({ crypto:10, gold:50, forex:100, "forex-jpy":100 }[String(kind||"")] || null);\n    const accountBalance = Number(data.balance??data.startingBalance??0);\n    const accountEquity = Number(data.equity??accountBalance);\n    let usedMargin = 0;\n    for (const p of open) {\n      const spec = MARKET_SYMBOLS[p.symbol];\n      const leverage = leverageForKind(spec?.kind);\n      const px = Number(p.currentPrice||p.entryPrice||0);\n      const lot = Number(p.lot||0);\n      if (!spec || !leverage || !px || !lot) {\n        p.leverage = leverage || null;\n        p.marginUsed = 0;\n        continue;\n      }\n      // USDJPY has USD as the base currency, so margin is based on the\n      // contract quantity rather than multiplying by the JPY quote price.\n      const notional = spec.kind === "forex-jpy"\n        ? Math.abs(lot * spec.contractSize)\n        : Math.abs(px * lot * spec.contractSize);\n      p.leverage = leverage;\n      p.marginUsed = Number((notional / leverage).toFixed(2));\n      usedMargin += p.marginUsed;\n    }\n    usedMargin = Number(usedMargin.toFixed(2));\n    const freeMargin = Number((accountEquity - usedMargin).toFixed(2));\n    const marginLevel = usedMargin > 0 ? Number(((accountEquity / usedMargin) * 100).toFixed(2)) : null;\n    const riskFactor = usedMargin <= 0 ? "Safe" : marginLevel >= 200 ? "Safe" : marginLevel >= 100 ? "Medium" : "High";\n    res.json({\n      account:{id:data.accountId||"account",balance:accountBalance,equity:accountEquity,challenge:data.challenge||data.accountType||data.plan||"",leverage:leverageForKind(open[0] ? MARKET_SYMBOLS[open[0].symbol]?.kind : "") || null,margin:usedMargin,freeMargin,marginLevel,riskFactor},\n      open,pending,closed\n    });`;

if (!server.includes(serverAnchor)) throw new Error('server history response anchor not found');
server = server.replace(serverAnchor, serverReplacement);

const leverageDetailAnchor = `<div class="account-detail"><span class="detail-label">Margin</span><span class="detail-value" id="detailPositionMargin">—</span></div>`;
const leverageDetailReplacement = `${leverageDetailAnchor}<div class="account-detail"><span class="detail-label">Leverage</span><span class="detail-value" id="detailPositionLeverage">—</span></div>`;
if (!position.includes(leverageDetailAnchor)) throw new Error('position margin detail anchor not found');
position = position.replace(leverageDetailAnchor, leverageDetailReplacement);

const metricsAnchor = `const eq=liveBalance+initialPnl; const setp=(id,v)=>{const el=document.getElementById(id);if(el)el.textContent=v}; setp('detailPositionEquity',money(eq)); setp('detailPositionMargin','—'); setp('detailPositionFreeMargin',money(eq)); setp('detailPositionMarginLevel','—'); setp('detailPositionRisk','Safe'); setp('detailPositionStatus','LIVE');`;
const metricsReplacement = `const eq=liveBalance+initialPnl; const setp=(id,v)=>{const el=document.getElementById(id);if(el)el.textContent=v}; setp('detailPositionEquity',money(eq)); setp('detailPositionMargin',money(Number(data.account?.margin||0))); setp('detailPositionFreeMargin',money(Number(data.account?.freeMargin??eq))); setp('detailPositionMarginLevel',data.account?.marginLevel==null?'∞':Number(data.account.marginLevel).toFixed(2)+'%'); setp('detailPositionLeverage',data.account?.leverage?('1:'+data.account.leverage):'—'); setp('detailPositionRisk',data.account?.riskFactor||'Safe'); setp('detailPositionStatus','LIVE');`;
if (!position.includes(metricsAnchor)) throw new Error('position metrics anchor not found');
position = position.replace(metricsAnchor, metricsReplacement);

const paintAnchor = `function paintLivePositions(){`;
const paintReplacement = `function updateLiveMarginMetrics(){\n  const eq = liveBalance + livePositions.reduce((sum,p)=>sum+calcLivePnl(p,Number(p.currentPrice||p.entryPrice||0)),0);\n  let margin = 0;\n  for(const p of livePositions){\n    const lev = Number(p.leverage||0);\n    const lot = Number(p.lot||0);\n    const px = Number(p.currentPrice||p.entryPrice||0);\n    const spec = p.symbol==='OANDA:XAUUSD' ? {contractSize:100,kind:'gold'} :\n      ['FX:EURUSD','FX:GBPUSD','FX:AUDUSD'].includes(p.symbol) ? {contractSize:100000,kind:'forex'} :\n      p.symbol==='FX:USDJPY' ? {contractSize:100000,kind:'forex-jpy'} :\n      ['BINANCE:BTCUSDT','BINANCE:ETHUSDT','BINANCE:SOLUSDT','BINANCE:XRPUSDT'].includes(p.symbol) ? {contractSize:1,kind:'crypto'} : null;\n    if(!spec||!lev||!lot||!px)continue;\n    const notional = spec.kind==='forex-jpy' ? Math.abs(lot*spec.contractSize) : Math.abs(px*lot*spec.contractSize);\n    margin += notional/lev;\n  }\n  margin=Number(margin.toFixed(2));\n  const free=Number((eq-margin).toFixed(2));\n  const level=margin>0 ? (eq/margin)*100 : null;\n  const risk=margin<=0 ? 'Safe' : level>=200 ? 'Safe' : level>=100 ? 'Medium' : 'High';\n  const setp=(id,v)=>{const el=document.getElementById(id);if(el)el.textContent=v};\n  setp('detailPositionEquity',money(eq)); setp('detailPositionMargin',money(margin)); setp('detailPositionFreeMargin',money(free)); setp('detailPositionMarginLevel',level==null?'∞':level.toFixed(2)+'%'); setp('detailPositionRisk',risk);\n}\n\nfunction paintLivePositions(){`;
if (!position.includes(paintAnchor)) throw new Error('paintLivePositions anchor not found');
position = position.replace(paintAnchor, paintReplacement);

const paintCallAnchor = `  const dp=document.getElementById('detailPositionPnl'); if(dp){dp.textContent=(openPnl>=0?'+':'')+money(openPnl);dp.classList.toggle('negative',openPnl<0);}\n}`;
const paintCallReplacement = `  const dp=document.getElementById('detailPositionPnl'); if(dp){dp.textContent=(openPnl>=0?'+':'')+money(openPnl);dp.classList.toggle('negative',openPnl<0);} updateLiveMarginMetrics();\n}`;
if (!position.includes(paintCallAnchor)) throw new Error('paint margin call anchor not found');
position = position.replace(paintCallAnchor, paintCallReplacement);

fs.writeFileSync(serverPath, server);
fs.writeFileSync(positionPath, position);

fs.unlinkSync('scripts/apply-margin-risk.js');
fs.unlinkSync('.github/workflows/apply-margin-risk.yml');
