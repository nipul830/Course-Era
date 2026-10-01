(function(){
  const CLOSED_KEY='auraClosedTrades:v5:';
  const OPEN_KEY='auraOpenTrades:v5:';
  const memory={};
  let activeKey='default';
  const money=v=>'$'+Number(v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  const pnl=v=>Number(v?.realizedPnl??v?.pnl??v?.profit??v?.profitLoss??0)||0;
  const read=(k,f)=>{try{const v=JSON.parse(localStorage.getItem(k)||'null');return v==null?f:v}catch(e){return f}};
  const write=(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}};
  const parts=v=>new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(v instanceof Date?v:new Date(v||Date.now()));
  function tradingDay(v){
    const d=v instanceof Date?v:new Date(v||Date.now());if(!Number.isFinite(d.getTime()))return '';
    const p=parts(d),g=t=>p.find(x=>x.type===t)?.value||'';let y=+g('year'),m=+g('month'),day=+g('day'),h=+g('hour');
    if(h<6){const z=new Date(Date.UTC(y,m-1,day)-86400000);y=z.getUTCFullYear();m=z.getUTCMonth()+1;day=z.getUTCDate();}
    return y+'-'+String(m).padStart(2,'0')+'-'+String(day).padStart(2,'0');
  }
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
  function ensureDailyBadge(){
    let el=document.getElementById('positionDailyPnl');if(el)return el;const row=document.querySelector('.sub-row');if(!row)return null;
    el=document.createElement('div');el.id='positionDailyPnl';el.setAttribute('aria-label','Today P&L');el.style.cssText='border:1px solid #dfe5e9;background:#fff;border-radius:12px;padding:8px 12px;font-size:13px;font-weight:800;color:#687786;white-space:nowrap;margin-left:auto';el.textContent='Today P&L +$0.00';
    const closeAll=document.getElementById('closeAllTrades');row.insertBefore(el,closeAll||null);if(closeAll)closeAll.style.marginLeft='8px';return el;
  }
  function setDailyPnl(closed){
    const el=ensureDailyBadge();if(!el)return;const today=tradingDay();let total=0;
    for(const t of closed||[]){const when=t?.closedAt||t?.closeTime||t?.closed_at||t?.close_time||t?.updatedAt||t?.updated_at;if(when&&tradingDay(when)===today)total+=pnl(t)}
    el.textContent='Today P&L '+(total>=0?'+':'-')+money(Math.abs(total));el.style.color=total>0?'#008a5b':total<0?'#e6004d':'#687786';el.style.borderColor=total>0?'#b9ead9':total<0?'#f2bfd0':'#dfe5e9';window.auraTodayPnl=total;
  }
  function cacheHistory(data){
    activeKey=accountKey(data);const closed=mergeClosed(activeKey,Array.isArray(data.closed)?data.closed:[]);const open=Array.isArray(data.open)?data.open:(Array.isArray(data.positions)?data.positions:[]);const openMap={};
    for(const p of open)if(idOf(p))openMap[idOf(p)]=p;
    memory[activeKey]={...(memory[activeKey]||{}),open:openMap};write(OPEN_KEY+activeKey,openMap);
    for(const t of closed){const id=idOf(t);if(id)delete openMap[id]}
    data.closed=closed;data.open=Object.values(openMap);setDailyPnl(closed);return data;
  }
  function rememberClosedFromClose(id,data){
    const m=memory[activeKey]||{},original=(m.open||{})[String(id)];if(!original)return;
    const closed={...original,status:'closed',closePrice:Number(data?.closePrice||original.currentPrice||original.entryPrice||0),realizedPnl:Number(data?.realizedPnl||0),closedAt:data?.closedAt||new Date().toISOString()};
    mergeClosed(activeKey,[closed]);if(m.open)delete m.open[String(id)];write(OPEN_KEY+activeKey,m.open||{});setDailyPnl(memory[activeKey]?.closed||[]);
  }
  function install(){ensureDailyBadge();const k=String(sessionStorage.getItem('auraTerminalAccountId')||'default');activeKey=k;setDailyPnl(mergeClosed(k,[]));window.auraUpdateDailyPnl=setDailyPnl;}
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
  setInterval(()=>{try{const c=memory[activeKey]?.closed||[];setDailyPnl(c)}catch(e){}},30000);
})();