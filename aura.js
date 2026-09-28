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

// Purchased accounts are loaded automatically; manual attachment is disabled.
(function(){
  const API='https://aurafirming.in';
  async function loadPurchasedAccounts(user){
    try{
      const token=await user.getIdToken(false);
      const headers={Authorization:'Bearer '+token,Accept:'application/json'};
      for(const path of ['/api/trading-accounts','/api/my-trading-accounts','/api/purchased-accounts']){
        try{
          const r=await fetch(API+path,{headers,cache:'no-store'});
          if(!r.ok)continue;
          const d=await r.json();
          const list=Array.isArray(d)?d:(Array.isArray(d.accounts)?d.accounts:(Array.isArray(d.data)?d.data:[]));
          if(list.length)return list.slice(0,5);
        }catch(e){}
      }
      const current=await window.auraAccount?.();
      return current&&!current.__error&&current.id?[current]:[];
    }catch(e){return []}
  }

  function renderPurchasedAccounts(list){
    const section=document.getElementById('auraAttachedAccounts');
    if(!section)return;
    const grid=section.querySelector('.aura-attach-grid');
    const label=section.querySelector('#auraSelectedAccountLabel');
    if(!grid)return;

    section.querySelector('.aura-attach-add')?.remove();
    section.querySelector('.aura-attach-head p')?.remove();
    grid.innerHTML='';

    const accounts=list.slice(0,5);
    const key='auraSelectedDashboardAccountV1';
    let selected=localStorage.getItem(key)||String(accounts[0]?.id||accounts[0]?.accountId||'');
    if(selected)localStorage.setItem(key,selected);

    accounts.forEach((account,index)=>{
      const id=String(account.id||account.accountId||'');
      const card=document.createElement('div');
      card.className='aura-attach-slot slot-'+(index+1)+(id===selected?' selected':'');
      const name=String(account.name||account.challenge||('Account '+(index+1)));
      const size=Number(account.startingBalance??account.accountSize??account.size??0);
      card.innerHTML='<div class="aura-attach-slot-top"><div><div class="aura-attach-slot-num">Account '+(index+1)+'</div><div class="aura-attach-slot-name"></div><div class="aura-attach-id"></div><div class="aura-attach-size"></div></div><div class="aura-attach-selected"></div></div>';
      card.querySelector('.aura-attach-slot-name').textContent=name;
      card.querySelector('.aura-attach-id').textContent=id;
      card.querySelector('.aura-attach-size').textContent=size?'$'+size.toLocaleString('en-US'):'Account';
      card.querySelector('.aura-attach-selected').textContent=id===selected?'SELECTED':'';
      card.onclick=()=>{localStorage.setItem(key,id);location.reload()};
      grid.appendChild(card);
    });

    for(let index=accounts.length;index<5;index++){
      const card=document.createElement('div');
      card.className='aura-attach-slot slot-'+(index+1)+' empty';
      card.innerHTML='<div><strong>Account '+(index+1)+'</strong><div style="font-size:11px;margin-top:4px">Not purchased</div></div>';
      grid.appendChild(card);
    }
    if(label){
      const current=accounts.find(a=>String(a.id||a.accountId||'')===selected);
      label.textContent=current?'Selected account: '+String(current.challenge||current.name||selected):'';
    }
  }

  document.addEventListener('DOMContentLoaded',async()=>{
    const user=typeof ceAuth!=='undefined'?ceAuth.currentUser:null;
    if(!user)return;
    const list=await loadPurchasedAccounts(user);
    renderPurchasedAccounts(list);
  },{once:true});
})();
