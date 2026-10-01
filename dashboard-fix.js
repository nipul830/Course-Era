(function(){
  'use strict';
  const API='https://aurafirming.in';
  const KEY='auraSelectedDashboardAccountV2';
  let timer=null;
  const money=v=>'$'+Number(v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  async function load(){
    if(!document.querySelector('.dashboard')||typeof ceAuth==='undefined'||!ceAuth.currentUser)return;
    try{
      const user=ceAuth.currentUser;
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
      const account=data.account||{};
      const open=Array.isArray(data.open)?data.open:[];
      const pending=Array.isArray(data.pending)?data.pending:[];
      const closed=Array.isArray(data.closed)?data.closed:[];
      const set=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v};
      let realized=0,wins=0,losses=0;
      closed.forEach(p=>{const v=Number(p.realizedPnl??p.pnl??0)||0;realized+=v;if(v>0)wins++;else if(v<0)losses++});
      const balance=Number(account.balance||0),equity=Number(account.equity||balance),start=Number(account.startingBalance||balance);
      const pnl=Number(account.pnl??realized??0)||0;
      set('accountBalance',money(balance));set('accountEquity',money(equity));set('accountPnl',(pnl>=0?'+':'-')+money(Math.abs(pnl)));set('openPositionsCount',open.length);
      const pct=start?((equity-start)/start)*100:0;set('profitPercent',(pct>=0?'+':'')+pct.toFixed(2)+'%');
      const empty=document.getElementById('tradeEmpty'),tabs=[...document.querySelectorAll('.trade-tabs button')];
      if(!empty||!tabs.length)return;
      const render=mode=>{
        const rows=mode==='open'?open:mode==='pending'?pending:closed;
        if(!rows.length){empty.className='trade-empty';empty.style.cssText='';empty.textContent=mode==='open'?'No open trades':mode==='pending'?'No pending trades':'No trade history';return;}
        empty.className='trade-list';empty.style.cssText='display:grid;gap:7px;max-height:270px;overflow:auto';
        empty.innerHTML=rows.slice(0,100).map(p=>{const v=Number(p.realizedPnl??p.pnl??0)||0;const side=String(p.side||'').toUpperCase();const when=p.closedAt||p.openedAt||p.createdAt||'';return '<div style="padding:9px 10px;border:1px solid #302713;border-radius:9px;background:#090806;display:flex;justify-content:space-between;gap:8px;align-items:center"><div><strong style="display:block;color:#fff;font-size:11px">'+esc(p.name||p.symbol||'Trade')+' · '+esc(side)+'</strong><small style="display:block;color:#7f6d43;margin-top:2px">'+esc(when?new Date(when).toLocaleString():'—')+'</small></div><strong style="color:'+(v>=0?'#55d58a':'#ff5b86')+'">'+(v>=0?'+':'-')+money(Math.abs(v))+'</strong></div>'}).join('');
      };
      tabs.forEach((b,i)=>{b.onclick=()=>{tabs.forEach(x=>x.classList.remove('active'));b.classList.add('active');render(i===0?'open':i===1?'closed':'pending')}});
      if(tabs.length===2){tabs[0].onclick=()=>{tabs.forEach(x=>x.classList.remove('active'));tabs[0].classList.add('active');render('open')};tabs[1].onclick=()=>{tabs.forEach(x=>x.classList.remove('active'));tabs[1].classList.add('active');render('closed')}}
      render(tabs[0].classList.contains('active')?'open':'closed');
      set('profitPercent',(pct>=0?'+':'')+pct.toFixed(2)+'%');
    }catch(e){console.warn('Dashboard trade history fix:',e)}
  }
  function start(){load();clearInterval(timer);timer=setInterval(load,10000);window.addEventListener('storage',e=>{if(e.key===KEY)load()})}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();