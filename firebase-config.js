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

function ceFirebaseAuth(){ return ceAuth; }
ceFirebaseAuth.Auth = { Persistence: { LOCAL: "local" } };
ceFirebaseAuth.getInstance = () => ceAuth;
// Do not redeclare the global Firebase identifier when legacy Firebase SDK
// scripts are present on older pages. Keep the compatibility bridge on window.
window.firebase = { auth: ceFirebaseAuth };
(function(){
  if(!/\/terminal(?:\.html)?(?:\/|$)/i.test(location.pathname)) return;
  try{
    const token=sessionStorage.getItem('auraTerminalSession')||'';
    if(token && !token.startsWith('AF1.')){
      sessionStorage.removeItem('auraTerminalSession');
      sessionStorage.removeItem('auraTerminalRole');
      sessionStorage.removeItem('auraTerminalAccount');
    }
  }catch(e){}
})();


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

;

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

(function(){
  if(!/\/terminal(?:\.html)?(?:\/|$)/i.test(location.pathname)) return;
  const style=document.createElement('style');
  style.textContent='.terminal-logout-modal{position:fixed;inset:0;background:#0008;display:none;align-items:center;justify-content:center;padding:20px;z-index:10000;font-family:Arial,Helvetica,sans-serif}.terminal-logout-modal.open{display:flex}.terminal-logout-card{width:min(360px,92vw);background:#fff;border-radius:18px;padding:22px;box-shadow:0 18px 55px #0006}.terminal-logout-card h3{margin:0 0 8px;color:#182332;font-size:20px}.terminal-logout-card p{margin:0 0 18px;color:#687786;font-size:13px;line-height:1.45}.terminal-logout-actions{display:flex;gap:10px}.terminal-logout-actions button{flex:1;height:44px;border-radius:11px;font-size:13px;font-weight:800;cursor:pointer}.terminal-logout-cancel{border:1px solid #dce2e7;background:#f7f8fa;color:#344252}.terminal-logout-confirm{border:0;background:#e6b83f;color:#101010}';
  document.head.appendChild(style);
  function closeModal(modal){ if(modal)modal.classList.remove('open'); }
  function openModal(){
    let modal=document.getElementById('terminalLogoutModal');
    if(!modal){
      modal=document.createElement('div'); modal.id='terminalLogoutModal'; modal.className='terminal-logout-modal';
      modal.innerHTML='<div class="terminal-logout-card" role="dialog" aria-modal="true" aria-labelledby="terminalLogoutTitle"><h3 id="terminalLogoutTitle">Logout?</h3><p>Are you sure you want to logout from the terminal?</p><div class="terminal-logout-actions"><button type="button" class="terminal-logout-cancel" id="terminalLogoutCancel">❌ Cancel</button><button type="button" class="terminal-logout-confirm" id="terminalLogoutConfirm">✅ Logout</button></div></div>';
      document.body.appendChild(modal);
      modal.querySelector('#terminalLogoutCancel').addEventListener('click',()=>closeModal(modal));
      modal.querySelector('#terminalLogoutConfirm').addEventListener('click',()=>{closeModal(modal);sessionStorage.removeItem('auraTerminalSession');sessionStorage.removeItem('auraTerminalRole');sessionStorage.removeItem('auraTerminalAccount');window.location.href='index.html';});
      modal.addEventListener('click',e=>{if(e.target===modal)closeModal(modal)});
    }
    modal.classList.add('open');
  }
  document.addEventListener('click',function(e){const button=e.target.closest?.('#terminalLogout');if(!button)return;e.preventDefault();e.stopImmediatePropagation();openModal();},true);
})();

