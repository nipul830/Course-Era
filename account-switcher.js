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
      .aura-account-switcher-card{background:#050505;border:1px solid #3a2c13;border-radius:16px;padding:10px 12px;box-shadow:0 10px 28px #0005}
      .aura-account-switcher-title{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;color:#f1d98a;font-size:11px;font-weight:900;letter-spacing:.7px;text-transform:uppercase}
      .aura-account-switcher-title small{color:#7f6d43;font-size:9px;font-weight:700;text-transform:none;letter-spacing:0}
      .aura-account-switcher-list{display:flex;gap:8px;overflow-x:auto;scroll-snap-type:x mandatory;scroll-behavior:smooth;overscroll-behavior-x:contain;scrollbar-width:none;-webkit-overflow-scrolling:touch;padding:0 0 2px}
      .aura-account-switcher-list::-webkit-scrollbar{display:none}
      .aura-account-switcher-item{box-sizing:border-box;flex:0 0 100%;width:100%;scroll-snap-align:start;scroll-snap-stop:always;min-width:0;padding:9px 11px;border:1px solid #302713;border-radius:11px;background:#090806;color:#9b8552;text-align:left;cursor:pointer;touch-action:pan-x}
      .aura-account-switcher-item strong{display:block;color:#fff;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .aura-account-switcher-item span{display:block;margin-top:3px;color:#9b8552;font-size:10px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .aura-account-switcher-item.selected{border-color:#d6b35a;background:#171106;box-shadow:inset 0 0 0 1px #d6b35a33}
      .aura-account-switcher-item.selected strong{color:#f1d98a}
      .aura-account-switcher-empty{padding:9px 11px;border:1px dashed #302713;border-radius:11px;color:#7f6d43;font-size:10px;white-space:nowrap}
    `;
    document.head.appendChild(s);
  }

  async function getAccounts(user){
    const token=await user.getIdToken(false);
    const r=await fetch(API+'/api/trading-accounts',{headers:{Authorization:'Bearer '+token},cache:'no-store'});
    if(!r.ok)throw new Error('accounts '+r.status);
    const d=await r.json();
    return Array.isArray(d.accounts)?d.accounts.slice(0,5):[];
  }

  function accountId(a){return String(a?.accountId||a?.id||'').trim()}
  function accountSize(a){
    const n=Number(a?.startingBalance??a?.accountSize??a?.size??0);
    return n?'$'+n.toLocaleString('en-US'):'Account';
  }

  async function selectAccount(account){
    const id=accountId(account);
    if(!id)return;
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
      const title=document.createElement('div');
      title.className='aura-account-switcher-title';
      title.innerHTML='<span>Trading Accounts</span><small>Swipe to switch account</small>';
      const card=document.createElement('div');
      card.className='aura-account-switcher-card';
      const list=document.createElement('div');
      list.className='aura-account-switcher-list';
      card.append(title,list);host.appendChild(card);
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
    const selected=localStorage.getItem(KEY)||accountId(accounts[0]);
    if(!localStorage.getItem(KEY))localStorage.setItem(KEY,selected);
    accounts.forEach((a,i)=>{
      const id=accountId(a); if(!id)return;
      const b=document.createElement('button');b.type='button';
      b.className='aura-account-switcher-item'+(id===selected?' selected':'');
      const name=String(a.challenge||a.name||('Account '+(i+1)));
      b.innerHTML='<strong></strong><span></span>';
      b.querySelector('strong').textContent=id;
      b.querySelector('span').textContent=name+' · '+accountSize(a);
      b.addEventListener('click',()=>selectAccount(a));
      list.appendChild(b);
    });
    requestAnimationFrame(()=>{
      const index=accounts.findIndex(a=>accountId(a)===selected);
      if(index>0){const item=list.children[index];if(item)list.scrollLeft=item.offsetLeft}
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