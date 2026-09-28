(function(){
  const AURA_API_BASE='https://aurafirming.in';
  const ACCOUNT_TIMEOUT_MS=8000;
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

  // If an API response contains explicit account identifiers, keep only records
  // belonging to the currently authenticated terminal account. If the server
  // already scopes the response, records without an account field are preserved.
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

  const nativeFetch=window.fetch.bind(window);
  window.fetch=async function(input,init){
    const response=await nativeFetch(input,init);
    try{
      const url=typeof input==='string'?input:(input?.url||'');
      if(!url.includes('/api/trading/history')&&!url.includes('/api/trading/positions'))return response;
      const clone=response.clone();
      const data=await clone.json();
      const filtered=filterByActiveAccount(data);
      return new Response(JSON.stringify(filtered),{
        status:response.status,
        statusText:response.statusText,
        headers:response.headers
      });
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
})();
