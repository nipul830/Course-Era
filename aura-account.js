(function(){
  const AURA_API_BASE='https://course-era.onrender.com';
  async function auraAccount(){
    try{
      if(typeof ceAuth==='undefined'||!ceAuth.currentUser)return null;
      const token=await ceAuth.currentUser.getIdToken();
      const res=await fetch(AURA_API_BASE+'/api/trading-account',{headers:{Authorization:'Bearer '+token}});
      let data={};try{data=await res.json()}catch(e){}
      if(!res.ok)throw new Error(data.error||'Account unavailable');
      return data.account||null;
    }catch(e){console.warn('Aura account unavailable:',e.message);return null}
  }
  function auraMoney(v){return '$'+Number(v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}
  window.auraAccount=auraAccount;
  window.auraMoney=auraMoney;
})();