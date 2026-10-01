(function(){
  const CLOSED_KEY='auraClosedTrades:v3:';
  const OPEN_KEY='auraOpenTrades:v3:';
  const memory={};
  const money=v=>'$'+Number(v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  const pnl=v=>Number(v?.realizedPnl??v?.pnl??v?.profit??v?.profitLoss??0)||0;
  const partsFor=v=>new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(v instanceof Date?v:new Date(v));
  function tradingDay(v){
    const d=v instanceof Date?v:new Date(v||Date.now());
    if(!Number.isFinite(d.getTime()))return '';
    const p=partsFor(d),get=t=>p.find(x=>x.type===t)?.value||'';
    let y=Number(get('year')),m=Number(get('month')),day=Number(get('day')),h=Number(get('hour'));
    if(h<6){const prev=new Date(Date.UTC(y,m-1,day)-86400000);y=prev.getUTCFullYear();m=prev.getUTCMonth()+1;day=prev.getUTCDate();}
    return y+'-'+String(m).padStart(2,'0')+'-'+String(day).padStart(2,'0');
  }
  function tradeDay(v){return tradingDay(v);}
  function read(key,fallback){try{return JSON.parse(localStorage.getItem(key)||JSON.stringify(fallback));}catch(e){return fallback;}}
  function write(key,value){try{localStorage.setItem(key,JSON.stringify(value));}catch(e){}}
  function idOf(v){return String(v?.id||v?._id||v?.ticket||'');}
  function merge(list){
    const out=[],seen=new Set();
    for(const x of list||[]){const id=idOf(x);if(!id||seen.has(id))continue;seen.add(id);out.push(x);}
    return out;
  }
  function accountKey(data){return String(data?.account?.id||data?.account?.accountId||data?.account?.uid||data?.uid||sessionStorage.getItem('auraTerminalAccountId')||'default');}
  function ensureDailyBadge(){
    let el=document.getElementById('positionDailyPnl');
    if(el)return el;
    const row=document.querySelector('.sub-row');
    if(!row)return null;
    el=document.createElement('div');
    el.id='positionDailyPnl';
    el.setAttribute('aria-label','Today P&L');
    el.style.cssText='border:1px solid #dfe5e9;background:#fff;border-radius:12px;padding:8px 12px;font-size:13px;font-weight:800;color:#687786;white-space:nowrap;margin-left:auto;';
    el.textContent='Today P&L +$0.00';
    const closeAll=document.getElementById('closeAllTrades');
    row.insertBefore(el,closeAll||null);
    if(closeAll){closeAll.style.marginLeft='8px';}
    return el;
  }
  function setDailyPnl(closed,data){
    const el=ensureDailyBadge();
    if(!el)return;
    const today=tradingDay();
    let total=0;
    for(const t of closed||[]){
      const when=t?.closedAt||t?.closeTime||t?.closed_at||t?.close_time||t?.updatedAt||t?.updated_at;
      if(when && tradeDay(when)===today)total+=pnl(t);
    }
    el.textContent='Today P&L '+(total>=0?'+':'-')+money(Math.abs(total));
    el.style.color=total>0?'#008a5b':total<0?'#e6004d':'#687786';
    el.style.borderColor=total>0?'#b9ead9':total<0?'#f2bfd0':'#dfe5e9';
    window.auraTodayPnl=total;
  }
  function cacheClosed(key,items){
    const merged=merge([...(memory[key]?.closed||[]),...read(CLOSED_KEY+key,[]),...(items||[])]).slice(0,5000);
    memory[key]={...(memory[key]||{}),closed:merged};
    write(CLOSED_KEY+key,merged);
    return merged;
  }
  function cacheOpen(key,items){
    const map={};for(const p of items||[])if(p?.id)map[String(p.id)]=p;
    memory[key]={...(memory[key]||{}),open:map};write(OPEN_KEY+key,map);return map;
  }
  function install(){
    ensureDailyBadge();
    window.auraUpdateDailyPnl=setDailyPnl;
    setTimeout(()=>setDailyPnl([],null),0);
  }

  const nativeFetch=window.fetch.bind(window);
  window.fetch=async function(input,init){
    const url=typeof input==='string'?input:(input?.url||'');
    const method=String(init?.method||input?.method||'GET').toUpperCase();
    const isHistory=/\/api\/trading\/history(?:\?|$)/.test(url);
    if(!isHistory)return nativeFetch(input,init);
    const response=await nativeFetch(input,init);
    try{
      const data=await response.clone().json();
      const key=accountKey(data);
      const serverClosed=Array.isArray(data.closed)?data.closed:[];
      const merged=cacheClosed(key,serverClosed);
      const open=Array.isArray(data.open)?data.open:(Array.isArray(data.positions)?data.positions:[]);
      const openMap=cacheOpen(key,open);
      for(const t of merged)if(t?.id)delete openMap[String(t.id)];
      write(OPEN_KEY+key,openMap);if(memory[key])memory[key].open=openMap;
      data.closed=merged;
      setDailyPnl(merged,data);
      return new Response(JSON.stringify(data),{status:response.status,statusText:response.statusText,headers:response.headers});
    }catch(e){return response;}
  };

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
  setInterval(()=>{
    try{
      const key=Object.keys(memory)[0];
      if(key)setDailyPnl(memory[key].closed||[],null);
    }catch(e){}
  },30000);
})();
