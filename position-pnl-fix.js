(function(){
  const CLOSED_KEY='auraClosedTrades:v5:';
  const OPEN_KEY='auraOpenTrades:v5:';
  const memory={};
  let activeKey='default';
  const money=v=>'$'+Number(v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  const pnl=v=>Number(v?.realizedPnl??v?.pnl??v?.profit??v?.profitLoss??0)||0;
  const read=(k,f)=>{try{const v=JSON.parse(localStorage.getItem(k)||'null');return v==null?f:v}catch(e){return f}};
  const write=(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}};
  function accountKey(data){return String(data?.account?.id||data?.account?.accountId||data?.account?.uid||data?.uid||sessionStorage.getItem('auraTerminalAccountId')||'default');}
  function idOf(x){return String(x?.id||x?._id||x?.ticket||'');}
  function sameTrade(a,b){
    const ai=idOf(a),bi=idOf(b);if(ai&&bi)return ai===bi;
    return String(a?.symbol||'')+'|'+String(a?.side||'')+'|'+String(a?.openedAt||a?.entryPrice||'')===String(b?.symbol||'')+'|'+String(b?.side||'')+'|'+String(b?.openedAt||b?.entryPrice||'');
  }
  function mergeClosed(acct,items){
    const store=CLOSED_KEY+acct,existing=[...(memory[acct]?.closed||[]),...read(store,[]),...(items||[])],out=[];
    for(const x of existing){if(!x||typeof x!=='object')continue;const i=out.findIndex(y=>sameTrade(y,x));if(i<0)out.push(x);else out[i]={...out[i],...x};}
    memory[acct]={...(memory[acct]||{}),closed:out};write(store,out);return out;
  }
  function setDailyPnl(){ window.auraTodayPnl=0; }
  function cacheHistory(data){
    activeKey=accountKey(data);const closed=mergeClosed(activeKey,Array.isArray(data.closed)?data.closed:[]);const open=Array.isArray(data.open)?data.open:(Array.isArray(data.positions)?data.positions:[]);const openMap={};
    for(const p of open)if(idOf(p))openMap[idOf(p)]=p;
    memory[activeKey]={...(memory[activeKey]||{}),open:openMap};write(OPEN_KEY+activeKey,openMap);
    for(const t of closed){const id=idOf(t);if(id)delete openMap[id]}
    data.closed=closed;data.open=Object.values(openMap);setDailyPnl();return data;
  }
  function rememberClosedFromClose(id,data){
    const m=memory[activeKey]||{},original=(m.open||{})[String(id)];if(!original)return;
    const closed={...original,status:'closed',closePrice:Number(data?.closePrice||original.currentPrice||original.entryPrice||0),realizedPnl:Number(data?.realizedPnl||0),closedAt:data?.closedAt||new Date().toISOString()};
    mergeClosed(activeKey,[closed]);if(m.open)delete m.open[String(id)];write(OPEN_KEY+activeKey,m.open||{});
  }
  function install(){const k=String(sessionStorage.getItem('auraTerminalAccountId')||'default');activeKey=k;mergeClosed(k,[]);window.auraUpdateDailyPnl=setDailyPnl;}

  // Position page used to wait up to 3 seconds for its next history poll.
  // Keep the existing polling logic/UI intact, but accelerate only the
  // specific loadPositions interval to 50ms so a new BUY/SELL appears almost instantly.
  const nativeSetInterval=window.setInterval.bind(window);
  window.setInterval=function(fn,delay,...args){
    try{
      const source=String(fn);
      if(Number(delay)===3000&&source.includes('loadPositions()'))delay=50;
    }catch(e){}
    return nativeSetInterval(fn,delay,...args);
  };

  const nativeFetch=window.fetch.bind(window);
  window.fetch=async function(input,init){
    const url=typeof input==='string'?input:(input?.url||''),method=String(init?.method||input?.method||'GET').toUpperCase();const response=await nativeFetch(input,init);
    try{
      const data=await response.clone().json();
      if(/\/api\/trading\/history(?:\?|$)/.test(url)){
        const fixed=cacheHistory(data),h=new Headers(response.headers);h.delete('content-length');h.delete('content-encoding');h.delete('etag');
        return new Response(JSON.stringify(fixed),{status:response.status,statusText:response.statusText,headers:h});
      }
      const m=url.match(/\/api\/trading\/positions\/([^/?]+)\/close(?:\?|$)/);if(m&&method==='POST')rememberClosedFromClose(decodeURIComponent(m[1]),data);
    }catch(e){}
    return response;
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();