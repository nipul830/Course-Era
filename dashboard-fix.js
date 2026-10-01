(function(){
  'use strict';
  const API='https://aurafirming.in';
  let timer=null;
  const money=v=>'$'+Number(v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const num=v=>Number(v||0)||0;
  const fmtPct=v=>(num(v)>=0?'+':'')+num(v).toFixed(2)+'%';
  const set=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v};

  function closedPnl(p){return num(p?.realizedPnl??p?.pnl??0)}
  function tradeDate(p){
    const raw=p?.closedAt||p?.closeTime||p?.closed_at||p?.updatedAt||p?.updated_at||p?.createdAt;
    if(!raw)return null;
    const d=new Date(raw);return Number.isNaN(d.getTime())?null:d;
  }
  function tradeTime(p){
    const raw=p?.closedAt||p?.closeTime||p?.openedAt||p?.createdAt;
    if(!raw)return '—';
    const d=new Date(raw);return Number.isNaN(d.getTime())?'—':d.toLocaleString();
  }
  function accountStart(account,closed){
    const explicit=num(account?.startingBalance);
    if(explicit>0)return explicit;
    const bal=num(account?.balance);
    const pnl=num(account?.pnl);
    if(bal>0 && Number.isFinite(pnl))return bal-pnl;
    const total=closed.reduce((s,p)=>s+closedPnl(p),0);
    return bal-total;
  }

  function renderMetricCard(card,label,value){
    if(!card)return;
    const rows=card.querySelectorAll('.metric-row strong');
    const target=[...rows].find((_,i)=>card.querySelectorAll('.metric-row')[i]?.querySelector('span')?.textContent.trim().toLowerCase()===label.toLowerCase());
    if(target)target.textContent=value;
  }

  function renderAnalytics(closed){
    const wins=closed.filter(p=>closedPnl(p)>0);
    const losses=closed.filter(p=>closedPnl(p)<0);
    const breakeven=closed.filter(p=>closedPnl(p)===0);
    const grossWin=wins.reduce((s,p)=>s+closedPnl(p),0);
    const grossLoss=Math.abs(losses.reduce((s,p)=>s+closedPnl(p),0));
    const avgWin=wins.length?grossWin/wins.length:0;
    const avgLoss=losses.length?grossLoss/losses.length:0;
    const pf=grossLoss>0?grossWin/grossLoss:(grossWin>0?'∞':0);
    const total=closed.reduce((s,p)=>s+closedPnl(p),0);
    const wr=closed.length?(wins.length/closed.length)*100:0;
    const profitRing=document.getElementById('profitPercent');
    if(profitRing)profitRing.textContent=profitRing.textContent||'0%';
    const winRing=document.querySelector('.ring-win strong');
    if(winRing)winRing.textContent=fmtPct(wr).replace('+','');

    const cards=[...document.querySelectorAll('.analytics-card')];
    const analysis=cards.find(c=>c.querySelector('.analytics-label')?.textContent.trim().toLowerCase()==='trade analysis');
    if(analysis){
      const rows=analysis.querySelectorAll('.metric-row');
      if(rows[0])rows[0].querySelector('strong').textContent=wins.length?money(avgWin):'—';
      if(rows[1])rows[1].querySelector('strong').textContent=losses.length?'-'+money(avgLoss):'—';
      if(rows[2])rows[2].querySelector('strong').textContent=closed.length?(typeof pf==='number'?pf.toFixed(2):pf):'—';
      const note=analysis.querySelector('.empty-note');
      if(note)note.textContent=closed.length?closed.length+' closed trade'+(closed.length===1?'':'s')+' analyzed.':'No closed trade data available yet.';
    }
    const streakCard=cards.find(c=>c.querySelector('.analytics-label')?.textContent.trim().toLowerCase()==='streaks');
    if(streakCard){
      const es=streakCard.querySelectorAll('.streaks em');
      if(es[0])es[0].textContent=wins.length;
      if(es[1])es[1].textContent=losses.length;
      if(es[2])es[2].textContent=breakeven.length;
      const note=streakCard.querySelector('.empty-note');
      if(note)note.textContent=closed.length?'Closed-trade results are updated live.':'Trading streaks will appear after closed trades.';
    }

    const dayCard=cards.find(c=>c.querySelector('.analytics-label')?.textContent.trim().toLowerCase()==='performance by day');
    if(dayCard){
      const box=dayCard.querySelector('.empty-chart');
      const groups={};
      closed.forEach(p=>{const d=tradeDate(p);if(!d)return;const key=d.toISOString().slice(0,10);groups[key]=(groups[key]||0)+closedPnl(p)});
      const entries=Object.entries(groups).sort((a,b)=>b[0].localeCompare(a[0])).slice(0,10);
      if(box)box.innerHTML=entries.length?entries.map(([day,v])=>'<div style="display:flex;justify-content:space-between;gap:10px;width:100%;padding:4px 2px"><span>'+esc(day)+'</span><strong style="color:'+(v>=0?'#55d58a':'#ff5b86')+'">'+(v>=0?'+':'-')+money(Math.abs(v))+'</strong></div>').join(''):'No performance data available';
      if(box)box.style.height=entries.length?'auto':'105px';
    }

    const symbolCard=cards.find(c=>c.querySelector('.analytics-label')?.textContent.trim().toLowerCase()==='performance by symbol');
    if(symbolCard){
      const box=symbolCard.querySelector('.empty-chart');
      const groups={};
      closed.forEach(p=>{const key=String(p.name||p.symbol||'Unknown');groups[key]=(groups[key]||0)+closedPnl(p)});
      const entries=Object.entries(groups).sort((a,b)=>Math.abs(b[1])-Math.abs(a[1])).slice(0,10);
      if(box)box.innerHTML=entries.length?entries.map(([sym,v])=>'<div style="display:flex;justify-content:space-between;gap:10px;width:100%;padding:4px 2px"><span>'+esc(sym)+'</span><strong style="color:'+(v>=0?'#55d58a':'#ff5b86')+'">'+(v>=0?'+':'-')+money(Math.abs(v))+'</strong></div>').join(''):'No symbol performance data available';
      if(box)box.style.height=entries.length?'auto':'105px';
    }
    return {wins:wins.length,losses:losses.length,breakeven:breakeven.length,total,wr,grossWin,grossLoss};
  }

  function renderTrades(open,pending,closed){
    const empty=document.getElementById('tradeEmpty');
    const tabs=[...document.querySelectorAll('.trade-tabs button')];
    if(!empty||!tabs.length)return;
    const render=mode=>{
      const rows=mode==='open'?open:mode==='pending'?pending:closed;
      if(!rows.length){empty.className='trade-empty';empty.style.cssText='';empty.textContent=mode==='open'?'No open trades':mode==='pending'?'No pending trades':'No trade history';return;}
      empty.className='trade-list';
      empty.style.cssText='display:grid;gap:7px;max-height:270px;overflow:auto';
      empty.innerHTML=rows.slice(0,100).map(p=>{
        const v=closedPnl(p);const side=String(p.side||'').toUpperCase();
        return '<div style="padding:9px 10px;border:1px solid #302713;border-radius:9px;background:#090806;display:flex;justify-content:space-between;gap:8px;align-items:center"><div><strong style="display:block;color:#fff;font-size:11px">'+esc(p.name||p.symbol||'Trade')+' · '+esc(side)+'</strong><small style="display:block;color:#7f6d43;margin-top:2px">'+esc(tradeTime(p))+'</small></div><strong style="color:'+(v>=0?'#55d58a':'#ff5b86')+'">'+(v>=0?'+':'-')+money(Math.abs(v))+'</strong></div>';
      }).join('');
    };
    tabs.forEach((b,i)=>{
      b.onclick=()=>{
        tabs.forEach(x=>x.classList.remove('active'));b.classList.add('active');
        render(tabs.length===2?(i===0?'open':'closed'):(i===0?'open':i===1?'closed':'pending'));
      };
    });
    const active=tabs.findIndex(b=>b.classList.contains('active'));
    render(tabs.length===2?(active===1?'closed':'open'):(active===1?'closed':active===2?'pending':'open'));
  }

  async function load(){
    if(!document.querySelector('.dashboard')||typeof ceAuth==='undefined'||!ceAuth.currentUser)return;
    try{
      const user=ceAuth.currentUser;
      let account=null;
      if(typeof auraAccount==='function')account=await auraAccount();
      const firebaseToken=await user.getIdToken(false);
      const credRes=await fetch(API+'/api/trading-credentials',{headers:{Authorization:'Bearer '+firebaseToken},cache:'no-store'});
      if(!credRes.ok)return;
      const cred=await credRes.json();
      if(!cred.loginId||!cred.tradingPassword)return;
      const loginRes=await fetch(API+'/api/terminal/login',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+firebaseToken},body:JSON.stringify({loginId:cred.loginId,password:cred.tradingPassword,mode:'trader'})});
      if(!loginRes.ok)return;
      const session=await loginRes.json();
      if(!session.token)return;
      const historyRes=await fetch(API+'/api/trading/history',{headers:{Authorization:'Bearer '+session.token},cache:'no-store'});
      if(!historyRes.ok)return;
      const data=await historyRes.json();
      const open=Array.isArray(data.open)?data.open:[];
      const pending=Array.isArray(data.pending)?data.pending:[];
      const closed=Array.isArray(data.closed)?data.closed:[];
      account=account&& !account.__error ? account : (data.account||{});
      const balance=num(account.balance),equity=num(account.equity||balance),start=accountStart(account,closed);
      const pnl=num(account.pnl);
      set('accountBalance',money(balance));
      set('accountEquity',money(equity));
      const pnlEl=document.getElementById('accountPnl');
      if(pnlEl){pnlEl.textContent=(pnl>=0?'+':'-')+money(Math.abs(pnl));pnlEl.style.color=pnl<0?'#ff5b70':'#68d58a'}
      set('openPositionsCount',open.length);
      const profitPct=start?((pnl/start)*100):0;
      set('profitPercent',fmtPct(profitPct));
      const daily=num(account.dailyDrawdownPct),dailyLimit=num(account.dailyDrawdownLimit||4),max=num(account.maxDrawdownPct),maxLimit=num(account.maxDrawdownLimit||8);
      set('dailyDrawdown',daily.toFixed(2)+'% / '+dailyLimit.toFixed(2)+'%');
      set('maxDrawdown',max.toFixed(2)+'% / '+maxLimit.toFixed(2)+'%');
      renderAnalytics(closed);
      renderTrades(open,pending,closed);
    }catch(e){console.warn('Dashboard trade history fix:',e)}
  }
  function start(){load();clearInterval(timer);timer=setInterval(load,10000)}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
