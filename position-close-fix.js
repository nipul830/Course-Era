(function(){
  const API='https://aurafirming.in';
  let running=false;
  function token(){return sessionStorage.getItem('auraTerminalSession')||'';}
  async function api(path,opt={}){
    const headers={...(opt.headers||{}),Authorization:'Bearer '+token()};
    if(opt.body&&typeof opt.body==='object'){headers['Content-Type']='application/json';opt.body=JSON.stringify(opt.body);}
    const res=await fetch(API+path,{...opt,headers});
    let data={};try{data=await res.clone().json()}catch(e){}
    return {res,data};
  }
  async function reload(){
    try{if(typeof window.loadPositions==='function')await window.loadPositions();}
    catch(e){}
  }
  async function closeTrade(btn){
    if(running||btn.disabled)return;
    const id=String(btn.dataset.id||'').trim();
    if(!id){alert('Trade ID missing');return;}
    running=true;btn.disabled=true;const old=btn.textContent;btn.textContent='Closing…';
    try{
      let out=await api('/api/trading/positions/'+encodeURIComponent(id)+'/close',{method:'POST'});
      if(out.res.status===404){
        const fresh=await api('/api/trading/positions');
        const positions=Array.isArray(fresh.data?.positions)?fresh.data.positions:(Array.isArray(fresh.data?.open)?fresh.data.open:[]);
        const exists=positions.some(p=>String(p?.id||p?._id||p?.ticket||'')===id);
        if(exists){out=await api('/api/trading/positions/'+encodeURIComponent(id)+'/close',{method:'POST'});}
        else{
          await reload();
          running=false;
          return;
        }
      }
      if(!out.res.ok){throw new Error(out.data?.detail||out.data?.error||('Request failed (HTTP '+out.res.status+')'));}
      await reload();
    }catch(e){btn.disabled=false;btn.textContent=old;alert(e.message||'Unable to close trade');}
    finally{running=false;}
  }
  document.addEventListener('click',function(e){
    const btn=e.target?.closest?.('.close-position');
    if(!btn)return;
    e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();
    closeTrade(btn);
  },true);
})();
