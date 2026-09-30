// Aura Farming authentication client.
// Firebase has been removed from the runtime. The existing ceAuth name is kept
// as a compatibility API so the rest of the dashboard can continue unchanged.
const CE_AUTH_TOKEN_KEY = "ce_auth_token";
const CE_AUTH_USER_KEY = "ce_user";

function ceStoredToken(){ return localStorage.getItem(CE_AUTH_TOKEN_KEY) || ""; }
function ceStoredUser(){
  try { return JSON.parse(localStorage.getItem(CE_AUTH_USER_KEY) || "null"); }
  catch { return null; }
}
function ceSave(user, token){
  if(token) localStorage.setItem(CE_AUTH_TOKEN_KEY, token);
  if(user) localStorage.setItem(CE_AUTH_USER_KEY, JSON.stringify(user));
}
function ceClear(){ localStorage.removeItem(CE_AUTH_TOKEN_KEY); localStorage.removeItem(CE_AUTH_USER_KEY); }

async function ceRequest(path, options={}){
  const headers = new Headers(options.headers || {});
  headers.set("Content-Type", headers.get("Content-Type") || "application/json");
  const token = ceStoredToken();
  if(token) headers.set("Authorization", "Bearer " + token);
  const response = await fetch(path, { ...options, headers, cache:"no-store" });
  const data = await response.json().catch(()=>({}));
  if(!response.ok){
    const err = new Error(data.error || "Authentication request failed");
    err.code = data.code || "auth/request-failed";
    throw err;
  }
  return data;
}

function ceUserObject(data){
  if(!data) return null;
  const user = {
    uid: String(data.uid || ""),
    email: String(data.email || ""),
    displayName: String(data.displayName || data.name || ""),
    photoURL: String(data.photoURL || ""),
    admin: Boolean(data.admin),
    getIdToken: async () => ceStoredToken(),
    updateProfile: async patch => {
      const body = { name: patch?.displayName ?? user.displayName, photoURL: patch?.photoURL ?? user.photoURL };
      const result = await ceRequest("/api/profile", { method:"PUT", body:JSON.stringify(body) });
      user.displayName = result.name || user.displayName;
      user.photoURL = result.photoURL || user.photoURL;
      ceSave(user);
      return user;
    }
  };
  return user;
}

const ceAuthListeners = new Set();
let ceCurrentUser = ceUserObject(ceStoredUser());
function ceNotify(){ for(const listener of ceAuthListeners){ try{ listener(ceCurrentUser); }catch{} } }

const ceAuth = {
  get currentUser(){ return ceCurrentUser; },
  setPersistence: async () => undefined,
  async signInWithEmailAndPassword(email, password){
    const data = await ceRequest("/api/auth/login", { method:"POST", body:JSON.stringify({email, password}) });
    ceCurrentUser = ceUserObject(data.user);
    ceSave(data.user, data.token);
    ceNotify();
    return { user: ceCurrentUser };
  },
  async createUserWithEmailAndPassword(email, password){
    const name = window.__ceSignupName || "";
    const data = await ceRequest("/api/auth/signup", { method:"POST", body:JSON.stringify({email, password, name}) });
    ceCurrentUser = ceUserObject(data.user);
    ceSave(data.user, data.token);
    ceNotify();
    return { user: ceCurrentUser };
  },
  async signOut(){ ceCurrentUser = null; ceClear(); ceNotify(); },
  onAuthStateChanged(callback){
    ceAuthListeners.add(callback);
    queueMicrotask(() => { try{ callback(ceCurrentUser); }catch{} });
    return () => ceAuthListeners.delete(callback);
  }
};

// Tiny compatibility object for older pages that only referenced Firebase's
// persistence enum. It performs no Firebase network calls.
const firebase = {
  auth: {
    Auth: { Persistence: { LOCAL: "local" } },
    getInstance: () => ceAuth
  }
};

