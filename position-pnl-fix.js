(function(){
  function tradingDay(){
    const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date());
    const get=t=>parts.find(x=>x.type===t)?.value||'';
    let y=Number(get('year')),m=Number(get('month')),d=Number(get('day')),h=Number(get('hour'));
    if(h<6){const prev=new Date(Date.UTC(y,m-1,d)-86400000);y=prev.getUTCFullYear();m=prev.getUTCMonth()+1;d=prev.getUTCDate();}
    return y+'-'+String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0');
  }

  function pnl(v){return Number(v?.realizedPnl??v?.pnl??0)||0;}
  function validDate(v){const d=new Date(v);return v&&Number.isFinite(d.getTime())?d:null;}

  function update(data){
    const summary=document.getElementById('positionDailyPnl');
    if(!summary)return;
    const closed=Array.isArray(data?.closed)?data.closed:[];
    const day=tradingDay();
    const accountId=String(data?.account?.id||data?.account?.accountId||'account');
    const storageKey='auraDailyPnlSeen:'+accountId;
    let seen=new Set();
    try{seen=new Set(JSON.parse(localStorage.getItem(storageKey)||'[]'));}catch(e){}
    let total=0;

    for(const trade of closed){
      const when=validDate(trade?.closedAt||trade?.closeTime||trade?.closed_at||trade?.updatedAt||trade?.updated_at||trade?.createdAt||trade?.created_at);
      if(when){
        const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(when);
        const get=t=>parts.find(x=>x.type===t)?.value||'';
        let y=Number(get('year')),m=Number(get('month')),d=Number(get('day')),h=Number(get('hour'));
        if(h<6){const prev=new Date(Date.UTC(y,m-1,d)-86400000);y=prev.getUTCFullYear();m=prev.getUTCMonth()+1;d=prev.getUTCDate();}
        const tradeDay=y+'-'+String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0');
        if(tradeDay===day)total+=pnl(trade);
        continue;
      }

      const id=String(trade?.id||'').trim();
      if(id && !seen.has(id)){
        total+=pnl(trade);
        seen.add(id);
      }
    }

    try{localStorage.setItem(storageKey,JSON.stringify([...seen].slice(-5000)));}catch(e){}
    summary.textContent='Today P&L '+(total>=0?'+':'-')+auraMoney(Math.abs(total));
    summary.style.color=total>0?'#008a5b':total<0?'#e6004d':'#687786';
    summary.style.borderColor=total>0?'#b9ead9':total<0?'#f2bfd0':'#dfe5e9';
  }

  function install(){
    if(typeof window.auraUpdateDailyPnl==='function')window.auraUpdateDailyPnl=update;
    else window.auraUpdateDailyPnl=update;
    if(typeof window.auraSyncDailyPnl==='function')window.auraSyncDailyPnl();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();
