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

  // Terminal history is already returned by the server for the authenticated
  // trading account. Do not apply a client-side first-seen/time cutoff: that
  // incorrectly hides an older account's history when the user logs back in.
  // The active terminal session/accountId is the source of identity.
  window.auraTerminalAccountContext=terminalAccountContext;
  window.auraTerminalAccountStorageKey=terminalAccountStorageKey;
  window.auraSaveTerminalAccount=saveTerminalAccount;
  window.auraGetSavedTerminalAccount=getSavedTerminalAccount;
  window.auraAccount=auraAccount;
  window.auraMoney=auraMoney;
})();
