const API_BASE='https://course-era.onrender.com';
let courses=JSON.parse(localStorage.getItem('ce_courses')||'null')||[{id:'trading-foundation',title:'Trading Foundation',price:4999,desc:'Market structure, risk management, chart reading and trading psychology.',icon:'📈'},{id:'price-action',title:'Price Action Mastery',price:6999,desc:'Structured price-action concepts, setups and trade planning.',icon:'🕯️'},{id:'indicator-pro',title:'Indicator Pro',price:2999,desc:'Understand indicators, confirmation and practical chart workflows.',icon:'⚡'}];

function goToCourses(e){
  if(e)e.preventDefault();
  if(typeof ceAuth==='undefined'){location.href='login.html?next=courses';return;}
  ceAuth.onAuthStateChanged(function(user){location.href=user?'courses.html':'login.html?next=courses';});
}
function protectPage(next='courses'){
  if(typeof ceAuth==='undefined'){location.replace('login.html?next='+encodeURIComponent(next));return;}
  ceAuth.onAuthStateChanged(function(user){
    if(!user) location.replace('login.html?next='+encodeURIComponent(next));
  });
}
async function getAuthToken(){try{if(typeof ceAuth!=='undefined'&&ceAuth.currentUser)return await ceAuth.currentUser.getIdToken();}catch(e){}return null}
async function apiFetch(path,options={}){const headers=new Headers(options.headers||{});const token=await getAuthToken();if(token)headers.set('Authorization','Bearer '+token);const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),10000);try{const res=await fetch(API_BASE+path,{...options,headers,signal:controller.signal});let data={};try{data=await res.json()}catch(e){}if(!res.ok)throw new Error(data.error||'Server request failed');return data}catch(err){if(err.name==='AbortError')throw new Error('Server timeout. Showing available courses.');throw err}finally{clearTimeout(timer)}}
async function loadCourses(){try{const data=await apiFetch('/api/courses');courses=Array.isArray(data.courses)?data.courses:[];saveCourses();return courses}catch(e){console.warn('Backend courses unavailable:',e.message);courses=[];saveCourses();return []}}
function saveCourses(){localStorage.setItem('ce_courses',JSON.stringify(courses))}function money(n){return '₹'+Number(n).toLocaleString('en-IN')}async function renderCourses(id,limit){const e=document.getElementById(id);if(!e)return;e.innerHTML='<div class="panel empty">Loading courses…</div>';await loadCourses();if(!courses.length){e.innerHTML='<div class="panel empty">No published courses available right now.</div>';return}e.innerHTML='';(limit?courses.slice(0,limit):courses).forEach(c=>e.insertAdjacentHTML('beforeend',`<article class="course"><div class="thumb">${c.thumbnail?'<img src="'+c.thumbnail+'" alt="">':(c.icon||'📚')}</div><div class="course-body"><h3>${c.title}</h3><p class="muted">${c.description||c.desc||''}</p><div class="card-row"><span class="price">${money(c.price)}</span><a class="btn primary" href="course-details.html?id=${c.id}">View Course</a></div></div></article>`))}function getCourse(){return courses.find(c=>c.id===new URLSearchParams(location.search).get('id'))||courses[0]}
async function loadPaymentSettings(){try{const data=await apiFetch('/api/payment-settings');return data.settings||{googlePayUpi:'lipupoddar-3@okaxis',phonePeUpi:'nipukumar007@ibl',merchantName:'Course Era',qrUpi:'lipupoddar-3@okaxis',qrImageUrl:'',usdtWallet:''}}catch(e){return {googlePayUpi:'lipupoddar-3@okaxis',phonePeUpi:'nipukumar007@ibl',merchantName:'Course Era',qrUpi:'lipupoddar-3@okaxis',usdtWallet:''}}}
async function getCourseFromBackend(){await loadCourses();return getCourse()}
async function renderDetail(){const c=await getCourseFromBackend();if(!c)return;document.getElementById('detail').innerHTML=`<div class="detail-grid"><div class="thumb" style="height:300px;border-radius:18px">${c.thumbnail?'<img src="'+c.thumbnail+'" alt="">':(c.icon||'📚')}</div><div><p class="eyebrow">COURSE</p><h1>${c.title}</h1><p class="muted">${c.description||c.desc||''}</p><h2 class="price">${money(c.price)}</h2><div class="actions"><a class="btn primary" href="payment.html?id=${c.id}">Buy Course</a><a class="btn ghost" href="courses.html">Back</a></div></div></div>`}async function renderPayment(){const c=await getCourseFromBackend();if(!c)return;const ps=await loadPaymentSettings();window.cePaymentSettings=ps;document.getElementById('paymentBox').innerHTML=`<div class="payment-summary"><div><span class="muted">Selected course</span><h2>${c.title}</h2></div><div class="payment-total"><span class="muted">Total</span><strong>${money(c.price)}</strong></div></div><div class="payment-methods"><button class="method active" type="button" onclick="showPay('qr',this)">▣ <span>UPI Apps</span><small>Google Pay / PhonePe</small></button><button class="method" type="button" onclick="showPay('usdt',this)">₮ <span>USDT</span><small>Crypto payment</small></button></div><div id="payQr" class="pay-panel"><div class="pay-head"><div><h3>Pay with UPI</h3><p class="muted">Choose your app. The course amount will be filled automatically.</p></div><span class="secure">✓ Secure</span></div><div class="upi-apps"><button class="app-pay" type="button" onclick="payWithUPI(${Number(c.price)},'Course Era - ${c.title.replace(/'/g,"\\'")}',(window.cePaymentSettings?.googlePayUpi||'lipupoddar-3@okaxis'),'com.google.android.apps.nbu.paisa.user')"><b>G</b><span>Google Pay</span><em>Pay ${money(c.price)}</em></button><button class="app-pay" type="button" onclick="payWithUPI(${Number(c.price)},'Course Era - ${c.title.replace(/'/g,"\\'")}',(window.cePaymentSettings?.phonePeUpi||'nipukumar007@ibl'),'com.phonepe.app')"><b>पे</b><span>PhonePe</span><em>Pay ${money(c.price)}</em></button></div><p class="pay-note">Google Pay: <b>${ps.googlePayUpi||''}</b><br>PhonePe: <b>${ps.phonePeUpi||''}</b></p></div><button class="btn primary full" type="button" id="inlinePaidBtn">✓ I Have Paid</button><div id="payUsdt" class="pay-panel hidden"><div class="pay-head"><div><h3>Pay with USDT</h3><p class="muted">Send the exact amount to the configured wallet.</p></div><span class="secure">USDT</span></div><div class="wallet"><span>USDT wallet address</span><code>ADMIN WILL CONFIGURE WALLET</code></div></div><p class="checkout-foot">Choose QR or Auto Payment above. After payment, use I Have Paid inside the payment popup.</p>`}function payWithUPI(amount,title,pa,pkg){const ps=window.cePaymentSettings||{merchantName:'Course Era'};const q='pa='+encodeURIComponent(pa)+'&pn='+encodeURIComponent(ps.merchantName||'Course Era')+'&am='+encodeURIComponent(Number(amount).toFixed(2))+'&cu=INR&tn='+encodeURIComponent(title);const intent='intent://pay?'+q+'#Intent;scheme=upi;package='+pkg+';end';const generic='upi://pay?'+q;window.location.href=intent;setTimeout(()=>{try{window.location.href=generic}catch(e){}},1800)} function showPay(type,btn){document.querySelectorAll('.method').forEach(x=>x.classList.remove('active'));btn.classList.add('active');document.getElementById('payQr').classList.toggle('hidden',type!=='qr');document.getElementById('payUsdt').classList.toggle('hidden',type!=='usdt')}function copyWallet(){navigator.clipboard?.writeText((window.cePaymentSettings&&window.cePaymentSettings.usdtWallet)||'')}async function signupDemo(e){
  e.preventDefault();
  const msg=document.getElementById('signupMsg');
  const name=document.getElementById('name').value.trim();
  const email=document.getElementById('email').value.trim();
  const password=document.getElementById('password').value;
  try{
    const cred=await ceAuth.createUserWithEmailAndPassword(email,password);
    await cred.user.updateProfile({displayName:name});
    localStorage.setItem('ce_user',JSON.stringify({uid:cred.user.uid,name:name,email:cred.user.email}));
    location.href=new URLSearchParams(location.search).get('next')==='courses'?'courses.html':'courses.html';
  }catch(err){
    if(msg)msg.textContent=firebaseAuthError(err);
  }
}
async function loginDemo(e){
  e.preventDefault();
  const msg=document.getElementById('loginMsg');
  const em=document.getElementById('email').value.trim();
  const password=document.getElementById('password').value;
  try{
    const cred=await ceAuth.signInWithEmailAndPassword(em,password);
    localStorage.setItem('ce_user',JSON.stringify({uid:cred.user.uid,name:cred.user.displayName||em.split('@')[0],email:cred.user.email}));
    const next=new URLSearchParams(location.search).get('next');
    location.href=next==='courses'?'courses.html':(next||'courses.html');
  }catch(err){
    if(msg)msg.textContent=firebaseAuthError(err);
  }
}
function firebaseAuthError(err){
  const map={
    'auth/email-already-in-use':'This email is already registered. Please login.',
    'auth/invalid-email':'Please enter a valid email address.',
    'auth/weak-password':'Password must be at least 6 characters.',
    'auth/user-not-found':'No account found with this email.',
    'auth/wrong-password':'Incorrect password.',
    'auth/invalid-credential':'Email or password is incorrect.',
    'auth/too-many-requests':'Too many attempts. Please try again later.',
    'auth/operation-not-allowed':'Email/Password login is not enabled in Firebase yet.'
  };
  return map[err.code]||err.message||'Authentication failed. Please try again.';
}
function syncFirebaseUser(user){
  if(user){
    localStorage.setItem('ce_user',JSON.stringify({uid:user.uid,name:user.displayName||user.email?.split('@')[0]||'User',email:user.email||''}));
  }else{
    localStorage.removeItem('ce_user');
  }
}async function logout(){
  localStorage.removeItem('ce_user');
  sessionStorage.removeItem('ce_user');
  try{if(typeof ceAuth!=='undefined')await ceAuth.signOut()}catch(e){}
  location.replace('login.html?logout=1');
}async function renderMyCourses(){const e=document.getElementById('myCourses');if(!e)return;e.innerHTML='<div class="panel empty">Loading your courses…</div>';try{const data=await apiFetch('/api/my-courses');const owned=data.courses||[];e.innerHTML='';if(!owned.length){e.innerHTML='<div class="panel empty">No courses yet. <a href="courses.html">Browse courses →</a></div>';return}owned.forEach(c=>e.insertAdjacentHTML('beforeend',`<article class="course"><div class="thumb">${c.thumbnail?'<img src="'+c.thumbnail+'" alt="">':(c.icon||'📚')}</div><div class="course-body"><h3>${c.title}</h3><p class="muted">${c.description||''}</p><a class="btn primary full" href="course-viewer.html?id=${c.id}">Access Course</a></div></article>`))}catch(err){e.innerHTML='<div class="panel empty">'+err.message+'<br><a href="login.html">Login again →</a></div>'}}async function renderViewer(){const id=new URLSearchParams(location.search).get('id');const e=document.getElementById('viewer');try{const data=await apiFetch('/api/courses/'+encodeURIComponent(id)+'/access');const c=data.course;e.innerHTML=`<div class="page-title"><p class="eyebrow">COURSE PLAYER</p><h1>${c.title}</h1></div><div class="panel">${c.videoUrl?`<video controls playsinline style="width:100%;border-radius:12px" src="${c.videoUrl}"></video>`:'<div style="aspect-ratio:16/9;background:#020705;border-radius:12px;display:grid;place-items:center;color:var(--muted)">Video will be available soon.</div>'}<h2>Course Content</h2><p class="muted">${c.description||''}</p></div>`}catch(err){e.innerHTML='<div class="panel empty">'+err.message+'<br><a href="my-courses.html">Back to My Courses →</a></div>'}}function submitPayment(e){e.preventDefault();localStorage.setItem('ce_pending_payment',JSON.stringify({courseId:new URLSearchParams(location.search).get('id'),txid:document.getElementById('txid').value,amount:document.getElementById('amount').value}));document.getElementById('payMsg').textContent='Payment submitted for verification.'}async function adminCourse(e){e.preventDefault();const msg=document.getElementById('adminMsg');try{const title=document.getElementById('courseTitle').value.trim();const price=Number(document.getElementById('coursePrice').value);const description=document.getElementById('courseDesc').value.trim();const videoUrl=document.getElementById('courseVideo').value.trim();const thumbnail=document.getElementById('courseImage')?.value.trim()||'';const data=await apiFetch('/api/courses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title,price,description,videoUrl,thumbnail,published:true})});msg.textContent='Course saved successfully. ID: '+data.id}catch(err){msg.textContent=err.message||'Could not save course.'}}document.addEventListener('DOMContentLoaded',()=>{const u=JSON.parse(localStorage.getItem('ce_user')||'null'),n=document.getElementById('profileName'),em=document.getElementById('profileEmail');if(n&&u){n.textContent=u.name;em.textContent=u.email}});
function enhancePaymentUI(){
  const box=document.getElementById('paymentBox'); if(!box) return;
  const c=getCourse();
  document.querySelectorAll('.app-pay').forEach(btn=>{
    btn.onclick=function(e){e.preventDefault();openPaymentPopup('pay',Number(c.price),c.title)};
  });
  const paid=box.querySelector('.payment-next a');
  if(paid){paid.removeAttribute('href');paid.className='btn primary';paid.textContent='I Have Paid →';paid.onclick=function(e){e.preventDefault();openPaymentPopup('verify',Number(c.price),c.title)};}
  const inlinePaid=document.getElementById('inlinePaidBtn');
  if(inlinePaid) inlinePaid.onclick=function(){openPaymentPopup('verify',Number(c.price),c.title)};
  const existing=localStorage.getItem('ce_payment_timer'); if(existing) showPaymentTimer();
}
function openPaymentPopup(mode,amount,title){
  let modal=document.getElementById('paymentModal');
  if(!modal){modal=document.createElement('div');modal.id='paymentModal';modal.className='payment-modal hidden';document.body.appendChild(modal);}
  modal.classList.remove('hidden');
  const ps=window.cePaymentSettings||{googlePayUpi:'lipupoddar-3@okaxis',phonePeUpi:'nipukumar007@ibl',merchantName:'Course Era',qrUpi:'lipupoddar-3@okaxis',usdtWallet:''}; const upi=ps.qrUpi||ps.googlePayUpi;
  const qrData='upi://pay?pa='+encodeURIComponent(upi)+'&pn='+encodeURIComponent('Course Era')+'&am='+encodeURIComponent(amount.toFixed(2))+'&cu=INR&tn='+encodeURIComponent('Course Era - '+title);
  const qr=ps.qrImageUrl||('https://api.qrserver.com/v1/create-qr-code/?size=280x280&data='+encodeURIComponent(qrData));
  if(mode==='verify'){
    modal.innerHTML='<div class="payment-modal-card"><button class="modal-close" id="closePayment">×</button><p class="eyebrow">PAYMENT VERIFICATION</p><h2>Submit payment details</h2><p class="muted">Payment ke baad UTR / transaction ID aur screenshot submit karein.</p><form class="verify-form" id="verifyForm"><label>UTR / Transaction ID<input id="inlineTxid" required placeholder="Enter UTR / reference ID"></label><label>Payment screenshot<input id="inlineProof" type="file" accept="image/*" required></label><button class="btn primary full" type="submit">Submit Payment →</button></form><p id="inlineMsg" class="msg"></p></div>';
    document.getElementById('closePayment').onclick=closePaymentPopup;
    document.getElementById('verifyForm').onsubmit=function(e){submitPaymentInline(e,amount,title)};
    return;
  }
  modal.innerHTML='<div class="payment-modal-card"><button class="modal-close" id="closePayment">×</button><p class="eyebrow">UPI PAYMENT</p><h2>Choose payment option</h2><div class="pay-tabs"><button class="pay-tab active" id="qrTab">QR</button><button class="pay-tab" id="autoTab">Auto Payment</button></div><div id="popupQr" class="popup-panel"><img class="payment-qr" src="'+qr+'" alt="UPI QR code"><p class="pay-note">Scan karke exactly <b>₹'+amount.toLocaleString('en-IN')+'</b> pay karein.</p></div><div id="popupAuto" class="popup-panel hidden"><p class="muted">Apna payment app choose karein. Amount automatically filled rahega.</p><div class="upi-apps"><button class="app-pay" id="gpayAuto" type="button"><b>G</b><span>Google Pay</span><em>₹'+amount.toLocaleString('en-IN')+'</em></button><button class="app-pay" id="phoneAuto" type="button"><b>पे</b><span>PhonePe</span><em>₹'+amount.toLocaleString('en-IN')+'</em></button></div></div><button class="btn primary full modal-paid" id="paidBtn" type="button">✓ I Have Paid</button></div>';
  document.getElementById('closePayment').onclick=closePaymentPopup;
  document.getElementById('qrTab').onclick=function(){switchPopupTab('qr',this)};
  document.getElementById('autoTab').onclick=function(){switchPopupTab('auto',this)};
  document.getElementById('gpayAuto').onclick=function(){payWithUPI(amount,title,ps.googlePayUpi||'lipupoddar-3@okaxis','com.google.android.apps.nbu.paisa.user')};
  document.getElementById('phoneAuto').onclick=function(){payWithUPI(amount,title,ps.phonePeUpi||'nipukumar007@ibl','com.phonepe.app')};
  const paidBtn=document.getElementById('paidBtn');paidBtn.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();openPaymentPopup('verify',amount,title)});
}
function switchPopupTab(tab,btn){
  document.querySelectorAll('.pay-tab').forEach(x=>x.classList.remove('active'));btn.classList.add('active');
  ['scanner','qr','auto'].forEach(x=>{const el=document.getElementById('popup'+x.charAt(0).toUpperCase()+x.slice(1));if(el)el.classList.toggle('hidden',x!==tab)});
}
function closePaymentPopup(){const m=document.getElementById('paymentModal');if(m)m.classList.add('hidden')}
async function submitPaymentInline(e,amount,title){
  e.preventDefault();
  const tx=document.getElementById('inlineTxid').value.trim();
  const proof=document.getElementById('inlineProof').files[0];
  const msg=document.getElementById('inlineMsg');
  try{
    if(typeof ceAuth==='undefined'||!ceAuth.currentUser)throw new Error('Please login before submitting payment.');
    const fd=new FormData();
    fd.append('courseId',new URLSearchParams(location.search).get('id')||'');
    fd.append('method','UPI');
    fd.append('transactionId',tx);
    fd.append('amount',String(amount));
    if(proof)fd.append('screenshot',proof);
    await apiFetch('/api/payments',{method:'POST',body:fd});
    const now=Date.now();
    localStorage.setItem('ce_pending_payment',JSON.stringify({courseId:new URLSearchParams(location.search).get('id'),txid:tx,amount:amount,proofName:proof?proof.name:'',submittedAt:now,status:'pending'}));
    localStorage.setItem('ce_payment_timer',JSON.stringify({startedAt:now,expiresAt:now+15*60*1000,courseTitle:title}));
    msg.textContent='Payment submitted successfully. 15-minute verification timer started.';
    closePaymentPopup();showPaymentTimer();
  }catch(err){msg.textContent=err.message||'Payment submission failed.'}
}
function showPaymentTimer(){
  let box=document.getElementById('paymentTimer');
  if(!box){box=document.createElement('div');box.id='paymentTimer';box.className='payment-timer';document.getElementById('paymentBox').appendChild(box)}
  const data=JSON.parse(localStorage.getItem('ce_payment_timer')||'null');if(!data)return;
  const tick=()=>{
    const left=Math.max(0,data.expiresAt-Date.now()),min=Math.floor(left/60000),sec=Math.floor(left/1000)%60;
    box.innerHTML='<b>Payment verification</b><span>'+String(min).padStart(2,'0')+':'+String(sec).padStart(2,'0')+'</span><small>Admin approval pending.</small>';
    if(left<=0){
      const p=JSON.parse(localStorage.getItem('ce_pending_payment')||'null');
      if(p&&p.status!=='approved'){
        const msg=encodeURIComponent('Hello Course Era, my payment is still pending after 15 minutes. UTR: '+(p.txid||'Not provided')+' | Course: '+(data.courseTitle||'Course'));
        localStorage.removeItem('ce_payment_timer');
        box.innerHTML='<b>15 minutes completed.</b><small>Opening WhatsApp…</small>';
        setTimeout(()=>{location.href='https://wa.me/917608094247?text='+msg},900);
      }
      return;
    }
    setTimeout(tick,1000);
  };tick();
}
