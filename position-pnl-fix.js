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
  function sameTrade(a,b){const ai=idOf(a),bi=idOf(b);if(ai&&bi)return ai===bi;return String(a?.symbol||'')+'|'+String(a?.side||'')+'|'+String(a?.openedAt||a?.entryPrice||'')===String(b?.symbol||'')+'|'+String(b?.side||'')+'|'+String(b?.openedAt||b?.entryPrice||'');}
  function closedTime(x){return x?.closedAt||x?.closeTime||x?.closed_at||x?.close_time||x?.updatedAt||x?.timestamp||x?.dailyRecordedAt||'';}
  function parseTime(value){
    if(value==null||value==='')return NaN;
    if(typeof value==='number')return value<1e12?value*1000:value;
    if(typeof value==='object'){
      if(typeof value.toMillis==='function'){try{return value.toMillis()}catch(e){}}
      if(typeof value._seconds==='number')return value._seconds*1000+Math.floor((value._nanoseconds||0)/1e6);
      if(typeof value.seconds==='number')return value.seconds*1000+Math.floor((value.nanoseconds||0)/1e6);
    }
    const t=Date.parse(String(value));
    return Number.isFinite(t)?t:NaN;
  }
  function mergeClosed(acct,items){
    const store=CLOSED_KEY+acct;
    const existing=[...(memory[acct]?.closed||[]),...read(store,[]),...(items||[])],out=[];
    for(const raw of existing){
      if(!raw||typeof raw!=='object')continue;
      const x={...raw};
      // Do NOT stamp old history with the current time. Those trades have no
      // reliable close timestamp and must not be counted in today's P&L.
      const i=out.findIndex(y=>sameTrade(y,x));
      if(i<0)out.push(x);else out[i]={...out[i],...x};
    }
    memory[acct]={...(memory[acct]||{}),closed:out};
    write(store,out);
    return out;
  }
  function dailyStart(){
    const now=new Date();
    const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hour12:false}).formatToParts(now);
    const p={};parts.forEach(x=>p[x.type]=x.value);
    let y=Number(p.year),m=Number(p.month),d=Number(p.day),h=Number(p.hour);
    if(h<6){const prev=new Date(Date.UTC(y,m-1,d)-86400000);y=prev.getUTCFullYear();m=prev.getUTCMonth()+1;d=prev.getUTCDate();}
    return Date.UTC(y,m-1,d,0,30,0,0);
  }
  function isAfterDailyReset(x){const t=parseTime(closedTime(x));return Number.isFinite(t)&&t>=dailyStart();}
  function getDailyPnl(){const list=memory[activeKey]?.closed||[];return list.filter(isAfterDailyReset).reduce((s,x)=>s+pnl(x),0);}
  function renderDailyPnl(){
    const positions=document.getElementById('positions'),tabs=document.querySelector('.tabs');if(!positions||!tabs)return;
    let box=document.getElementById('dailyPnlBox');
    if(!box){box=document.createElement('div');box.id='dailyPnlBox';box.innerHTML='<div class="daily-pnl-label">Daily P&L</div><div class="daily-pnl-value" id="dailyPnlValue">$0.00</div>';positions.parentNode.insertBefore(box,positions);}
    const closedTab=document.querySelector('.tab[data-tab="closed"]');const show=closedTab?.classList.contains('active');box.style.display=show?'flex':'none';
    if(show){const v=getDailyPnl(),el=document.getElementById('dailyPnlValue');if(el){el.textContent=(v>=0?'+':'')+money(v);el.classList.toggle('positive',v>=0);el.classList.toggle('negative',v<0);}}
  }
  function scheduleDailyRefresh(){clearTimeout(window.__auraDailyPnlTimer);const next=dailyStart()+86400000;window.__auraDailyPnlTimer=setTimeout(()=>{renderDailyPnl();scheduleDailyRefresh();},Math.max(1000,next-Date.now()+100));}
  function setDailyPnl(){window.auraTodayPnl=getDailyPnl();renderDailyPnl();}
  function cacheHistory(data){
    activeKey=accountKey(data);
    const closed=mergeClosed(activeKey,Array.isArray(data.closed)?data.closed:[]);
    const open=Array.isArray(data.open)?data.open:(Array.isArray(data.positions)?data.positions:[]),openMap={};
    for(const p of open)if(idOf(p))openMap[idOf(p)]=p;
    memory[activeKey]={...(memory[activeKey]||{}),open:openMap};write(OPEN_KEY+activeKey,openMap);
    for(const t of closed){const id=idOf(t);if(id)delete openMap[id];}
    data.closed=closed;data.open=Object.values(openMap);setDailyPnl();return data;
  }
  function rememberClosedFromClose(id,data){
    const m=memory[activeKey]||{},original=(m.open||{})[String(id)];if(!original)return;
    const closed={...original,status:'closed',closePrice:Number(data?.closePrice||original.currentPrice||original.entryPrice||0),realizedPnl:Number(data?.realizedPnl??data?.pnl??0),closedAt:data?.closedAt||data?.closeTime||new Date().toISOString()};
    mergeClosed(activeKey,[closed]);if(m.open)delete m.open[String(id)];write(OPEN_KEY+activeKey,m.open||{});setDailyPnl();
  }
  function install(){
    const k=String(sessionStorage.getItem('auraTerminalAccountId')||'default');activeKey=k;mergeClosed(k,[]);window.auraUpdateDailyPnl=setDailyPnl;
    const wire=()=>{document.querySelectorAll('.tab[data-tab]').forEach(tab=>tab.addEventListener('click',()=>setTimeout(renderDailyPnl,0)));renderDailyPnl();scheduleDailyRefresh();};
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',wire,{once:true});else wire();
  }
  // Prevent HTTP 429 rate limiting while keeping position refresh fast.
  const nativeSetInterval=window.setInterval.bind(window);window.setInterval=function(fn,delay,...args){try{const source=String(fn);if(Number(delay)===3000&&source.includes('loadPositions()'))delay=1000;}catch(e){}return nativeSetInterval(fn,delay,...args);};
  const nativeFetch=window.fetch.bind(window);
  window.fetch=async function(input,init){
    const url=typeof input==='string'?input:(input?.url||''),method=String(init?.method||input?.method||'GET').toUpperCase(),response=await nativeFetch(input,init);
    try{
      const data=await response.clone().json();
      if(/\/api\/trading\/history(?:\?|$)/.test(url)){const fixed=cacheHistory(data),h=new Headers(response.headers);h.delete('content-length');h.delete('content-encoding');h.delete('etag');return new Response(JSON.stringify(fixed),{status:response.status,statusText:response.statusText,headers:h});}
      const m=url.match(/\/api\/trading\/positions\/([^/?]+)\/close(?:\?|$)/);if(m&&method==='POST')rememberClosedFromClose(decodeURIComponent(m[1]),data);
    }catch(e){}
    return response;
  };
  const style=document.createElement('style');style.textContent='#dailyPnlBox{display:none;align-items:center;justify-content:space-between;gap:8px;margin:0 0 8px;padding:7px 12px;border:1px solid #e0e5e9;border-radius:10px;background:#fff;box-shadow:0 2px 8px #0000000b;min-height:0}.daily-pnl-label{font-size:11px;font-weight:800;color:#687786;line-height:1.2}.daily-pnl-value{font-size:16px;font-weight:900;line-height:1.2;color:#008a5b}.daily-pnl-value.negative{color:#e6004d}';document.head.appendChild(style);
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();