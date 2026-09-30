from pathlib import Path

p=Path('terminal.html')
s=p.read_text()
old="""  mountChart('tvMobile',currentSymbol);\n  refreshMarket();\n  refreshTerminalAccount();"""
new="""  // Paint cached account state immediately; reconcile in background.\n  try{const cached=JSON.parse(sessionStorage.getItem('auraTerminalAccount')||'null');if(cached)renderTerminalAccount(cached);}catch{}\n  mountChart('tvMobile',currentSymbol);\n  refreshMarket();\n  refreshTerminalAccount();"""
if old in s:s=s.replace(old,new,1)
old="""async function loadChartCandles(symbol,interval){\n  if(chartDataRequest)return chartDataRequest;\n  chartDataRequest=(async()=>{\n    try{\n      const data=await terminalApi('/api/market/candles?symbol='+encodeURIComponent(symbol)+'&interval='+encodeURIComponent(interval));"""
new="""async function loadChartCandles(symbol,interval){\n  if(chartDataRequest)return chartDataRequest;\n  const cacheKey='auraCandleCache:'+symbol+':'+interval;\n  try{const cached=JSON.parse(sessionStorage.getItem(cacheKey)||'null');if(Array.isArray(cached?.candles)&&cached.candles.length&&candleSeries){candleSeries.setData(cached.candles);lightweightChart?.timeScale().fitContent();}}catch{}\n  chartDataRequest=(async()=>{\n    try{\n      const data=await terminalApi('/api/market/candles?symbol='+encodeURIComponent(symbol)+'&interval='+encodeURIComponent(interval));\n      try{sessionStorage.setItem(cacheKey,JSON.stringify({candles:data.candles||[],quote:data.quote||null,at:Date.now()}));}catch{}"""
if old in s:s=s.replace(old,new,1)
p.write_text(s)

p=Path('position.html')
s=p.read_text()
old="""async function loadPositions(){\n  await loadActiveAccountMeta();\n  const data=filterHistoryForSelectedAccount(await positionApi('/api/trading/history'));\n  renderPositionData(data);\n}"""
new="""async function loadPositions(){\n  // Render cached selected-account state immediately, then reconcile with server.\n  const cacheKey='auraPositionCache:'+terminalAccountId();\n  try{const cached=JSON.parse(sessionStorage.getItem(cacheKey)||'null');if(cached?.data)renderPositionData(cached.data);}catch{}\n  await loadActiveAccountMeta();\n  const data=filterHistoryForSelectedAccount(await positionApi('/api/trading/history'));\n  try{sessionStorage.setItem(cacheKey,JSON.stringify({data,at:Date.now()}));}catch{}\n  renderPositionData(data);\n}"""
if old in s:s=s.replace(old,new,1)
p.write_text(s)
