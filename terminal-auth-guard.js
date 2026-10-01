// Aura Farming terminal account isolation guard.
// Binds the terminal session to the currently authenticated Course Era user.
(function(){
  if(!/\/terminal(?:\.html)?(?:\/|$)/i.test(location.pathname)) return;

  const SESSION='auraTerminalSession';
  const ROLE='auraTerminalRole';
  const ACCOUNT='auraTerminalAccount';
  const OWNER='auraTerminalOwnerUid';

  function clearTerminalSession(){
    sessionStorage.removeItem(SESSION);
    sessionStorage.removeItem(ROLE);
    sessionStorage.removeItem(ACCOUNT);
    sessionStorage.removeItem(OWNER);
  }

  function decodeSession(token){
    try{
      const parts=String(token||'').split('.');
      if(parts.length!==3 || parts[0]!=='AF1') return null;
      let encoded=parts[1].replace(/-/g,'+').replace(/_/g,'/');
      while(encoded.length%4) encoded+='=';
      return JSON.parse(atob(encoded));
    }catch{return null;}
  }

  function currentUid(){
    return String(window.ceAuth?.currentUser?.uid||'').trim();
  }

  function validateStoredSession(){
    const token=sessionStorage.getItem(SESSION)||'';
    if(!token) return true;
    const uid=currentUid();
    const payload=decodeSession(token);
    if(!uid || !payload?.uid || String(payload.uid)!==uid){
      clearTerminalSession();
      return false;
    }
    sessionStorage.setItem(OWNER,uid);
    return true;
  }

  const originalSignIn=window.ceAuth?.signInWithEmailAndPassword;
  if(typeof originalSignIn==='function'){
    window.ceAuth.signInWithEmailAndPassword=async function(email,password){
      clearTerminalSession();
      return originalSignIn.call(window.ceAuth,email,password);
    };
  }
  const originalSignOut=window.ceAuth?.signOut;
  if(typeof originalSignOut==='function'){
    window.ceAuth.signOut=async function(){
      clearTerminalSession();
      return originalSignOut.call(window.ceAuth);
    };
  }

  const nativeFetch=window.fetch.bind(window);
  window.fetch=async function(input,init){
    const url=typeof input==='string'?input:(input?.url||'');

    // Terminal account switcher must never receive breached accounts.
    // The dashboard uses its own account-switcher.js and is allowed to show history.
    if(/\/api\/trading-accounts(?:\?|$)/i.test(url)){
      const response=await nativeFetch(input,init);
      try{
        const data=await response.clone().json();
        if(response.ok&&Array.isArray(data?.accounts)){
          const current=String(sessionStorage.getItem(ACCOUNT)||'');
          const breachedCurrent=data.accounts.some(a=>String(a?.status||'').toLowerCase()==='breached' && String(a?.accountId||a?.id||'')===current);
          if(breachedCurrent) clearTerminalSession();
          const activeAccounts=data.accounts.filter(a=>String(a?.status||'active').toLowerCase()!=='breached');
          return new Response(JSON.stringify({...data,accounts:activeAccounts}),{
            status:response.status,
            statusText:response.statusText,
            headers:response.headers
          });
        }
      }catch{}
      return response;
    }

    if(!/\/api\/terminal\/login(?:\?|$)/i.test(url)){
      const response=await nativeFetch(input,init);
      // If a currently logged-in account becomes breached, revoke the terminal session immediately.
      if(!response.ok && /\/api\/(?:terminal|trading|positions|orders)/i.test(url)){
        try{
          const data=await response.clone().json();
          if(String(data?.status||'').toLowerCase()==='breached' || /breach/i.test(String(data?.error||data?.detail||''))) clearTerminalSession();
        }catch{}
      }
      return response;
    }

    const uid=currentUid();
    if(!uid){
      return new Response(JSON.stringify({error:'Please login to your Aura Farming account first.'}),{
        status:401,
        headers:{'Content-Type':'application/json'}
      });
    }

    const headers=new Headers(init?.headers||((input instanceof Request)?input.headers:undefined));
    try{
      const authToken=await window.ceAuth.currentUser.getIdToken(true);
      if(authToken) headers.set('Authorization','Bearer '+authToken);
    }catch{}

    const response=await nativeFetch(input,{...(init||{}),headers});
    try{
      const data=await response.clone().json();
      if(response.ok&&data?.token){
        const payload=decodeSession(data.token);
        if(!payload?.uid || String(payload.uid)!==uid){
          return new Response(JSON.stringify({error:'This terminal account belongs to a different user.'}),{
            status:403,
            headers:{'Content-Type':'application/json'}
          });
        }
        sessionStorage.setItem(OWNER,uid);
      }
    }catch{}
    return response;
  };

  const boot=()=>{
    if(!validateStoredSession()) location.reload();
  };
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot,{once:true});
  else boot();
})();
