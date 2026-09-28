(function(){
  const AURA_API_BASE='https://aurafirming.in';
  const ACCOUNT_TIMEOUT_MS=8000;
  const ATTACHED_ACCOUNTS_KEY='auraAttachedAccountsV1';
  let accountPromise=null;

  const sleep=ms=>new Promise(r=>setTimeout(r,ms));

  function decodeTerminalToken(token){
    try{
      const parts=String(token||'').split('.');
      if(parts.length!==3||parts[0]!=='AF1')return null;
      const raw=parts[1].replace(/-/g,'+').replace(/_/g,'/');
      const json=decodeURIComponent(escape(atob(raw+'='.repeat((4-raw.length%4)%4))));
      const payload=JSON.parse(json);
      const accountId=String(payload.accountId||'').trim();
      return accountId?payload:null;
    }catch(e){return null;}
  }

  function terminalAccountContext(){
    const token=sessionStorage.getItem('auraTerminalSession')||'';
    const payload=decodeTerminalToken(token);
    if(!payload)return null;
    const accountId=String(payload.accountId||'').trim();
    if(!accountId)return null;
    return {accountId,payload};
  }

  function terminalAccountStorageKey(accountId){
    return 'auraTerminalAccount:'+String(accountId||'').trim();
  }

  function saveTerminalAccount(account){
    try{
      const ctx=terminalAccountContext();
      const accountId=String(account?.accountId||account?.id||ctx?.accountId||'').trim();
      if(!accountId||!account)return;
      sessionStorage.setItem('auraTerminalAccount',JSON.stringify(account));
      localStorage.setItem(terminalAccountStorageKey(accountId),JSON.stringify(account));
      paintTerminalAccountNumber(accountId);
    }catch(e){}
  }

  function getSavedTerminalAccount(){
    try{
      const ctx=terminalAccountContext();
      if(!ctx)return null;
      const raw=localStorage.getItem(terminalAccountStorageKey(ctx.accountId));
      return raw?JSON.parse(raw):null;
    }catch(e){return null;}
  }

  function paintTerminalAccountNumber(accountId){
    if(!accountId)return;
    const paint=()=>{
      const label=document.querySelector('.mobile-terminal .account-label');
      if(!label)return;
      let el=document.getElementById('terminalAccountNumber');
      if(!el){
        el=document.createElement('span');
        el.id='terminalAccountNumber';
        el.style.cssText='display:inline-block;margin-left:7px;padding:2px 6px;border:1px solid #d6b35a;border-radius:6px;color:#8b6b22;font-size:9px;font-weight:900;letter-spacing:.03em;text-transform:none;vertical-align:middle;';
        label.appendChild(el);
      }
      el.textContent='A/C '+accountId;
    };
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',paint,{once:true});else paint();
  }

  function syncTerminalAccountNumber(){
    const ctx=terminalAccountContext();
    if(ctx)paintTerminalAccountNumber(ctx.accountId);
  }

  async function auraAccount(){
    if(typeof ceAuth==='undefined'||!ceAuth.currentUser)return null;
    if(accountPromise)return accountPromise;
    accountPromise=(async()=>{
      let lastError=null;
      for(let attempt=0;attempt<2;attempt++){
        try{
          const user=ceAuth.currentUser;
          const token=await user.getIdToken(false);
          const controller=new AbortController();
          const timeout=setTimeout(()=>controller.abort(),ACCOUNT_TIMEOUT_MS);
          const res=await fetch(AURA_API_BASE+'/api/trading-account',{
            headers:{Authorization:'Bearer '+token},
            cache:'no-store',
            signal:controller.signal
          });
          clearTimeout(timeout);
          let data={};try{data=await res.json()}catch(e){}
          if(!res.ok){
            const err=new Error(data.error||'Account unavailable');
            err.status=res.status;
            throw err;
          }
          return data.account||null;
        }catch(e){
          lastError=e;
          if(String(e.message||'').includes('RESOURCE_EXHAUSTED')||e.status===429)break;
          if(attempt===0)await sleep(1200);
        }
      }
      console.warn('Aura account unavailable:',lastError?.message||lastError);
      return { __error: String(lastError?.message||'Account unavailable') };
    })().finally(()=>{accountPromise=null});
    return accountPromise;
  }

  function auraMoney(v){
    return '$'+Number(v||0).toLocaleString('en-US',{
      minimumFractionDigits:2,
      maximumFractionDigits:2
    });
  }

  function filterByActiveAccount(data){
    const ctx=terminalAccountContext();
    if(!ctx||!data||typeof data!=='object')return data;
    const accountId=String(ctx.accountId);
    const belongsToAccount=(p)=>{
      if(!p||typeof p!=='object')return true;
      const candidate=p.accountId??p.tradingAccountId??p.account?.accountId??p.account?.id;
      return candidate==null||String(candidate)===accountId;
    };
    const out={...data};
    for(const key of ['open','closed','positions','trades','history']){
      if(Array.isArray(data[key]))out[key]=data[key].filter(belongsToAccount);
    }
    return out;
  }

  function readAttachedAccounts(){
    try{
      const raw=localStorage.getItem(ATTACHED_ACCOUNTS_KEY);
      const list=raw?JSON.parse(raw):[];
      return Array.isArray(list)?list.slice(0,5):[];
    }catch(e){return []}
  }

  function writeAttachedAccounts(list){
    try{localStorage.setItem(ATTACHED_ACCOUNTS_KEY,JSON.stringify(list.slice(0,5)));}catch(e){}
  }

  function accountDisplayName(account,index){
    return String(account?.name||account?.challenge||('Account '+(index+1))).slice(0,60);
  }

  function ensureAttachmentStyles(){
    if(document.getElementById('auraAttachmentStyles'))return;
    const style=document.createElement('style');
    style.id='auraAttachmentStyles';
    style.textContent=`
      .aura-attach-wrap{max-width:900px;margin:18px auto;padding:0 5%}
      .aura-attach-card{background:#050505;border:1px solid #3a2c13;border-radius:20px;padding:18px;box-shadow:0 15px 40px #0008}
      .aura-attach-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px}
      .aura-attach-head h2{margin:0;color:#f1d98a;font-size:22px}
      .aura-attach-head p{margin:4px 0 0;color:#9b8552;font-size:12px}
      .aura-attach-add{background:#d6b35a;color:#080808;border:0;border-radius:10px;padding:10px 13px;font-weight:900;cursor:pointer;white-space:nowrap}
      .aura-attach-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
      .aura-attach-slot{background:#000;border:1px solid #302713;border-radius:13px;padding:13px;min-height:92px;display:flex;flex-direction:column;justify-content:space-between;gap:10px}
      .aura-attach-slot.empty{border-style:dashed;align-items:center;justify-content:center;text-align:center;color:#7f6d43}
      .aura-attach-slot-top{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}
      .aura-attach-slot-num{color:#9b8552;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.8px}
      .aura-attach-slot-name{color:#fff;font-weight:900;font-size:15px;margin-top:3px;word-break:break-word}
      .aura-attach-id{color:#d6b35a;font-size:10px;margin-top:3px;word-break:break-all}
      .aura-attach-actions{display:flex;gap:7px}
      .aura-attach-actions button{flex:1;border:1px solid #4a3b1d;background:#090806;color:#f1d98a;border-radius:8px;padding:7px 8px;font-weight:800;font-size:11px;cursor:pointer}
      .aura-attach-actions .remove{color:#f09aa9;border-color:#4b1e29}
      .aura-attach-modal{position:fixed;inset:0;background:#000b;display:grid;place-items:center;padding:18px;z-index:9999}
      .aura-attach-modal.hidden{display:none}
      .aura-attach-dialog{width:min(460px,100%);background:#070707;border:1px solid #4a3b1d;border-radius:18px;padding:20px;box-shadow:0 25px 70px #000}
      .aura-attach-dialog h3{color:#f1d98a;margin:0 0 7px}
      .aura-attach-dialog p{color:#9b8552;font-size:12px;line-height:1.45}
      .aura-attach-dialog label{display:block;color:#f1d98a;font-size:11px;font-weight:900;margin-top:12px}
      .aura-attach-dialog input{width:100%;box-sizing:border-box;margin-top:6px;background:#000;border:1px solid #302713;border-radius:9px;color:#fff;padding:11px}
      .aura-attach-dialog-actions{display:flex;gap:8px;margin-top:15px}
      .aura-attach-dialog-actions button{flex:1;border-radius:9px;padding:10px;border:1px solid #302713;background:#090806;color:#f1d98a;font-weight:900}
      .aura-attach-dialog-actions .save{background:#d6b35a;color:#080808;border-color:#d6b35a}
      @media(max-width:560px){.aura-attach-grid{grid-template-columns:1fr}.aura-attach-head{align-items:flex-start;flex-direction:column}.aura-attach-add{width:100%}}
    `;
    document.head.appendChild(style);
  }

  function openAttachDialog(onSave){
    let modal=document.getElementById('auraAttachModal');
    if(!modal){
      modal=document.createElement('div');
      modal.id='auraAttachModal';
      modal.className='aura-attach-modal hidden';
      modal.innerHTML=`<div class="aura-attach-dialog" role="dialog" aria-modal="true">
        <h3>Attach trading account</h3>
        <p>Add the account ID shown for the trading account. You can keep up to 5 accounts attached to this dashboard.</p>
        <label>Account ID<input id="auraAttachAccountId" autocomplete="off" placeholder="AF-ACC-2026-XXXXXXXX"></label>
        <label>Account name (optional)<input id="auraAttachAccountName" autocomplete="off" placeholder="My 5K Account"></label>
        <div class="aura-attach-dialog-actions"><button type="button" id="auraAttachCancel">Cancel</button><button type="button" class="save" id="auraAttachSave">Attach Account</button></div>
      </div>`;
      document.body.appendChild(modal);
      modal.addEventListener('click',e=>{if(e.target===modal)modal.classList.add('hidden')});
      modal.querySelector('#auraAttachCancel').onclick=()=>modal.classList.add('hidden');
      modal.querySelector('#auraAttachSave').onclick=()=>{
        const id=modal.querySelector('#auraAttachAccountId').value.trim();
        const name=modal.querySelector('#auraAttachAccountName').value.trim();
        if(!id){modal.querySelector('#auraAttachAccountId').focus();return;}
        onSave({accountId:id,name:name||''});
        modal.classList.add('hidden');
      };
    }
    modal.querySelector('#auraAttachAccountId').value='';
    modal.querySelector('#auraAttachAccountName').value='';
    modal.classList.remove('hidden');
    setTimeout(()=>modal.querySelector('#auraAttachAccountId')?.focus(),50);
  }

  function mountDashboardAttachments(currentAccount){
    if(!document.querySelector('.dashboard'))return;
    if(document.getElementById('auraAttachedAccounts'))return;
    ensureAttachmentStyles();

    const section=document.createElement('section');
    section.id='auraAttachedAccounts';
    section.className='aura-attach-wrap';
    section.innerHTML=`<div class="aura-attach-card">
      <div class="aura-attach-head"><div><h2>Attached Trading Accounts</h2><p>Keep up to 5 accounts here and open the selected account in Terminal.</p></div><button class="aura-attach-add" type="button">+ Attach Account</button></div>
      <div class="aura-attach-grid"></div>
    </div>`;

    const dashboard=document.querySelector('.dashboard');
    const creds=document.getElementById('terminalCredentials');
    dashboard.insertBefore(section,creds||dashboard.firstElementChild);

    const grid=section.querySelector('.aura-attach-grid');
    const render=()=>{
      let list=readAttachedAccounts();
      if(currentAccount?.id && !list.some(x=>String(x.accountId)===String(currentAccount.id))){
        list=[{accountId:currentAccount.id,name:currentAccount.challenge||'Current Account',auto:true},...list].slice(0,5);
        writeAttachedAccounts(list);
      }
      grid.innerHTML='';
      for(let i=0;i<5;i++){
        const item=list[i];
        const card=document.createElement('div');
        card.className='aura-attach-slot'+(item?'':' empty');
        if(!item){
          card.innerHTML=`<div><strong>Account slot ${i+1}</strong><div style="font-size:11px;margin-top:4px">Empty</div></div>`;
        }else{
          card.innerHTML=`<div class="aura-attach-slot-top"><div><div class="aura-attach-slot-num">Account ${i+1}</div><div class="aura-attach-slot-name"></div><div class="aura-attach-id"></div></div></div><div class="aura-attach-actions"><button type="button" class="open">Open Terminal</button><button type="button" class="remove">Remove</button></div>`;
          card.querySelector('.aura-attach-slot-name').textContent=accountDisplayName(item,i);
          card.querySelector('.aura-attach-id').textContent=item.accountId;
          card.querySelector('.open').onclick=()=>{
            sessionStorage.setItem('auraSelectedAccountId',String(item.accountId));
            location.href='terminal.html?accountId='+encodeURIComponent(item.accountId);
          };
          card.querySelector('.remove').onclick=()=>{
            const next=readAttachedAccounts().filter(x=>String(x.accountId)!==String(item.accountId));
            writeAttachedAccounts(next);render();
          };
        }
        grid.appendChild(card);
      }
    };

    section.querySelector('.aura-attach-add').onclick=()=>{
      const list=readAttachedAccounts();
      if(list.length>=5)return;
      openAttachDialog(item=>{
        const next=readAttachedAccounts().filter(x=>String(x.accountId)!==String(item.accountId));
        next.push({accountId:String(item.accountId).trim(),name:String(item.name||'').trim()});
        writeAttachedAccounts(next.slice(0,5));
        render();
      });
    };
    render();
  }

  const nativeFetch=window.fetch.bind(window);
  window.fetch=async function(input,init){
    const response=await nativeFetch(input,init);
    try{
      const url=typeof input==='string'?input:(input?.url||'');
      if(!url.includes('/api/trading/history')&&!url.includes('/api/trading/positions'))return response;
      const clone=response.clone();
      const data=await clone.json();
      const filtered=filterByActiveAccount(data);
      return new Response(JSON.stringify(filtered),{status:response.status,statusText:response.statusText,headers:response.headers});
    }catch(e){
      return response;
    }
  };

  window.auraTerminalAccountContext=terminalAccountContext;
  window.auraTerminalAccountStorageKey=terminalAccountStorageKey;
  window.auraSaveTerminalAccount=saveTerminalAccount;
  window.auraGetSavedTerminalAccount=getSavedTerminalAccount;
  window.auraSyncTerminalAccountNumber=syncTerminalAccountNumber;
  window.auraAccount=auraAccount;
  window.auraMoney=auraMoney;

  syncTerminalAccountNumber();

  document.addEventListener('DOMContentLoaded',async()=>{
    if(!document.querySelector('.dashboard'))return;
    try{
      const account=await auraAccount();
      mountDashboardAttachments(account&&account.__error?null:account);
    }catch(e){mountDashboardAttachments(null);}
  });
})();