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

  // If the website user changes, never keep the previous user's terminal session.
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

  // Bind terminal login to the current website account and verify that the
  // signed terminal token belongs to that same account before accepting it.
  const nativeFetch=window.fetch.bind(window);
  window.fetch=async function(input,init){
    const url=typeof input==='string'?input:(input?.url||'');
    if(!/\/api\/terminal\/login(?:\?|$)/i.test(url)) return nativeFetch(input,init);

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

  // The main page script runs before this guard when it is injected at the end
  // of the document. Reload once if an old user's session was found.
  const boot=()=>{
    if(!validateStoredSession()) location.reload();
  };
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot,{once:true});
  else boot();
})();
