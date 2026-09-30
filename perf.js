(function(){
  const API='https://aurafirming.in';
  const originalFetch=window.fetch.bind(window);
  function accountId(){try{return String(window.auraTerminalAccountContext?.()?.accountId||'').trim()}catch(e){return ''}}
  function cacheKey(path){return 'auraPerf:'+accountId()+':'+path}
  function cached(path){try{return JSON.parse(sessionStorage.getItem(cacheKey(path))||'null')}catch(e){return null}}
  function store(path,data){try{sessionStorage.setItem(cacheKey(path),JSON.stringify({at:Date.now(),data}))}catch(e){}}
  window.fetch=function(input,init){
    const url=typeof input==='string'?input:(input?.url||'');
    const isGet=!init?.method||String(init.method).toUpperCase()==='GET';
    if(isGet&&url.startsWith(API)&&(/\/api\/trading\/history(?:\?|$)/.test(url)||/\/api\/trading\/positions(?:\?|$)/.test(url))){
      const path=url.slice(API.length),hit=cached(path);
      const network=originalFetch(input,init).then(async r=>{try{const d=await r.clone().json();store(path,d)}catch(e){}return r});
      if(hit?.data){network.catch(()=>{});return Promise.resolve(new Response(JSON.stringify(hit.data),{status:200,headers:{'Content-Type':'application/json'}}))}
      return network;
    }
    return originalFetch(input,init);
  };
})();
