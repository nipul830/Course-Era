function logout(){
  try{ceAuth.signOut().then(()=>location.href='index.html')}
  catch(e){location.href='index.html'}
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