(function(){
  const MARKER='||AF_RULES||';
  const FLOATING_PCTS=[0.25,0.50,0.75,1,1.25,1.50,1.75,2,2.25,2.50];
  const clampDays=v=>Math.max(0,Math.min(10,Number(v)||0));
  const clampPct=v=>{const n=Number(v);return Number.isFinite(n)?Math.max(.25,Math.min(2.5,n)):1};
  function b64Encode(value){try{return btoa(unescape(encodeURIComponent(value)))}catch{return btoa(value)}}
  function b64Decode(value){try{return decodeURIComponent(escape(atob(value)))}catch{return atob(value)}}
  function decodeEvaluation(value){const raw=String(value||'');const i=raw.indexOf(MARKER);if(i<0)return {evaluation:raw,config:null};try{return {evaluation:raw.slice(0,i),config:JSON.parse(b64Decode(raw.slice(i+MARKER.length)))}}catch{return {evaluation:raw.slice(0,i),config:null}}}
  function encodeEvaluation(evaluation,config){return String(evaluation||'').split(MARKER)[0]+MARKER+b64Encode(JSON.stringify(config||{}));}
  function modelOf(model){return String(model||'')}
  function stagesFor(model){return modelOf(model)==='2 Step'?[['phase1','Phase 1'],['phase2','Phase 2'],['funded','Funded']]:modelOf(model)==='1 Step'?[['phase1','Phase 1'],['funded','Funded']]:[['funded','Funded']]}
  function dayOptions(value){let out='';for(let i=0;i<=10;i++)out+='<option value="'+i+'"'+(Number(value||0)===i?' selected':'')+'>'+i+' day'+(i===1?'':'s')+'</option>';return out}
  function setupAdmin(){
    if(!/\/admin-challenges(?:\.html)?(?:\/|$)/i.test(location.pathname))return;
    const boot=()=>{if(window.__auraChallengeControlsAdmin)return;if(!document.getElementById('form')||typeof window.formData!=='function'||typeof window.fill!=='function')return;window.__auraChallengeControlsAdmin=true;const form=document.getElementById('form');const anchor=form.querySelector('.rules');const box=document.createElement('div');box.className='rules';box.id='auraChallengeRuleControls';box.innerHTML='<div class="ruleshead"><span>Floating Loss</span></div><div class="row"><div class="field"><label>Enable</label><label class="check"><input id="auraFloatingLossEnabled" type="checkbox"> Enable floating loss</label></div><div class="field"><label>Floating Loss %</label><select id="auraFloatingLossPct">'+FLOATING_PCTS.map(x=>'<option value="'+x+'">'+x.toFixed(2).replace(/0+$/,'').replace(/\.$/,'')+'%</option>').join('')+'</select></div></div><div class="ruleshead" style="margin-top:8px"><span>Minimum Trading Days</span></div><div id="auraMinTradingDays"></div>';anchor?.parentNode?.insertBefore(box,anchor);const renderDays=(model,values={})=>{const root=document.getElementById('auraMinTradingDays');if(!root)return;root.innerHTML='<div class="row">'+stagesFor(model).map(x=>'<div class="field"><label>'+x[1]+'</label><select class="aura-min-day" data-stage="'+x[0]+'">'+dayOptions(values[x[0]])+'</select></div>').join('')+'</div>'};const collect=()=>{const minTradingDays={};document.querySelectorAll('.aura-min-day').forEach(x=>minTradingDays[x.dataset.stage]=clampDays(x.value));return minTradingDays};const originalFill=window.fill;window.fill=function(x){const d=decodeEvaluation(x?.evaluation||'');originalFill({...x,evaluation:d.evaluation});const cfg=d.config||{};const en=document.getElementById('auraFloatingLossEnabled'),pct=document.getElementById('auraFloatingLossPct'),model=document.getElementById('model');if(en)en.checked=cfg.floatingLossEnabled===true;if(pct)pct.value=String(clampPct(cfg.floatingLossPct||1));renderDays(model?.value||x?.model||'1 Step',cfg.minTradingDays||{})};const originalFormData=window.formData;window.formData=function(){const x=originalFormData();x.evaluation=encodeEvaluation(x.evaluation,{floatingLossEnabled:document.getElementById('auraFloatingLossEnabled')?.checked===true,floatingLossPct:clampPct(document.getElementById('auraFloatingLossPct')?.value||1),minTradingDays:collect()});return x};document.getElementById('model')?.addEventListener('change',()=>renderDays(document.getElementById('model').value,{}));renderDays(document.getElementById('model')?.value||'1 Step',{});};const t=setInterval(()=>{boot();if(window.__auraChallengeControlsAdmin)clearInterval(t)},50);setTimeout(()=>clearInterval(t),10000)}
  async function loadChallengeConfig(account){try{const challengeId=String(account?.challengeId||'').trim();if(!challengeId)return null;const r=await fetch('/api/challenges',{cache:'no-store'});const d=await r.json().catch(()=>({}));const challenge=(Array.isArray(d.challenges)?d.challenges:[]).find(x=>String(x?.id||'')===challengeId);if(!challenge)return null;const decoded=decodeEvaluation(challenge.evaluation||'');return {...challenge,evaluation:decoded.evaluation,ruleConfig:decoded.config||{}}}catch(e){return null}}
  function renderDashboardRules(account,challenge){const box=document.getElementById('accountRules');if(!box||!challenge)return;const model=String(challenge.model||'');const cfg=challenge.ruleConfig||{};const days=cfg.minTradingDays||{};const items=[['Challenge Type',account?.challenge||challenge.model+' '+challenge.size],['Account Size',auraMoney(account?.startingBalance||challenge.accountSize)],['Daily Drawdown',String(challenge.dailyDrawdown||'4%')],['Max Drawdown',String(challenge.totalDrawdown||'8%')]];if(challenge.profitTarget)items.push(['Profit Target',String(challenge.profitTarget)]);if(challenge.phase1Profit)items.push(['Phase 1 Target',String(challenge.phase1Profit)]);if(challenge.phase2Profit)items.push(['Phase 2 Target',String(challenge.phase2Profit)]);items.push(['Floating Loss',cfg.floatingLossEnabled===true?clampPct(cfg.floatingLossPct||1).toFixed(2)+'%':'OFF']);for(const [key,label] of stagesFor(model))items.push(['Min Days — '+label,String(clampDays(days[key]))]);box.innerHTML=items.map(x=>'<div class="rule-item"><span>'+x[0]+'</span><strong>'+x[1]+'</strong></div>').join('');const daily=document.getElementById('dailyDrawdown'),max=document.getElementById('maxDrawdown');if(daily)daily.textContent=Number(account?.dailyDrawdownPct||0).toFixed(2)+'% / '+String(challenge.dailyDrawdown||'4%');if(max)max.textContent=Number(account?.maxDrawdownPct||0).toFixed(2)+'% / '+String(challenge.totalDrawdown||'8%')}
  function setupDashboard(){if(!/\/courses(?:\.html)?(?:\/|$)/i.test(location.pathname))return;const run=async()=>{if(typeof window.auraAccount!=='function'||!ceAuth?.currentUser)return;try{const account=await window.auraAccount();if(!account||account.__error)return;const challenge=await loadChallengeConfig(account);if(challenge)renderDashboardRules(account,challenge)}catch(e){console.warn('Challenge rule dashboard update failed:',e)}};const t=setInterval(()=>{if(document.getElementById('accountRules'))run()},1000);setTimeout(()=>clearInterval(t),15000);setTimeout(run,1200)}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>{setupAdmin();setupDashboard()},{once:true});else{setupAdmin();setupDashboard()}
})();