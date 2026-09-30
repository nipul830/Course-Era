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
