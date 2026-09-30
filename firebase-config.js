// Course Era Firebase client configuration
const firebaseConfig = {
  apiKey: "AIzaSyBqrMvKivVsrVEr8hwDpVWg8f3ZfZttLVQ",
  authDomain: "courseera-22425.firebaseapp.com",
  projectId: "courseera-22425",
  storageBucket: "courseera-22425.firebasestorage.app",
  messagingSenderId: "263442433438",
  appId: "1:263442433438:web:31a490f6ee3579322f828f",
  measurementId: "G-3T6QSQNN2M"
};

if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const ceAuth = firebase.auth();
ceAuth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);

// Dashboard account fallback: newer purchased accounts are stored in
// /api/trading-accounts. Keep the existing dashboard API as the primary path,
// but recover automatically if the legacy selected-account document is missing.
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
        const res=await fetch('/api/trading-accounts',{
          headers:{Authorization:'Bearer '+token},
          cache:'no-store'
        });
        const data=await res.json().catch(()=>({}));
        if(!res.ok)throw new Error(data.error||'Account unavailable');
        const accounts=Array.isArray(data.accounts)?data.accounts:[];
        const account=accounts.find(a=>String(a?.status||'').toLowerCase()==='active')||accounts[0];
        if(!account)throw new Error('No active trading account found');
        const startingBalance=Number(account.startingBalance??account.accountSize??account.size??0)||0;
        const balance=Number(account.balance??startingBalance)||0;
        const equity=Number(account.equity??balance)||balance;
        const pnl=Number(account.pnl??(balance-startingBalance))||0;
        return {
          id:account.accountId||account.id||'account',
          accountId:account.accountId||account.id||'account',
          startingBalance,
          balance,
          equity,
          pnl,
          currency:account.currency||'USD',
          challenge:account.challenge||account.name||'Funded Account',
          challengeId:account.challengeId||'',
          sourcePaymentId:account.sourcePaymentId||'',
          status:account.status||'active',
          dailyDrawdownPct:Number(account.dailyDrawdownPct||0),
          maxDrawdownPct:Number(account.maxDrawdownPct||0),
          dailyDrawdownLimit:Number(account.dailyDrawdownLimit||4),
          maxDrawdownLimit:Number(account.maxDrawdownLimit||8)
        };
      }catch(e){
        console.warn('Dashboard account fallback failed:',e?.message||e);
        return primary||{__error:String(e?.message||'Account unavailable')};
      }
    };
    clearInterval(timer);
  },50);
})();

// Challenge page navigation: keep the same highlighted Home control used by
// the dashboard, while removing any challenge-page menu/logout controls.
(function(){
  function applyChallengeHome(){
    if(!/\/challenge(?:\.html)?(?:\/|$)/i.test(location.pathname)) return;

    const styleId='auraChallengeHomeFix';
    if(!document.getElementById(styleId)){
      const style=document.createElement('style');
      style.id=styleId;
      style.textContent=`
        header.nav .top-links{display:none!important}
        header.nav nav:not(.top-links){display:none!important}
        header.nav .menu-toggle,header.nav .auth-nav{display:none!important}
        .aura-challenge-home{position:absolute;left:4%;top:14px;z-index:40;display:inline-flex;align-items:center;padding:9px 15px;border:1px solid #d6b35a;border-radius:10px;background:linear-gradient(180deg,#2a220f,#171106);color:#f1d98a;font-size:14px;font-weight:800;letter-spacing:.3px;box-shadow:0 0 18px #d6b35a22,inset 0 0 0 1px #f1d98a18;text-decoration:none}
        .aura-challenge-home:hover{color:#fff1bd}
        @media(min-width:761px){.aura-challenge-home{left:6%;top:18px}}
      `;
      document.head.appendChild(style);
    }

    document.querySelectorAll('header.nav .menu-toggle,header.nav .auth-nav').forEach(el=>el.remove());
    document.querySelectorAll('header.nav .linkbtn').forEach(el=>el.remove());

    let home=document.querySelector('.aura-challenge-home');
    if(!home){
      home=document.createElement('a');
      home.className='aura-challenge-home';
      home.href='index.html';
      home.textContent='Home';
      document.querySelector('header.nav')?.appendChild(home);
    }
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',applyChallengeHome,{once:true});
  else applyChallengeHome();
})();

// Position page: remember whether Open or Closed was selected across refreshes.
(function(){
  if(!/\/position(?:\.html)?(?:\/|$)/i.test(location.pathname)) return;
  const s=document.createElement('script');
  s.src='position-tab-fix.js?v=1';
  s.async=false;
  document.head.appendChild(s);
})();
