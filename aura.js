function logout(){try{ceAuth.signOut().then(()=>location.href='index.html')}catch(e){location.href='index.html'}}
ceAuth.onAuthStateChanged(async function(user){
  if(!user){location.href='login.html?next=courses';return}
  const w=document.getElementById('welcome');
  if(w)w.textContent='Welcome, '+(user.displayName||user.email||'Trader')+' · Loading account…';
  try{
    const account=await auraAccount();
    if(w)w.textContent='Welcome, '+(user.displayName||user.email||'Trader')+' · Account '+(account?.id||'—');
  }catch(e){
    if(w)w.textContent='Welcome, '+(user.displayName||user.email||'Trader');
  }
});