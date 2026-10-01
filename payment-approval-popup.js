(function(){
  if(!/\/checkout(?:\.html)?(?:\/|$)/i.test(location.pathname)) return;
  if(window.__auraPaymentApprovalWatcher)return;
  window.__auraPaymentApprovalWatcher=true;

  const STYLE_ID='auraPaymentApprovalPopupStyle';
  const MODAL_ID='auraPaymentApprovalPopup';
  const HANDLED_PREFIX='auraPaymentApprovalHandled:';
  let timer=null;
  let busy=false;

  function addStyle(){
    if(document.getElementById(STYLE_ID))return;
    const style=document.createElement('style');
    style.id=STYLE_ID;
    style.textContent=`#${MODAL_ID}{position:fixed;inset:0;background:rgba(0,0,0,.78);display:none;align-items:center;justify-content:center;padding:20px;z-index:99999;font-family:Arial,Helvetica,sans-serif}#${MODAL_ID}.open{display:flex}#${MODAL_ID} .aura-approval-card{width:min(390px,92vw);background:#080808;border:1px solid #d6b35a;border-radius:18px;padding:24px;box-shadow:0 20px 70px #000}#${MODAL_ID} .aura-approval-icon{width:54px;height:54px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:#07170e;border:1px solid #7ee2a8;color:#7ee2a8;font-size:27px;margin-bottom:14px}#${MODAL_ID} h3{margin:0 0 8px;color:#f1d98a;font-size:22px}#${MODAL_ID} p{margin:0 0 20px;color:#ddd;font-size:14px;line-height:1.55}#${MODAL_ID} button{width:100%;height:46px;border:0;border-radius:11px;background:#f1d98a;color:#080808;font-size:14px;font-weight:900;cursor:pointer}`;
    document.head.appendChild(style);
  }

  function showApproved(payment){
    const id=String(payment?.id||payment?._id||'');
    if(!id || localStorage.getItem(HANDLED_PREFIX+id)==='1')return;
    localStorage.setItem(HANDLED_PREFIX+id,'1');
    localStorage.removeItem('auraPaymentPending');
    localStorage.removeItem('auraPaymentReviewEnds');
    addStyle();
    let modal=document.getElementById(MODAL_ID);
    if(!modal){
      modal=document.createElement('div');
      modal.id=MODAL_ID;
      modal.innerHTML='<div class="aura-approval-card" role="dialog" aria-modal="true"><div class="aura-approval-icon">✓</div><h3>Payment Approved</h3><p>Your challenge payment has been approved successfully. Tap OK to open your dashboard.</p><button type="button" id="auraApprovalOk">OK</button></div>';
      document.body.appendChild(modal);
      modal.querySelector('#auraApprovalOk').addEventListener('click',()=>{
        window.location.replace('courses.html');
      });
    }
    modal.classList.add('open');
  }

  async function token(){
    try{
      if(typeof ceAuth!=='undefined' && ceAuth.currentUser)return await ceAuth.currentUser.getIdToken(true);
    }catch{}
    return '';
  }

  async function check(){
    if(busy || document.visibilityState==='hidden')return;
    busy=true;
    try{
      const t=await token();
      if(!t)return;
      const r=await fetch('/api/challenge-payments/my',{headers:{Authorization:'Bearer '+t},cache:'no-store'});
      if(!r.ok)return;
      const d=await r.json().catch(()=>({}));
      const list=Array.isArray(d.payments)?d.payments:Array.isArray(d)?d:[];
      const challengePayments=list.filter(p=>String(p?.type||'').toLowerCase()==='challenge');
      if(!challengePayments.length)return;
      challengePayments.sort((a,b)=>new Date(b.submittedAt||b.createdAt||0)-new Date(a.submittedAt||a.createdAt||0));
      const latest=challengePayments[0];
      if(String(latest?.status||'').toLowerCase()==='approved')showApproved(latest);
      else if(String(latest?.status||'').toLowerCase()==='rejected'){
        localStorage.removeItem('auraPaymentPending');
        localStorage.removeItem('auraPaymentReviewEnds');
      }
    }catch(e){
      console.warn('Payment approval watcher:',e?.message||e);
    }finally{busy=false}
  }

  function start(){
    addStyle();
    check();
    clearInterval(timer);
    timer=setInterval(check,5000);
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')check()});
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});
  else start();
})();
