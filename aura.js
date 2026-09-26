function logout(){
  try{ceAuth.signOut().then(()=>location.href='index.html')}
  catch(e){location.href='index.html'}
}