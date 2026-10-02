(function(){
  'use strict';
  if(!/\/courses(?:\.html)?(?:\/|$)/i.test(location.pathname)) return;
  const API='https://aurafirming.in';
  let timer=null,countdownTimer=null,busy=false;
  const money=v=>'$'+Number(v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  const pct=v=>Number(v||0).toFixed(2)+'%';
  const byId=id=>document.getElementById(id);
  const set=(id,value,color)=>{const el=byId(id);if(!el)return;el.textContent=value;if(color)el.style.color=color;};
  function row(label){return [...document.querySelectorAll('.metric-row')].find(r=>(r.querySelector('span')?.textContent||'').trim().toLowerCase()===label.toLowerCase())}
  function setRow(label,value){const r=row(label);if(r){const s=r.querySelector('strong');if(s)s.textContent=value}}
  function renderList(selector,items,empty){const el=document.querySelector(selector);if(!el)return;if(!items?.length){el.innerHTML='<div class="empty-chart">'+empty+'</div>';return}el.innerHTML=items.map(x=>{const v=Number(x.value||0);return '<div class="metric-row"><span>'+String(x.label||x.day||x.symbol)+'</span><strong style="color:'+(v<0?'#ff5b70':'#68d58a')+'">'+(v>=0?'+':'-')+money(Math.abs(v))+'</strong></div>'}).join('')}
  function nextReset(){
    const now=new Date();
    const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(now);
    const get=t=>Number(parts.find(x=>x.type===t)?.value||0);
    const y=get('year'),m=get('month'),d=get('day'),h=get('hour'),mi=get('minute');
    let target=new Date(Date.UTC(y,m-1,d,3,45,0));
    if(h>9 || (h===9&&mi>=15))target=new Date(target.getTime()+86400000);
    return {target,now,h,mi};
  }
  function startCountdown(){
    const el=byId('dailyDrawdownResetCountdown');if(!el)return;
    clearInterval(countdownTimer);
    const paint=()=>{const {target,now}=nextReset();const total=Math.max(0,Math.floor((target-now)/1000));const hh=Math.floor(total/3600),mm=Math.floor((total%3600)/60),ss=total%60;el.textContent='Daily reset in '+String(hh).padStart(2,'0')+':'+String(mm).padStart(2,'0')+':'+String(ss).padStart(2,'0')+' · 09:15 IST';};
    paint();countdownTimer=setInterval(paint,1000);
  }
  async function load(){
    if(busy)return;busy=true;
    try{
      const user=window.ceAuth?.currentUser;if(!user)return;
      const token=await user.getIdToken(false);
      const r=await fetch(API+'/api/dashboard-stats',{headers:{Authorization:'Bearer '+token},cache:'no-store'});
      const d=await r.json().catch(()=>({}));
      if(!r.ok||!d.account)throw new Error(d.error||('Dashboard API '+r.status));
      const a=d.account,starting=Number(a.startingBalance||0),balance=Number(a.balance??starting),equity=Number(a.equity??balance),pnl=Number(a.pnl??(balance-starting));
      const daily=Number(a.dailyDrawdownPct||0),max=Number(a.maxDrawdownPct||0),dailyLimit=Number(a.dailyDrawdownLimit??a.dailyDrawdown??4),maxLimit=Number(a.maxDrawdownLimit??a.maxDrawdown??10),profit=starting?(pnl/starting)*100:0;
      set('accountBalance',money(balance));
      set('accountEquity',money(equity));
      set('accountPnl',(pnl>=0?'+':'-')+money(Math.abs(pnl)),pnl<0?'#ff5b70':'#68d58a');
      set('dailyDrawdown',pct(daily)+' / '+pct(dailyLimit));
      set('maxDrawdown',pct(max)+' / '+pct(maxLimit));
      set('profitPercent',(profit>=0?'+':'')+profit.toFixed(2)+'%');
      set('accountStatus',String(a.status||'ACTIVE').toUpperCase(),String(a.status||'').toLowerCase()==='breached'?'#ff6b96':null);
      set('openPositionsCount',String(a.openPositionsCount??0));
      setRow('Avg. Win',a.avgWin==null?'—':money(a.avgWin));
      setRow('Avg. Loss',a.avgLoss==null?'—':money(a.avgLoss));
      setRow('Profit Factor',a.profitFactor==null?'—':Number(a.profitFactor).toFixed(2));
      const streaks=[...document.querySelectorAll('.streaks em')];
      if(streaks[0])streaks[0].textContent=String(a.currentWinStreak??0);
      if(streaks[1])streaks[1].textContent=String(a.currentLossStreak??0);
      if(streaks[2])streaks[2].textContent=String(a.breakevenTrades??0);
      const winEl=document.querySelector('.ring-win strong');if(winEl)winEl.textContent=pct(a.winRate||0);
      const cards=[...document.querySelectorAll('.analytics-card')];
      const dayCard=cards.find(c=>(c.querySelector('.analytics-label')?.textContent||'').trim()==='Performance by Day');
      const symbolCard=cards.find(c=>(c.querySelector('.analytics-label')?.textContent||'').trim()==='Performance by Symbol');
      if(dayCard){const list=(a.performanceByDay||[]).map(x=>({label:x.day,value:x.value}));const holder=dayCard.querySelector('.empty-chart');if(holder){holder.className='performance-list';holder.innerHTML=list.length?list.map(x=>'<div class="metric-row"><span>'+x.label+'</span><strong style="color:'+(Number(x.value)<0?'#ff5b70':'#68d58a')+'">'+(Number(x.value)>=0?'+':'-')+money(Math.abs(x.value))+'</strong></div>').join(''):'<div class="empty-chart">No closed trade data available</div>';}}
      if(symbolCard){const list=(a.performanceBySymbol||[]).map(x=>({label:x.symbol,value:x.value}));const holder=symbolCard.querySelector('.empty-chart');if(holder){holder.className='performance-list';holder.innerHTML=list.length?list.map(x=>'<div class="metric-row"><span>'+x.label+'</span><strong style="color:'+(Number(x.value)<0?'#ff5b70':'#68d58a')+'">'+(Number(x.value)>=0?'+':'-')+money(Math.abs(x.value))+'</strong></div>').join(''):'<div class="empty-chart">No closed trade data available</div>';}}
      const tradeEmpty=byId('tradeEmpty');if(tradeEmpty)tradeEmpty.textContent=Number(a.openPositionsCount||0)?'Open positions: '+a.openPositionsCount:'No open trades';
      startCountdown();
    }catch(e){console.warn('Dashboard live data:',e?.message||e)}finally{busy=false}
  }
  function init(){if(!byId('accountBalance'))return;load();clearInterval(timer);timer=setInterval(load,5000);startCountdown()}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
