(function(){
  'use strict';
  if(!/\/courses(?:\.html)?(?:\/|$)/i.test(location.pathname)) return;
  const API='https://aurafirming.in';
  let timer=null, countdownTimer=null, busy=false;
  const money=v=>'$'+Number(v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  const pct=v=>Number(v||0).toFixed(2)+'%';
  const byId=id=>document.getElementById(id);
  function set(id,value,color){const el=byId(id);if(!el)return;el.textContent=value;if(color)el.style.color=color;}
  function row(label){const rows=[...document.querySelectorAll('.metric-row')];return rows.find(r=>(r.querySelector('span')?.textContent||'').trim().toLowerCase()===label.toLowerCase());}
  function setRow(label,value){const r=row(label);if(r){const s=r.querySelector('strong');if(s)s.textContent=value;}}
  function nextReset(){
    const now=new Date();
    const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(now);
    const get=t=>Number(parts.find(x=>x.type===t)?.value||0);
    const y=get('year'),m=get('month'),d=get('day'),h=get('hour'),mi=get('minute');
    let target=new Date(Date.UTC(y,m-1,d,3,45,0));
    if(h>9 || (h===9&&mi>=15)) target=new Date(target.getTime()+86400000);
    return {target,now};
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
      const user=window.ceAuth?.currentUser;if(!user){busy=false;return;}
      const token=await user.getIdToken(false);
      const r=await fetch(API+'/api/trading-account',{headers:{Authorization:'Bearer '+token},cache:'no-store'});
      const d=await r.json().catch(()=>({}));if(!r.ok||!d.account)throw new Error(d.error||('Account API '+r.status));
      const a=d.account,starting=Number(a.startingBalance||0),balance=Number(a.balance??starting),equity=Number(a.equity??balance),pnl=Number(a.pnl??(balance-starting));
      const daily=Number(a.dailyDrawdownPct||0),max=Number(a.maxDrawdownPct||0),dailyLimit=Number(a.dailyDrawdownLimit||a.dailyLossLimit||3),maxLimit=Number(a.maxDrawdownLimit||a.overallLossLimit||8),profit=starting?(pnl/starting)*100:0;
      set('accountBalance',money(balance));set('accountEquity',money(equity));set('accountPnl',(pnl>=0?'+':'-')+money(Math.abs(pnl)),pnl<0?'#ff5b70':'#68d58a');set('dailyDrawdown',pct(daily)+' / '+pct(dailyLimit));set('maxDrawdown',pct(max)+' / '+pct(maxLimit));set('profitPercent',(profit>=0?'+':'')+profit.toFixed(2)+'%');set('accountStatus',String(a.status||'ACTIVE').toUpperCase());
      const open=Array.isArray(a.positions)?a.positions.length:Number(a.openPositionsCount??0);set('openPositionsCount',String(open));
      setRow('Avg. Win',a.avgWin==null?'—':money(a.avgWin));setRow('Avg. Loss',a.avgLoss==null?'—':money(a.avgLoss));setRow('Profit Factor',a.profitFactor==null?'—':Number(a.profitFactor).toFixed(2));setRow('Best Trade',a.bestTrade==null?'—':money(a.bestTrade));setRow('Worst Trade',a.worstTrade==null?'—':money(a.worstTrade));setRow('Total Trades',String(a.totalTrades??'0'));
      const winEl=document.querySelector('.ring-win strong');if(winEl)winEl.textContent=Number.isFinite(Number(a.winRate))?pct(a.winRate):'0.00%';
      const streaks=[...document.querySelectorAll('.streaks em')];if(streaks[0])streaks[0].textContent=String(a.currentWinStreak??'0');if(streaks[1])streaks[1].textContent=String(a.currentLossStreak??'0');
      if(String(a.status||'').toLowerCase()==='breached')set('accountStatus','BREACHED','#ff6b96');
      startCountdown();
    }catch(e){console.warn('Dashboard live data:',e?.message||e)}finally{busy=false}
  }
  function init(){if(!byId('accountBalance'))return;load();clearInterval(timer);timer=setInterval(load,5000);startCountdown()}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
