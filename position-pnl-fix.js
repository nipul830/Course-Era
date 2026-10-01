(function(){
  function tradingDay(){
    const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date());
    const get=t=>parts.find(x=>x.type===t)?.value||'';
    let y=Number(get('year')),m=Number(get('month')),d=Number(get('day')),h=Number(get('hour'));
    if(h<6){const prev=new Date(Date.UTC(y,m-1,d)-86400000);y=prev.getUTCFullYear();m=prev.getUTCMonth()+1;d=prev.getUTCDate();}
    return y+'-'+String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0');
  }
  function tradeDay(v){
    const d=v instanceof Date?v:new Date(v);
    if(!v||!Number.isFinite(d.getTime()))return '';
    const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(d);
    const get=t=>parts.find(x=>x.type===t)?.value||'';
    let y=Number(get('year')),m=Number(get('month')),day=Number(get('day')),h=Number(get('hour'));
    if(h<6){const prev=new Date(Date.UTC(y,m-1,day)-86400000);y=prev.getUTCFullYear();m=prev.getUTCMonth()+1;day=prev.getUTCDate();}
    return y+'-'+String(m).padStart(2,'0')+'-'+String(day).padStart(2,'0');
  }
  const pnl=v=>Number(v?.realizedPnl??v?.pnl??0)||0;
  const CLOSED_KEY='auraClosedTrades:v2:';
  const OPEN_KEY='auraOpenTrades:v2:';
  const memory={};
  const jsonKey=v=>String(v?.account?.id||v?.account?.accountId||'account');
  function read(key,fallback){try{return JSON.parse(localStorage.getItem(key)||JSON.stringify(fallback));}catch(e){return fallback;}}
  function write(key,value){try{localStorage.setItem(key,JSON.stringify(value));}catch(e){}}
  function mergeById(list){
    const out=[];const seen=new Set();
    for(const x of list||[]){const id=String(x?.id||'');if(!id||seen.has(id))continue;seen.add(id);out.push(x);}
    return out;
  }
  function setClosed(key,items){
    const merged=mergeById(items).slice(0,5000);
    memory[key]={...(memory[key]||{}),closed:merged};
    write(CLOSED_KEY+key,merged);
    return merged;
  }
  function getClosed(key){return mergeById([...(memory[key]?.closed||[]),...read(CLOSED_KEY+key,[])]);}
  function setOpen(key,items){
    const map={};
    for(const p of items||[])if(p?.id)map[String(p.id)]=p;
    memory[key]={...(memory[key]||{}),open:map};
    write(OPEN_KEY+key,map);
    return map;
  }
  function getOpen(key){return {...(read(OPEN_KEY+key,{})),...(memory[key]?.open||{})};}

  function updateDailyPnl(data){
    const summary=document.getElementById('positionDailyPnl');
    if(!summary)return;
    const key=jsonKey(data);
    const closed=getClosed(key);
    const today=tradingDay();
    let total=0;
    for(const t of closed){
      const when=t?.closedAt||t?.closeTime||t?.closed_at||t?.updatedAt||t?.updated_at||t?.createdAt||t?.created_at;
      if(tradeDay(when)===today)total+=pnl(t);
    }
    summary.textContent='Today P&L '+(total>=0?'+':'-')+auraMoney(Math.abs(total));
    summary.style.color=total>0?'#008a5b':total<0?'#e6004d':'#687786';
    summary.style.borderColor=total>0?'#b9ead9':total<0?'#f2bfd0':'#dfe5e9';
  }

  const nativeFetch=window.fetch.bind(window);
  window.fetch=async function(input,init){
    const url=typeof input==='string'?input:(input?.url||'');
    const method=String(init?.method||input?.method||'GET').toUpperCase();
    const isHistory=/\/api\/trading\/history(?:\?|$)/.test(url);
    const isClose=/\/api\/trading\/positions\/[^/]+\/close(?:\?|$)/.test(url)&&method==='POST';
    if(!isHistory&&!isClose)return nativeFetch(input,init);

    const response=await nativeFetch(input,init);
    try{
      const data=await response.clone().json();
      if(isHistory){
        const key=jsonKey(data);
        const serverClosed=Array.isArray(data.closed)?data.closed:[];
        const cachedClosed=getClosed(key);
        const mergedClosed=setClosed(key,[...serverClosed,...cachedClosed]);
        const open=Array.isArray(data.open)?data.open:[];
        const openMap=setOpen(key,open);
        for(const p of mergedClosed)if(p?.id)delete openMap[String(p.id)];
        write(OPEN_KEY+key,openMap);
        if(memory[key])memory[key].open=openMap;
        data.closed=mergedClosed;
        // Important: daily P&L must run AFTER cached closed trades are merged.
        updateDailyPnl(data);
        return new Response(JSON.stringify(data),{status:response.status,statusText:response.statusText,headers:response.headers});
      }

      if(isClose){
        const match=url.match(/\/api\/trading\/positions\/([^/]+)\/close/);
        const id=match?decodeURIComponent(match[1]):'';
        const keys=new Set();
        for(let i=0;i<localStorage.length;i++){
          const k=localStorage.key(i)||'';
          if(k.startsWith(OPEN_KEY))keys.add(k.slice(OPEN_KEY.length));
        }
        Object.keys(memory).forEach(k=>keys.add(k));
        for(const key of keys){
          const open=getOpen(key);const prior=open[id];
          const closed={
            ...(prior||{}),
            id,
            status:'closed',
            closePrice:Number(data.closePrice??prior?.currentPrice??prior?.entryPrice??0),
            realizedPnl:Number(data.realizedPnl??0),
            closedAt:new Date().toISOString()
          };
          const merged=setClosed(key,[closed,...getClosed(key)]);
          delete open[id];
          if(memory[key])memory[key].open=open;
          write(OPEN_KEY+key,open);
          updateDailyPnl({account:{id:key},closed:merged});
        }
      }
    }catch(e){}
    return response;
  };

  function install(){
    window.auraUpdateDailyPnl=updateDailyPnl;
    if(typeof window.auraSyncDailyPnl==='function')window.auraSyncDailyPnl();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();
