(function(){
  const AURA_API_BASE='https://course-era.onrender.com';
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  async function auraAccount(){
    if(typeof ceAuth==='undefined'||!ceAuth.currentUser)return null;
    let lastError=null;
    for(let attempt=0;attempt<4;attempt++){
      try{
        const user=ceAuth.currentUser;
        const token=await user.getIdToken(attempt===0);
        const res=await fetch(AURA_API_BASE+'/api/trading-account',{headers:{Authorization:'Bearer '+token},cache:'no-store'});
        let data={};try{data=await res.json()}catch(e){}
        if(!res.ok)throw new Error(data.error||'Account unavailable');
        return data.account||null;
      }catch(e){
        lastError=e;
        // Render services can take a few seconds to wake from sleep. Retry
        // transient startup/network failures instead of showing a blank dash.
        if(attempt<3)await sleep(1000*(attempt+1));
      }
    }
    console.warn('Aura account unavailable after retries:',lastError?.message||lastError);
    return null;
  }
  function auraMoney(v){return '+Number(v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}
  window.auraAccount=auraAccount;
  window.auraMoney=auraMoney;
})();