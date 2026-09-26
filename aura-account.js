(function(){
  const AURA_API_BASE='https://course-era.onrender.com';
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
          // Do not hammer Firestore when the project has exhausted its quota.
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

  window.auraAccount=auraAccount;
  window.auraMoney=auraMoney;
})();