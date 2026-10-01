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
      if(typeof ceAuth!=='undefined' && ceAuth.currentUser)return await ceAuth.currentUser.getIdToken(false);
    }catch(e){
      console.warn('Payment approval auth:',e?.message||e);
    }
    return '';
  }

  async function compactScreenshot(file){
    if(file.size<=420000)return file;
    const img=await new Promise((resolve,reject)=>{
      const url=URL.createObjectURL(file);
      const image=new Image();
      image.onload=()=>{URL.revokeObjectURL(url);resolve(image)};
      image.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('Could not read payment screenshot'))};
      image.src=url;
    });
    const max=1280;
    const scale=Math.min(1,max/Math.max(img.width,img.height));
    const canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(img.width*scale));
    canvas.height=Math.max(1,Math.round(img.height*scale));
    const ctx=canvas.getContext('2d');
    if(!ctx)throw new Error('Could not prepare payment screenshot');
    ctx.drawImage(img,0,0,canvas.width,canvas.height);
    let quality=.78;
    let blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',quality));
    while(blob&&blob.size>420000&&quality>.35){
      quality-=.08;
      blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',quality));
    }
    if(!blob)throw new Error('Could not prepare payment screenshot');
    return new File([blob],'payment-screenshot.jpg',{type:'image/jpeg'});
  }

  async function loadSelectedChallenge(){
    const selectedId=localStorage.getItem('auraSelectedChallengeId');
    if(!selectedId)throw new Error('Selected challenge is missing. Please choose the challenge again.');
    const response=await fetch('/api/challenges',{cache:'no-store'});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.detail||data.error||'Could not load challenge details');
    const challenge=(Array.isArray(data.challenges)?data.challenges:[]).find(x=>x.id===selectedId);
    if(!challenge)throw new Error('Selected challenge is no longer available. Please choose it again.');
    return challenge;
  }

  function challengeAmount(challenge){
    const discount=Math.min(100,Math.max(0,Number(challenge.discountPercent)||0));
    const finalPrice=Math.round(Number(challenge.price)*(1-discount/100)*100)/100;
    const amount=Math.round(finalPrice*98);
    if(!Number.isFinite(amount)||amount<=0)throw new Error('Invalid challenge payment amount');
    return amount;
  }

  function installPaymentSubmitFix(){
    const original=document.getElementById('submit');
    const screenshot=document.getElementById('screenshot');
    const transactionInput=document.getElementById('transactionId');
    const status=document.getElementById('status');
    if(!original||!screenshot||!transactionInput||!status)return;
    if(window.__auraPaymentSubmitFixed)return;
    window.__auraPaymentSubmitFixed=true;

    // The original checkout listener forced a Firebase token refresh on every submit.
    // Replace only the button node so the existing checkout UI stays exactly the same,
    // while the new handler uses the current cached token and gives the real server error.
    const submit=original.cloneNode(true);
    original.replaceWith(submit);

    submit.addEventListener('click',async()=>{
      const transaction=transactionInput.value.trim();
      status.className='status';
      if(!transaction){
        status.textContent='Please enter your UTR / transaction ID.';
        status.classList.add('error');
        transactionInput.focus();
        return;
      }
      if(!screenshot.files||!screenshot.files[0]){
        status.textContent='Please upload your payment screenshot.';
        status.classList.add('error');
        return;
      }
      const user=(typeof ceAuth!=='undefined')?ceAuth.currentUser:null;
      if(!user){
        status.textContent='Your login session expired. Please login again.';
        status.classList.add('error');
        return;
      }

      submit.disabled=true;
      submit.textContent='Submitting…';
      status.textContent='Preparing screenshot…';
      try{
        const challenge=await loadSelectedChallenge();
        const amount=challengeAmount(challenge);
        const compact=await compactScreenshot(screenshot.files[0]);
        const authToken=await token();
        if(!authToken)throw new Error('Your login session expired. Please login again.');

        status.textContent='Submitting payment…';
        const form=new FormData();
        form.append('challengeId',String(challenge.id));
        form.append('currency','INR');
        form.append('amount',String(amount));
        form.append('method','UPI');
        form.append('transactionId',transaction);
        form.append('screenshot',compact);

        const response=await fetch('/api/challenge-payments',{method:'POST',headers:{Authorization:'Bearer '+authToken},body:form,cache:'no-store'});
        const text=await response.text();
        let data={};
        try{data=text?JSON.parse(text):{}}catch{}
        if(!response.ok)throw new Error(data.detail||data.error||('Payment request failed (HTTP '+response.status+')'));

        // From this point onward the payment is already accepted by the backend.
        // UI/localStorage errors must never turn a successful payment into a failure message.
        status.textContent=data.message||'Payment submitted successfully. Waiting for admin approval.';
        status.classList.add('success');
        submit.textContent='Payment Submitted';
        try{
          localStorage.removeItem('auraSelectedChallengeId');
          localStorage.removeItem('auraSelectedCurrency');
          localStorage.setItem('auraPaymentPending','1');
        }catch(e){console.warn('Payment local state:',e?.message||e)}
        try{
          if(typeof startApprovalTimer==='function')startApprovalTimer();
        }catch(e){console.warn('Payment review timer:',e?.message||e)}
      }catch(error){
        status.textContent=(error&&error.message)||'Payment submission failed. Please try again.';
        status.classList.add('error');
        submit.disabled=false;
        submit.textContent='Submit Payment';
      }
    });
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
    installPaymentSubmitFix();
    check();
    clearInterval(timer);
    timer=setInterval(check,5000);
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')check()});
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});
  else start();
})();
