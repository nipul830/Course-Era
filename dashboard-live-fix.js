(function(){
  'use strict';
  if(!/\/courses(?:\.html)?(?:\/|$)/i.test(location.pathname)) return;
  const API='https://aurafirming.in';
  let timer=null,countdownTimer=null,busy=false;
  const money=v=>'$'+Number(v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  const num=v=>Number(v||0)||0;
  const pct=v=>num(v).toFixed(2)+'%';
  const byId=id=>document.getElementById(id);

  window.paintRiskBars = function paintRiskBars(a){
    if(!a||a.__error)return;
    const num=v=>{const n=Number(v);return Number.isFinite(n)?n:0;};
    const money=v=>'$'+Math.abs(num(v)).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
    let starting=num(a.startingBalance||a.accountSize||a.initialBalance||a.staticDrawdownBase);
    const balance=num(a.balance||starting);
    const equity=num(a.equity||balance);
    let pnl=Number.isFinite(Number(a.pnl))?Number(a.pnl):(balance-starting);
    if(starting<=0 && Math.abs(pnl)>0){
      const ring=document.getElementById('profitPercent');
      const t=ring?String(ring.textContent||'').replace('%',''):'';
      const pp=Math.abs(num(t));
      if(pp>0.0001) starting=Math.abs(pnl)/(pp/100);
    }
    if(starting<=0) starting=Math.max(balance, equity, 5000);

    const dailyPct=num(a.dailyDrawdownPct);
    const dailyLim=Math.max(0.01, num(a.dailyDrawdownLimit!=null?a.dailyDrawdownLimit:(a.dailyDrawdown!=null?a.dailyDrawdown:4)));
    const maxPct=num(a.maxDrawdownPct);
    const maxLim=Math.max(0.01, num(a.maxDrawdownLimit!=null?a.maxDrawdownLimit:(a.maxDrawdown!=null?a.maxDrawdown:8)));
    const dailyMoney=starting*(dailyPct/100);
    const maxMoney=starting*(maxPct/100);

    function setTxt(id,t,c){const el=document.getElementById(id);if(!el)return;el.textContent=t;if(c)el.style.color=c;}
    function setBar(id,pctVal,over){
      const el=document.getElementById(id);if(!el)return;
      el.style.width=Math.min(100,Math.max(0,pctVal))+'%';
      if(over) el.style.background='linear-gradient(90deg,#a01040,#ff3b6b)';
    }

    setTxt('dailyDrawdownMoney','-'+money(dailyMoney)+' ('+dailyPct.toFixed(2)+'%)','#ff6b96');
    setBar('dailyDrawdownBar',(dailyPct/dailyLim)*100, dailyPct>=dailyLim);

    setTxt('maxDrawdownMoney','-'+money(maxMoney)+' ('+maxPct.toFixed(2)+'%)','#ff6b96');
    setBar('maxDrawdownBar',(maxPct/maxLim)*100, maxPct>=maxLim);

    const target=num(a.profitTargetPct||a.phase1Profit||a.phase2Profit||a.profitTarget||0);
    const profitPct=starting>0?(pnl/starting)*100:0;
    setTxt('profitTargetMoney',(pnl>=0?'+':'-')+money(pnl), pnl<0?'#ff6b96':'#68d58a');
    setTxt('profitTargetLabel', target>0?(profitPct.toFixed(2)+'% / '+target.toFixed(2)+'% target'):(profitPct.toFixed(2)+'%'));
    setBar('profitTargetBar', target>0?(Math.max(0,profitPct)/target)*100:0, false);

    const phaseEl=document.getElementById('accountPhaseBadge');
    if(phaseEl){
      let phase=String(a.phase||a.stage||'').trim();
      if(a.funded===true||/funded/i.test(phase)) phase='Funded';
      else if(/phase\s*2/i.test(phase)) phase='Phase 2';
      else phase='Phase 1';
      phaseEl.textContent=phase;
    }
    const pay=document.getElementById('accountPayoutBtn');
    if(pay){
      pay.style.display=(a.funded===true||/funded/i.test(String(a.phase||a.stage||'')))?'block':'none';
    }
  }


  function ensureFloatingWarn(){
    let el=byId('floatingRiskWarn');
    if(el)return el;
    const host=byId('accountStatus')?.parentElement || document.querySelector('.account-hero-card') || document.querySelector('.dashboard');
    if(!host)return null;
    el=document.createElement('div');
    el.id='floatingRiskWarn';
    el.style.cssText='display:none;margin-top:10px;padding:10px 12px;border-radius:10px;border:1px solid #7a1f3a;background:#1a0810;color:#ff6b96;font-size:12px;font-weight:800;text-align:center;';
    host.appendChild(el);
    if(!byId('floatingRiskBlinkStyle')){
      const st=document.createElement('style');
      st.id='floatingRiskBlinkStyle';
      st.textContent='@keyframes floatingRiskBlink{0%,100%{opacity:1}50%{opacity:.5}}#floatingRiskWarn.blink{animation:floatingRiskBlink 1s ease-in-out infinite}';
      document.head.appendChild(st);
    }
    return el;
  }
  function paintFloatingWarn(account){
    const el=ensureFloatingWarn();
    if(!el)return;
    const hits=Number(account?.floatingLossHits||0);
    const warn=String(account?.lastRiskWarning||account?.riskWarning||'').trim();
    const status=String(account?.status||'').toLowerCase();
    if(status==='breached'){
      el.style.display='block'; el.className='blink';
      el.textContent=warn||'Account breached.';
      return;
    }
    if(hits>=1 || /floating/i.test(warn)){
      el.style.display='block'; el.className='blink';
      el.textContent=warn||('1st floating hit ('+hits+'). Next hit will breach the account.');
      return;
    }
    el.style.display='none'; el.className=''; el.textContent='';
  }
  const set=(id,value,color)=>{const el=byId(id);if(!el)return;el.textContent=value;if(color)el.style.color=color;};
  const pnlOf=p=>num(p?.realizedPnl??p?.pnl??p?.profit??0);
  function tradeDate(p){const raw=p?.closedAt||p?.closeTime||p?.updatedAt||p?.createdAt;if(!raw)return null;const d=new Date(raw);return Number.isNaN(d.getTime())?null:d;}
  function tradeTime(p){const d=tradeDate(p)||new Date(p?.openedAt||p?.createdAt||'');return Number.isNaN(d.getTime())?'—':d.toLocaleString();}
  function row(label){return [...document.querySelectorAll('.metric-row')].find(r=>(r.querySelector('span')?.textContent||'').trim().toLowerCase()===label.toLowerCase());}
  function setRow(label,value){const r=row(label);if(r){const s=r.querySelector('strong');if(s)s.textContent=value;}}
  function setTradeMsg(msg){const box=byId('tradeEmpty');if(box){box.className='trade-empty';box.style.cssText='';box.textContent=msg;}}
  function nextReset(){const now=new Date();const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(now);const get=t=>Number(parts.find(x=>x.type===t)?.value||0);const y=get('year'),m=get('month'),d=get('day'),h=get('hour'),mi=get('minute');let target=new Date(Date.UTC(y,m-1,d,1,0,0));if(h>9||(h===9&&mi>=15))target=new Date(target.getTime()+86400000);return {target,now};}
  function startCountdown(){const el=byId('dailyDrawdownResetCountdown');if(!el)return;clearInterval(countdownTimer);const paint=()=>{const {target,now}=nextReset();const total=Math.max(0,Math.floor((target-now)/1000));const hh=Math.floor(total/3600),mm=Math.floor((total%3600)/60),ss=total%60;el.textContent='Daily reset in '+String(hh).padStart(2,'0')+':'+String(mm).padStart(2,'0')+':'+String(ss).padStart(2,'0')+' · 06:30 IST';};paint();countdownTimer=setInterval(paint,1000);}
  async function getHistory(user){
    const firebaseToken=await user.getIdToken(false);
    const accKey=(localStorage.getItem('auraSelectedTradingAccount')||localStorage.getItem('aura_selected_account')||'default'); const SESSION_KEY='auraDashTerminalSession:'+accKey;
    const SESSION_TTL_MS=25*60*1000; // reuse \~25 min

    function readCached(){
      try{
        const raw=sessionStorage.getItem(SESSION_KEY);
        if(!raw)return null;
        const o=JSON.parse(raw);
        if(!o||!o.token||!o.at)return null;
        if(Date.now()-Number(o.at)>SESSION_TTL_MS)return null;
        return o.token;
      }catch(e){return null;}
    }
    function writeCached(token){
      try{sessionStorage.setItem(SESSION_KEY,JSON.stringify({token,at:Date.now()}));}catch(e){}
    }
    function clearCached(){
      try{sessionStorage.removeItem(SESSION_KEY);}catch(e){}
    }

    async function fetchHistory(token){
      const historyRes=await fetch(API+'/api/trading/history',{headers:{Authorization:'Bearer '+token},cache:'no-store'});
      const historyText=await historyRes.text();
      let data={};
      try{data=JSON.parse(historyText);}catch(e){}
      return {historyRes,data};
    }

    // 1) try cached terminal token first
    let token=readCached();
    if(token){
      const {historyRes,data}=await fetchHistory(token);
      if(historyRes.ok)return data;
      // token expired / revoked
      clearCached();
    }

    // 2) login once
    const credRes=await fetch(API+'/api/trading-credentials',{headers:{Authorization:'Bearer '+firebaseToken},cache:'no-store'});
    const credText=await credRes.text();
    let cred={};
    try{cred=JSON.parse(credText);}catch(e){}
    if(!credRes.ok)throw new Error('Credentials '+credRes.status+(cred.error?': '+cred.error:''));
    if(!cred.loginId||!cred.tradingPassword)throw new Error('Login ID / trading password missing');

    const loginRes=await fetch(API+'/api/terminal/login',{
      method:'POST',
      headers:{'Content-Type':'application/json',Authorization:'Bearer '+firebaseToken},
      body:JSON.stringify({loginId:cred.loginId,password:cred.tradingPassword,mode:'trader'})
    });
    const loginText=await loginRes.text();
    let session={};
    try{session=JSON.parse(loginText);}catch(e){}
    if(!loginRes.ok){
      const msg=session.error||session.detail||loginText||'login failed';
      throw new Error('Terminal login '+loginRes.status+': '+msg);
    }
    if(!session.token)throw new Error('No terminal session token');
    writeCached(session.token);

    const {historyRes,data}=await fetchHistory(session.token);
    if(!historyRes.ok)throw new Error('History '+historyRes.status+(data.error?': '+data.error:''));
    return data;
  }
  function renderAnalytics(closed){
    const wins=closed.filter(p=>pnlOf(p)>0),losses=closed.filter(p=>pnlOf(p)<0),be=closed.filter(p=>pnlOf(p)===0);
    const grossWin=wins.reduce((s,p)=>s+pnlOf(p),0),grossLoss=Math.abs(losses.reduce((s,p)=>s+pnlOf(p),0));
    setRow('Avg. Win',wins.length?money(grossWin/wins.length):'—');
    setRow('Avg. Loss',losses.length?'-'+money(grossLoss/losses.length):'—');
    setRow('Profit Factor',grossLoss>0?(grossWin/grossLoss).toFixed(2):(grossWin>0?'∞':(closed.length?'0':'—')));
    const streaks=[...document.querySelectorAll('.streaks em')];
    let ws=0,ls=0;
    for(let i=0;i<closed.length;i++){const v=pnlOf(closed[i]);if(i===0){if(v>0)ws=1;else if(v<0)ls=1;else break;continue;}if(ws>0&&v>0)ws++;else if(ls>0&&v<0)ls++;else break;}
    if(streaks[0])streaks[0].textContent=String(ws);if(streaks[1])streaks[1].textContent=String(ls);if(streaks[2])streaks[2].textContent=String(be.length);
    const wr=closed.length?(wins.length/closed.length)*100:0;const winEl=document.querySelector('.ring-win strong');if(winEl)winEl.textContent=pct(wr);
    const dayMap={},symbolMap={};
    closed.forEach(p=>{const d=tradeDate(p);if(d){const key=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata'}).format(d);dayMap[key]=(dayMap[key]||0)+pnlOf(p);}const s=String(p?.symbol||p?.name||'Unknown');symbolMap[s]=(symbolMap[s]||0)+pnlOf(p);});
    const cards=[...document.querySelectorAll('.analytics-card')];
    const render=(label,map)=>{const card=cards.find(c=>(c.querySelector('.analytics-label')?.textContent||'').trim().toLowerCase()===label.toLowerCase());if(!card)return;const holder=card.querySelector('.empty-chart,.performance-list');if(!holder)return;const entries=Object.entries(map).sort((a,b)=>Math.abs(b[1])-Math.abs(a[1])).slice(0,10);holder.className=entries.length?'performance-list':'empty-chart';holder.style.height=entries.length?'auto':'105px';holder.innerHTML=entries.length?entries.map(([k,v])=>'<div class="metric-row"><span>'+String(k).replace(/[&<>]/g,'')+'</span><strong style="color:'+(v<0?'#ff5b70':'#68d58a')+'">'+(v>=0?'+':'-')+money(Math.abs(v))+'</strong></div>').join(''):'No closed trade data available';};
    render('Performance by Day',dayMap);render('Performance by Symbol',symbolMap);
  }
  function renderTrades(open,pending,closed){
    const box=byId('tradeEmpty'),tabs=[...document.querySelectorAll('.trade-tabs button')];if(!box||!tabs.length)return;
    const paint=mode=>{const rows=mode==='open'?open:mode==='pending'?pending:closed;if(!rows.length){box.className='trade-empty';box.style.cssText='';box.textContent=mode==='open'?'No open trades':mode==='pending'?'No pending trades':'No trade history';return;}box.className='trade-list';box.style.cssText='display:grid;gap:7px;max-height:270px;overflow:auto';box.innerHTML=rows.slice(0,100).map(p=>{const v=pnlOf(p),side=String(p.side||'').toUpperCase();return '<div style="padding:9px 10px;border:1px solid #302713;border-radius:9px;background:#090806;display:flex;justify-content:space-between;gap:8px;align-items:center"><div><strong style="display:block;color:#fff;font-size:11px">'+String(p.symbol||p.name||'Trade')+' · '+side+'</strong><small style="display:block;color:#7f6d43;margin-top:2px">'+tradeTime(p)+'</small></div><strong style="color:'+(v<0?'#ff5b70':'#68d58a')+'">'+(v>=0?'+':'-')+money(Math.abs(v))+'</strong></div>';}).join('');};
    tabs.forEach((b,i)=>{b.onclick=()=>{tabs.forEach(x=>x.classList.remove('active'));b.classList.add('active');paint(tabs.length===2?(i===0?'open':'closed'):(i===0?'open':i===1?'closed':'pending'));};});
    const active=tabs.findIndex(b=>b.classList.contains('active'));paint(tabs.length===2?(active===1?'closed':'open'):(active===1?'closed':active===2?'pending':'open'));
  }
  
  function syncHeroBalance(balance, equity, pnl, starting){
    const money=v=>'$'+Number(v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
    const balTxt=money(balance);
    const ids=['purchasedAccountValue','purchasedBalance','heroBalance'];
    ids.forEach(id=>{ const el=document.getElementById(id); if(el) el.textContent=balTxt; });
    // balance-card under purchased account (label BALANCE)
    document.querySelectorAll('.balance-card').forEach(card=>{
      const lab=(card.querySelector('span')?.textContent||'').trim().toUpperCase();
      const strong=card.querySelector('strong');
      if(!strong)return;
      if(lab==='BALANCE' || lab==='ACCOUNT VALUE') strong.textContent=balTxt;
    });
    // challenge name if present on account later
    const nameEl=document.getElementById('purchasedAccountName');
    // keep name from courses; only balance sync here
  }

  async function load(){
    if(busy)return;busy=true;
    try{
      const user=(window.ceAuth&&window.ceAuth.currentUser)||(typeof ceAuth!=='undefined'&&ceAuth.currentUser)||null;
      if(!user){setTradeMsg('Login required');return;}
      if(typeof user.getIdToken!=='function'){setTradeMsg('Auth token missing');return;}
      let data;
      try{data=await getHistory(user);}
      catch(err){
        console.warn('Dashboard live data:',err?.message||err);
        setTradeMsg('History load failed: '+(err?.message||err));
        try{
          if(typeof auraAccount==='function'){
            const a=await auraAccount();
            if(a&&!a.__error){
              const starting=num(a.startingBalance||a.accountSize||a.initialBalance),balance=num(a.balance||starting),equity=num(a.equity||balance);
              const pnl=Number.isFinite(Number(a.pnl))?Number(a.pnl):(balance-starting);
              set('accountBalance',money(balance)); try{syncHeroBalance(balance,equity,pnl,starting);}catch(e){}set('accountEquity',money(equity));
              set('accountPnl',(pnl>=0?'+':'-')+money(Math.abs(pnl)),pnl<0?'#ff5b70':'#68d58a');
              set('dailyDrawdown',pct(num(a.dailyDrawdownPct))+' / '+pct(num(a.dailyDrawdownLimit??4)));
              set('maxDrawdown',pct(num(a.maxDrawdownPct))+' / '+pct(num(a.maxDrawdownLimit??8)));
              paintFloatingWarn(a);paintRiskBars(a);
            }
          }
        }catch(e){}
        startCountdown();return;
      }
      const open=Array.isArray(data.open)?data.open:[],pending=Array.isArray(data.pending)?data.pending:[],closed=Array.isArray(data.closed)?data.closed:[];
      const a=data.account||{};
      const starting=num(a.startingBalance||a.accountSize||a.initialBalance),balance=num(a.balance||starting),equity=num(a.equity||balance);
      const pnl=Number.isFinite(Number(a.pnl))?Number(a.pnl):(balance-starting);
      set('accountBalance',money(balance)); try{syncHeroBalance(balance,equity,pnl,starting);}catch(e){}set('accountEquity',money(equity));
      set('accountPnl',(pnl>=0?'+':'-')+money(Math.abs(pnl)),pnl<0?'#ff5b70':'#68d58a');
      set('dailyDrawdown',pct(num(a.dailyDrawdownPct))+' / '+pct(num(a.dailyDrawdownLimit??a.dailyDrawdown??4)));
      set('maxDrawdown',pct(num(a.maxDrawdownPct))+' / '+pct(num(a.maxDrawdownLimit??a.maxDrawdown??8)));
      set('openPositionsCount',String(open.length));
      set('profitPercent',(starting?((pnl/starting)*100):0).toFixed(2)+'%');
      const status=String(a.status||'ACTIVE').toUpperCase();
      set('accountStatus',status,status==='BREACHED'?'#ff6b96':'#68d58a');
      paintFloatingWarn(a);paintRiskBars(a);
      renderAnalytics(closed);renderTrades(open,pending,closed);startCountdown();
    }catch(e){console.warn('Dashboard live data:',e?.message||e);setTradeMsg('Error: '+(e?.message||e));}
    finally{busy=false;}
  }
  function init(){
    if(!byId('accountBalance'))return;
    const tryLoad=()=>{if(window.ceAuth?.currentUser)load();};
    tryLoad();
    if(window.ceAuth?.onAuthStateChanged)window.ceAuth.onAuthStateChanged(function(u){if(u)load();});
    clearInterval(timer);timer=setInterval(load,20000);startCountdown();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
