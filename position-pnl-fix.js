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
  const CLOSED_KEY='auraClosedTrades:';
  const OPEN_KEY='auraOpenTrades:';
  const jsonKey=v=>String(v?.account?.id||v?.account?.accountId||'account');
  function read(key, fallback){try{return JSON.parse(localStorage.getItem(key)||JSON.stringify(fallback));}catch(e){return fallback;}}
  function write(key,value){try{localStorage.setItem(key,JSON.stringify(value));}catch(e){}}
  function mergeById(list){
    const out=[];const seen=new Set();
    for(const x of list||[]){const id=String(x?.id||'');if(!id||seen.has(id))continue;seen.add(id);out.push(x);}
    return out;
  }

  // Persist the last known trade state in the browser. The position page polls every 3s;
  // if a just-closed trade is temporarily absent from a server response, do not let that
  // refresh erase it from the Closed tab.
  const nativeFetch=window.fetch.bind(window);
  window.fetch=async function(input,init){
    const url=typeof input==='string'?input:(input?.url||'');
    const isHistory=/\/api\/trading\/history(?:\?|$)/.test(url);
    const isClose=/\/api\/trading\/positions\/[^/]+\/close(?:\?|$)/.test(url) && String(init?.method||input?.method||'GET').toUpperCase()==='POST';
    if(!isHistory&&!isClose)return nativeFetch(input,init);

    const response=await nativeFetch(input,init);
    try{
      const cloned=response.clone();
      const data=await cloned.json();
      if(isHistory){
        const key=jsonKey(data);
        const serverClosed=Array.isArray(data.closed)?data.closed:[];
        const oldClosed=read(CLOSED_KEY+key,[]);
        const mergedClosed=mergeById([...serverClosed,...oldClosed]);
        const open=Array.isArray(data.open)?data.open:[];
        const oldOpen=read(OPEN_KEY+key,{});
        for(const p of open)if(p?.id)oldOpen[String(p.id)]=p;
        // Keep the cached trade available until the server confirms it as closed.
        for(const p of mergedClosed)if(p?.id)delete oldOpen[String(p.id)];
        write(OPEN_KEY+key,oldOpen);
        write(CLOSED_KEY+key,mergedClosed.slice(0,5000));
        data.closed=mergedClosed;
        return new Response(JSON.stringify(data),{status:response.status,statusText:response.statusText,headers:response.headers});
      }
      if(isClose){
        const match=url.match(/\/api\/trading\/positions\/([^/]+)\/close/);const id=match?decodeURIComponent(match[1]):'';
        const accountKeys=[];
        for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i)||'';if(k.startsWith(OPEN_KEY))accountKeys.push(k.slice(OPEN_KEY.length));}
        for(const key of accountKeys){
          const open=read(OPEN_KEY+key,{});const prior=open[id];
          if(!prior)continue;
          const closed={...prior,status:'closed',closePrice:Number(data.closePrice??prior.currentPrice??prior.entryPrice??0),realizedPnl:Number(data.realizedPnl??0),closedAt:new Date().toISOString()};
          const oldClosed=read(CLOSED_KEY+key,[]);
          write(CLOSED_KEY+key,mergeById([closed,...oldClosed]).slice(0,5000));
          delete open[id];write(OPEN_KEY+key,open);
        }
      }
    }catch(e){}
    return response;
  };

  function update(data){
    const summary=document.getElementById('positionDailyPnl');
    if(!summary)return;
    const key=jsonKey(data);
    const serverClosed=Array.isArray(data?.closed)?data.closed:[];
    const cachedClosed=read(CLOSED_KEY+key,[]);
    const closed=mergeById([...serverClosed,...cachedClosed]);
    const day=tradingDay();
    let total=0;
    for(const trade of closed){
      const when=validDate(trade?.closedAt||trade?.closeTime||trade?.closed_at||trade?.updatedAt||trade?.updated_at||trade?.createdAt||trade?.created_at);
      if(!when)continue;
      const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(when);
      const get=t=>parts.find(x=>x.type===t)?.value||'';
      let y=Number(get('year')),m=Number(get('month')),d=Number(get('day')),h=Number(get('hour'));
      if(h<6){const prev=new Date(Date.UTC(y,m-1,d)-86400000);y=prev.getUTCFullYear();m=prev.getUTCMonth()+1;d=prev.getUTCDate();}
      const tradeDay=y+'-'+String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0');
      if(tradeDay===day)total+=pnl(trade);
    }
    write(CLOSED_KEY+key,closed.slice(0,5000));
    summary.textContent='Today P&L '+(total>=0?'+':'-')+auraMoney(Math.abs(total));
    summary.style.color=total>0?'#008a5b':total<0?'#e6004d':'#687786';
    summary.style.borderColor=total>0?'#b9ead9':total<0?'#f2bfd0':'#dfe5e9';
  }

  function install(){window.auraUpdateDailyPnl=update;if(typeof window.auraSyncDailyPnl==='function')window.auraSyncDailyPnl();}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();
