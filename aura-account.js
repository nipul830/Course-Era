(function(){
  const AURA_API_BASE='https://aurafirming.in';
  const ACCOUNT_TIMEOUT_MS=8000;
  let accountPromise=null;
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));

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

  // Keep terminal history isolated by trading-account ID. When a user gets a
  // brand-new challenge, the new terminal session has a new accountId, so the
  // first session time for that account becomes the cutoff for displayed trades.
  function terminalAccountContext(){
    try{
      const token=sessionStorage.getItem('auraTerminalSession')||'';
      const parts=token.split('.');
      if(parts.length!==3||parts[0]!=='AF1')return null;
      const raw=parts[1].replace(/-/g,'+').replace(/_/g,'/');
      const json=decodeURIComponent(escape(atob(raw+'='.repeat((4-raw.length%4)%4))));
      const payload=JSON.parse(json);
      const accountId=String(payload.accountId||'').trim();
      if(!accountId)return null;
      const key='auraAccountFirstSeen:'+accountId;
      let firstSeen=Number(localStorage.getItem(key)||0);
      if(!Number.isFinite(firstSeen)||firstSeen<=0){
        const issuedAt=Number(payload.iat||0)*1000;
        firstSeen=issuedAt>0?issuedAt:Date.now();
        localStorage.setItem(key,String(firstSeen));
      }
      return {accountId,firstSeen};
    }catch(e){return null;}
  }

  function filterPositionHistory(data){
    if(!data||typeof data!=='object')return data;
    const ctx=terminalAccountContext();
    if(!ctx)return data;
    const cutoff=ctx.firstSeen;
    const tradeTime=p=>{
      const value=p?.openedAt||p?.createdAt||p?.closedAt;
      const t=Date.parse(value||'');
      return Number.isFinite(t)?t:0;
    };
    const keep=p=>{
      const t=tradeTime(p);
      return t===0||t>=cutoff;
    };
    const out={...data};
    if(Array.isArray(data.open))out.open=data.open.filter(keep);
    if(Array.isArray(data.closed))out.closed=data.closed.filter(keep);
    if(Array.isArray(data.positions))out.positions=data.positions.filter(keep);
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
      const filtered=filterPositionHistory(data);
      return new Response(JSON.stringify(filtered),{
        status:response.status,
        statusText:response.statusText,
        headers:response.headers
      });
    }catch(e){
      return response;
    }
  };

  window.auraAccount=auraAccount;
  window.auraMoney=auraMoney;
})();
