function logout(){
  try{
    // Clear terminal session as well as the main Firebase login.
    // Terminal credentials are stored in sessionStorage and otherwise can
    // survive when Dashboard and Terminal are opened in different tabs.
    sessionStorage.removeItem('auraTerminalSession');
    sessionStorage.removeItem('auraTerminalRole');
    sessionStorage.removeItem('auraTerminalAccount');
    sessionStorage.removeItem('auraTerminalOwnerUid');
    try{ceAuth.signOut().then(()=>location.href='index.html')}
    catch(e){location.href='index.html'}
  }catch(e){location.href='index.html'}
}

// Keep the five-account selector in the exact 1/2/3/4/5 arrangement
// from the supplied reference drawing, including on phone-sized screens.
(function(){
  function applyAccountLayout(){
    if(document.getElementById('auraAccountLayoutFix'))return;
    const style=document.createElement('style');
    style.id='auraAccountLayoutFix';
    style.textContent=`
      @media(max-width:700px){
        .aura-attach-grid{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;grid-template-rows:auto auto auto!important;gap:8px!important}
        .aura-attach-slot.slot-2{grid-column:1 / 4!important;grid-row:1!important;min-height:82px!important}
        .aura-attach-slot.slot-3{grid-column:1!important;grid-row:2!important}
        .aura-attach-slot.slot-1{grid-column:2!important;grid-row:2!important;min-height:118px!important}
        .aura-attach-slot.slot-4{grid-column:3!important;grid-row:2!important}
        .aura-attach-slot.slot-5{grid-column:1 / 4!important;grid-row:3!important;min-height:82px!important}
        .aura-attach-slot{min-width:0!important;padding:9px!important;gap:7px!important}
        .aura-attach-slot-name{font-size:12px!important}
        .aura-attach-slot.slot-1 .aura-attach-slot-name{font-size:15px!important}
        .aura-attach-slot-num,.aura-attach-id,.aura-attach-size{font-size:8px!important}
        .aura-attach-actions{gap:4px!important}
        .aura-attach-actions button{padding:5px 4px!important;font-size:9px!important}
        .aura-attach-selected{font-size:7px!important}
      }
      @media(max-width:380px){
        .aura-attach-card{padding:12px!important}
        .aura-attach-grid{gap:6px!important}
        .aura-attach-slot{padding:7px!important}
        .aura-attach-slot-name{font-size:10px!important}
        .aura-attach-slot.slot-1 .aura-attach-slot-name{font-size:12px!important}
        .aura-attach-actions button{font-size:8px!important;padding:4px 2px!important}
      }
    `;
    document.head.appendChild(style);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',applyAccountLayout,{once:true});
  else applyAccountLayout();
})();

// Dashboard navigation: keep only Home in the top-left. Account switching is
// handled by account-switcher.js so there is only one source of truth for the
// selected purchased account.
(function(){
  function applyDashboardNavigation(){
    if(!document.querySelector('.dashboard'))return;

    const nav=document.querySelector('header.nav nav');
    if(nav){
      nav.querySelectorAll('.linkbtn').forEach(el=>el.remove());
      nav.querySelectorAll('a').forEach(link=>{
        if(link.getAttribute('href')==='challenge.html'||link.id==='dashboardBuyChallenge')link.remove();
      });

      const home=nav.querySelector('a[href="index.html"]');
      if(home){
        home.textContent='Home';
        home.style.cssText='display:inline-flex;align-items:center;padding:9px 15px;border:1px solid #d6b35a;border-radius:10px;background:linear-gradient(180deg,#2a220f,#171106);color:#f1d98a;font-size:14px;font-weight:800;letter-spacing:.3px;box-shadow:0 0 18px #d6b35a22,inset 0 0 0 1px #f1d98a18;';
      }
    }

    const pseudoFix=document.getElementById('auraDashboardNavFix')||document.createElement('style');
    pseudoFix.id='auraDashboardNavFix';
    pseudoFix.textContent='.dashboard::before{display:none!important}.dashboard .page-title h1 a{display:inline-block;color:inherit;text-decoration:none}.dashboard .page-title h1 a:hover{color:#f1d98a}';
    if(!pseudoFix.parentNode)document.head.appendChild(pseudoFix);

    const title=document.querySelector('.page-title h1');
    if(title)title.textContent='Dashboard';
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',applyDashboardNavigation,{once:true});
  else applyDashboardNavigation();
})();

// Visible brand text is now Aura Firming across pages that load aura.js.
(function(){
  const replaceBranding=()=>{
    const root=document.body;
    if(!root)return;
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
    const nodes=[];
    let node;
    while((node=walker.nextNode())){
      if(node.parentElement&&['SCRIPT','STYLE','NOSCRIPT'].includes(node.parentElement.tagName))continue;
      if(/Farming/i.test(node.nodeValue||''))nodes.push(node);
    }
    nodes.forEach(n=>{n.nodeValue=n.nodeValue.replace(/Farming/gi,'Firming')});
  };
  const start=()=>{
    replaceBranding();
    const observer=new MutationObserver(()=>replaceBranding());
    observer.observe(document.body,{subtree:true,childList:true,characterData:true});
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});
  else start();
})();

// Dashboard trade history/P&L repair. Loaded dynamically so existing dashboard
// markup and UI remain unchanged.
(function(){
  if(!document.querySelector('.dashboard'))return;
  const load=()=>{if(document.getElementById('auraDashboardTradeFix'))return;const s=document.createElement('script');s.id='auraDashboardTradeFix';s.src='dashboard-fix.js?v=2';s.async=true;document.head.appendChild(s)};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',load,{once:true});else load();
})();

// Terminal breach isolation: terminal switcher is backed by sessionStorage,
// so breach filtering must purge that local list using the authoritative API.
// Use XMLHttpRequest here intentionally: other terminal guards wrap fetch and
// may hide breached accounts before this check can see their status.
(function(){
  if(!/terminal\.html$/i.test(window.location.pathname))return;
  const API='https://aurafirming.in';
  const unlockedKey=()=>{try{const uid=ceAuth?.currentUser?.uid;return uid?'auraTerminalUnlocked:'+uid:null}catch(e){return null}};

  function rawAccountStatuses(token){
    return new Promise((resolve)=>{
      try{
        const xhr=new XMLHttpRequest();
        xhr.open('GET',API+'/api/trading-accounts',true);
        xhr.setRequestHeader('Authorization','Bearer '+token);
        xhr.setRequestHeader('Cache-Control','no-cache');
        xhr.timeout=10000;
        xhr.onload=()=>{
          try{
            if(xhr.status<200||xhr.status>=300)return resolve(null);
            const d=JSON.parse(xhr.responseText||'{}');
            const out={};
            (Array.isArray(d.accounts)?d.accounts:[]).forEach(a=>{
              const id=String(a?.accountId||a?.id||'').trim();
              if(!id)return;
              const fields=[a?.status,a?.accountStatus,a?.phaseStatus,a?.state,a?.lifecycleStatus,a?.breachStatus];
              const text=fields.map(v=>String(v??'').toLowerCase()).join(' ');
              const breached=fields.some(v=>/breach|revok|terminated|failed/.test(String(v??'').toLowerCase()))
                || /breach|revok|terminated|failed/.test(text)
                || Boolean(a?.breachedAt||a?.breachReason);
              out[id]=breached;
            });
            resolve(out);
          }catch(e){resolve(null)}
        };
        xhr.onerror=()=>resolve(null);
        xhr.ontimeout=()=>resolve(null);
        xhr.send();
      }catch(e){resolve(null)}
    });
  }

  async function purgeUnlocked(){
    const key=unlockedKey();
    if(!key)return;
    const user=typeof ceAuth==='undefined'?null:ceAuth.currentUser;
    if(!user)return;
    let unlocked={};
    try{unlocked=JSON.parse(sessionStorage.getItem(key)||'{}')||{}}catch(e){unlocked={}};
    const ids=Object.keys(unlocked);
    if(!ids.length)return;
    let token='';
    try{token=await user.getIdToken(false)}catch(e){return}
    const statuses=await rawAccountStatuses(token);
    if(!statuses)return;
    let changed=false;
    ids.forEach(id=>{
      if(statuses[id]===true){delete unlocked[id];changed=true;}
    });
    if(changed)sessionStorage.setItem(key,JSON.stringify(unlocked));
    const current=String(sessionStorage.getItem('auraTerminalAccount')||'');
    const currentId=(()=>{try{return JSON.parse(current)?.accountId||JSON.parse(current)?.id||''}catch(e){return''}})();
    if(currentId&&statuses[String(currentId)]===true){
      sessionStorage.removeItem('auraTerminalSession');
      sessionStorage.removeItem('auraTerminalRole');
      sessionStorage.removeItem('auraTerminalAccount');
    }
  }

  async function filterMenu(){
    await purgeUnlocked();
    const menu=document.getElementById('auraTerminalAccountSwitcher');
    if(!menu)return;
    const key=unlockedKey();
    let unlocked={};
    try{unlocked=JSON.parse(sessionStorage.getItem(key)||'{}')||{}}catch(e){unlocked={}};
    menu.querySelectorAll('[role="option"]').forEach(btn=>{
      const id=String(btn.querySelector('strong')?.textContent||'').trim();
      if(id&&!unlocked[id])btn.remove();
    });
    const list=menu.querySelector('[role="listbox"]')||menu.lastElementChild;
    if(list&&![...list.children].some(x=>x.getAttribute?.('role')==='option')){
      const msg=document.createElement('div');
      msg.style.cssText='padding:16px;color:#7b8793;font-size:12px;font-weight:700';
      msg.textContent='No active logged-in accounts.';
      list.innerHTML='';list.appendChild(msg);
    }
  }

  const boot=()=>{
    purgeUnlocked().catch(()=>{});
    const observer=new MutationObserver(()=>{if(document.getElementById('auraTerminalAccountSwitcher'))setTimeout(()=>filterMenu().catch(()=>{}),0)});
    observer.observe(document.body,{subtree:true,childList:true});
    setInterval(()=>filterMenu().catch(()=>{}),5000);
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