// Dashboard account fallback: newer purchased accounts are stored in /api/trading-accounts.
(function(){
  if(!/\/courses(?:\.html)?(?:\/|$)/i.test(location.pathname)) return;
  const started=Date.now();
  const timer=setInterval(()=>{
    if(typeof window.auraAccount!=='function'){
      if(Date.now()-started>6000)clearInterval(timer);
      return;
    }
    if(window.__auraDashboardAccountFallback)return;
    window.__auraDashboardAccountFallback=true;
    const originalAuraAccount=window.auraAccount;
    window.auraAccount=async function(){
      let primary=null;
      try{primary=await originalAuraAccount();}catch(e){primary={__error:String(e?.message||e||'Account unavailable')}}
      if(primary && !primary.__error)return primary;
      try{
        const user=ceAuth?.currentUser;
        if(!user)return primary;
        const token=await user.getIdToken(true);
        const res=await fetch('/api/trading-accounts',{headers:{Authorization:'Bearer '+token},cache:'no-store'});
        const data=await res.json().catch(()=>({}));
        if(!res.ok)throw new Error(data.error||'Account unavailable');
        const accounts=Array.isArray(data.accounts)?data.accounts:[];
        const account=accounts.find(a=>String(a?.status||'').toLowerCase()==='active')||accounts[0];
        if(!account)throw new Error('No active trading account found');
        const startingBalance=Number(account.startingBalance??account.accountSize??account.size??0)||0;
        const balance=Number(account.balance??startingBalance)||0;
        const equity=Number(account.equity??balance)||balance;
        const pnl=Number(account.pnl??(balance-startingBalance))||0;
        return {id:account.accountId||account.id||'account',accountId:account.accountId||account.id||'account',startingBalance,balance,equity,pnl,currency:account.currency||'USD',challenge:account.challenge||account.name||'Funded Account',challengeId:account.challengeId||'',sourcePaymentId:account.sourcePaymentId||'',status:account.status||'active',dailyDrawdownPct:Number(account.dailyDrawdownPct||0),maxDrawdownPct:Number(account.maxDrawdownPct||0),dailyDrawdownLimit:Number(account.dailyDrawdownLimit||4),maxDrawdownLimit:Number(account.maxDrawdownLimit||8)};
      }catch(e){
        console.warn('Dashboard account fallback failed:',e?.message||e);
        return primary||{__error:String(e?.message||'Account unavailable')};
      }
    };
    clearInterval(timer);
  },50);
})();

(function(){
  function applyChallengeHome(){
    if(!/\/challenge(?:\.html)?(?:\/|$)/i.test(location.pathname)) return;
    const styleId='auraChallengeHomeFix';
    if(!document.getElementById(styleId)){
      const style=document.createElement('style'); style.id=styleId;
      style.textContent=`header.nav .top-links{display:none!important}header.nav nav:not(.top-links){display:none!important}header.nav .menu-toggle,header.nav .auth-nav{display:none!important}.aura-challenge-home{position:absolute;left:4%;top:14px;z-index:40;display:inline-flex;align-items:center;padding:9px 15px;border:1px solid #d6b35a;border-radius:10px;background:linear-gradient(180deg,#2a220f,#171106);color:#f1d98a;font-size:14px;font-weight:800;letter-spacing:.3px;box-shadow:0 0 18px #d6b35a22,inset 0 0 0 1px #f1d98a18;text-decoration:none}.aura-challenge-home:hover{color:#fff1bd}@media(min-width:761px){.aura-challenge-home{left:6%;top:18px}}`;
      document.head.appendChild(style);
    }
    document.querySelectorAll('header.nav .menu-toggle,header.nav .auth-nav').forEach(el=>el.remove());
    document.querySelectorAll('header.nav .linkbtn').forEach(el=>el.remove());
    let home=document.querySelector('.aura-challenge-home');
    if(!home){home=document.createElement('a');home.className='aura-challenge-home';home.href='index.html';home.textContent='Home';document.querySelector('header.nav')?.appendChild(home);}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',applyChallengeHome,{once:true});else applyChallengeHome();
})();

(function(){
  if(!/\/position(?:\.html)?(?:\/|$)/i.test(location.pathname)) return;
  const s=document.createElement('script'); s.src='position-tab-fix.js?v=1'; s.async=false; document.head.appendChild(s);
})();
