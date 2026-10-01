(function(){
  'use strict';
  const API='https://aurafirming.in';
  const KEY='auraSelectedDashboardAccountV2';
  let started=false;

  function injectStyle(){
    if(document.getElementById('auraAccountSwitcherStyle'))return;
    const s=document.createElement('style');
    s.id='auraAccountSwitcherStyle';
    s.textContent=`
      .aura-account-switcher{margin:0 auto 14px;max-width:900px;padding:0 5%}
      .aura-account-switcher-card{position:relative;background:#050505;border:1px solid #3a2c13;border-radius:16px;padding:10px 12px;box-shadow:0 10px 28px #0005}
      .aura-account-switcher-toggle{width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 13px;border:1px solid #d6b35a;border-radius:12px;background:#090806;color:#f1d98a;font-size:12px;font-weight:900;letter-spacing:.8px;text-transform:uppercase;cursor:pointer}
      .aura-account-switcher-toggle .arrow{font-size:14px;transition:transform .2s ease}
      .aura-account-switcher-card.open .aura-account-switcher-toggle .arrow{transform:rotate(180deg)}
      .aura-account-switcher-list{display:none;margin-top:8px;max-height:280px;overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;-webkit-overflow-scrolling:touch}
      .aura-account-switcher-card.open .aura-account-switcher-list{display:block}
      .aura-account-switcher-item{box-sizing:border-box;width:100%;margin-bottom:7px;padding:10px 11px;border:1px solid #302713;border-radius:11px;background:#090806;color:#9b8552;text-align:left;cursor:pointer}
      .aura-account-switcher-item:last-child{margin-bottom:0}
      .aura-account-switcher-item strong{display:block;color:#fff;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .aura-account-switcher-item span{display:block;margin-top:3px;color:#9b8552;font-size:10px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .aura-account-switcher-item.selected{border-color:#d6b35a;background:#171106;box-shadow:inset 0 0 0 1px #d6b35a33}
      .aura-account-switcher-item.selected strong{color:#f1d98a}
      .aura-account-switcher-item.breached{border-color:#6b1735;background:#12070b}
      .aura-account-switcher-item.breached strong{color:#ff6b96}
      .aura-account-switcher-item.breached span{color:#d887a1}
      .aura-account-switcher-empty{padding:10px 11px;border:1px dashed #302713;border-radius:11px;color:#7f6d43;font-size:10px}
      .aura-breach-modal{position:fixed;inset:0;z-index:99999;display:none;align-items:center;justify-content:center;padding:20px;background:#0009}
      .aura-breach-modal.open{display:flex}
      .aura-breach-card{width:min(430px,94vw);background:#090806;border:1px solid #6b1735;border-radius:18px;padding:20px;box-shadow:0 20px 70px #0008;color:#fff}
      .aura-breach-card h3{margin:0 0 5px;color:#ff6b96;font-size:18px}
      .aura-breach-card .sub{margin:0 0 15px;color:#9b8552;font-size:11px;font-weight:700}
      .aura-breach-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
      .aura-breach-row{padding:10px;border:1px solid #302713;border-radius:10px;background:#050505}
      .aura-breach-row small{display:block;color:#7f6d43;font-size:9px;font-weight:800;text-transform:uppercase}
      .aura-breach-row b{display:block;margin-top:3px;color:#fff;font-size:13px;word-break:break-word}
      .aura-breach-reason{margin-top:10px;padding:10px;border:1px solid #6b1735;border-radius:10px;background:#12070b;color:#ffb2c8;font-size:11px;font-weight:700}
      .aura-breach-close{width:100%;height:42px;margin-top:14px;border:1px solid #d6b35a;border-radius:10px;background:#171106;color:#f1d98a;font-weight:900;cursor:pointer}
    `;
    document.head.appendChild(s);
  }

  async function getAccounts(user){
    const token=await user.getIdToken(false);
    const r=await fetch(API+'/api/trading-accounts',{headers:{Authorization:'Bearer '+token},cache:'no-store'});
    if(!r.ok)throw new Error('accounts '+r.status);
    const d=await r.json();
    return Array.isArray(d.accounts)?d.accounts:[];
  }

  function accountId(a){return String(a?.accountId||a?.id||'').trim()}
  function accountSize(a){
    const n=Number(a?.startingBalance??a?.accountSize??a?.size??0);
    return n?'$'+n.toLocaleString('en-US'):'Account';
  }
  function money(v){return '$'+Number(v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}
  function isBreached(a){return String(a?.status||'').toLowerCase()==='breached'}

  function showBreachData(account){
    let modal=document.getElementById('auraBreachDataModal');
    if(!modal){
      modal=document.createElement('div');
      modal.id='auraBreachDataModal';
      modal.className='aura-breach-modal';
      modal.innerHTML='<div class="aura-breach-card"><h3>BREACHED ACCOUNT</h3><p class="sub" id="auraBreachSub"></p><div class="aura-breach-grid" id="auraBreachGrid"></div><div class="aura-breach-reason" id="auraBreachReason"></div><button type="button" class="aura-breach-close">Close</button></div>';
      modal.querySelector('.aura-breach-close').addEventListener('click',()=>modal.classList.remove('open'));
      modal.addEventListener('click',e=>{if(e.target===modal)modal.classList.remove('open')});
      document.body.appendChild(modal);
    }
    const id=accountId(account), balance=Number(account?.balance??0), equity=Number(account?.equity??balance), pnl=Number(account?.pnl??0);
    const grid=modal.querySelector('#auraBreachGrid');
    grid.innerHTML='';
    const rows=[
      ['Account',id||'—'],
      ['Challenge',String(account?.challenge||account?.name||'—')],
      ['Starting Balance',money(account?.startingBalance??account?.accountSize??0)],
      ['Balance',money(balance)],
      ['Equity',money(equity)],
      ['P&L',(pnl>=0?'+':'-')+money(Math.abs(pnl))],
      ['Phase',String(account?.phase||account?.stage||'—')],
      ['Status','BREACHED']
    ];
    rows.forEach(([k,v])=>{const row=document.createElement('div');row.className='aura-breach-row';const sm=document.createElement('small');sm.textContent=k;const b=document.createElement('b');b.textContent=v;row.append(sm,b);grid.appendChild(row)});
    modal.querySelector('#auraBreachSub').textContent='Read-only account data · Terminal access revoked';
    modal.querySelector('#auraBreachReason').textContent='Breach reason: '+String(account?.breachReason||'Account breached');
    modal.classList.add('open');
  }

  async function selectAccount(account){
    const id=accountId(account);
    if(!id)return;
    if(isBreached(account)){
      showBreachData(account);
      return;
    }
    localStorage.setItem(KEY,id);
    const user=typeof ceAuth!=='undefined'?ceAuth.currentUser:null;
    if(user){
      try{
        const token=await user.getIdToken(false);
        const r=await fetch(API+'/api/trading-account/select',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({accountId:id})});
        if(!r.ok){localStorage.removeItem(KEY);throw new Error('select '+r.status)}
      }catch(e){console.warn('Account switch failed',e);return}
    }
    window.location.reload();
  }

  function render(accounts){
    const dashboard=document.querySelector('.dashboard');
    if(!dashboard)return;
    let host=document.getElementById('auraAccountSwitcher');
    if(!host){
      host=document.createElement('section');
      host.id='auraAccountSwitcher';
      host.className='aura-account-switcher';

      const card=document.createElement('div');
      card.className='aura-account-switcher-card';

      const toggle=document.createElement('button');
      toggle.type='button';
      toggle.className='aura-account-switcher-toggle';
      toggle.innerHTML='<span>Account Switch</span><span class="arrow">▼</span>';

      const list=document.createElement('div');
      list.className='aura-account-switcher-list';

      toggle.addEventListener('click',()=>{
        card.classList.toggle('open');
      });

      card.append(toggle,list);
      host.appendChild(card);

      const pageTitle=dashboard.querySelector('.page-title');
      if(pageTitle)dashboard.insertBefore(host,pageTitle.nextSibling);else dashboard.insertBefore(host,dashboard.firstChild);
    }

    const list=host.querySelector('.aura-account-switcher-list');
    if(!list)return;
    list.innerHTML='';

    if(!accounts.length){
      list.innerHTML='<div class="aura-account-switcher-empty">No purchased accounts found</div>';
      return;
    }

    const selected=localStorage.getItem(KEY)||accountId(accounts.find(a=>!isBreached(a))||accounts[0]);
    if(!localStorage.getItem(KEY)&&selected)localStorage.setItem(KEY,selected);

    accounts.forEach((a,i)=>{
      const id=accountId(a); if(!id)return;
      const breached=isBreached(a);
      const b=document.createElement('button');
      b.type='button';
      b.className='aura-account-switcher-item'+(id===selected&&!breached?' selected':'')+(breached?' breached':'');
      const name=String(a.challenge||a.name||('Account '+(i+1)));
      b.innerHTML='<strong></strong><span></span>';
      b.querySelector('strong').textContent=id;
      b.querySelector('span').textContent=breached?'BREACHED · Tap to view data':name+' · '+accountSize(a);
      b.addEventListener('click',()=>selectAccount(a));
      list.appendChild(b);
    });
  }

  async function initForUser(user){
    if(!user||started)return;
    started=true;
    injectStyle();
    try{render(await getAccounts(user))}
    catch(e){
      console.warn('Account switcher unavailable',e);
      render([]);
    }
  }

  function init(){
    if(!document.querySelector('.dashboard'))return;
    injectStyle();
    if(typeof ceAuth==='undefined'||!ceAuth){
      setTimeout(init,300);
      return;
    }
    if(ceAuth.currentUser)initForUser(ceAuth.currentUser);
    ceAuth.onAuthStateChanged(user=>initForUser(user));
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();