(function(){
  if(!/\/position(?:\.html)?(?:\/|$)/i.test(location.pathname)) return;
  const key='auraPositionTab';
  function wire(){
    const tabs=[...document.querySelectorAll('.tab')];
    if(tabs.length<2){setTimeout(wire,50);return;}
    tabs.forEach(btn=>{
      if(btn.dataset.positionTabFixBound==='1')return;
      btn.dataset.positionTabFixBound='1';
      btn.addEventListener('click',()=>sessionStorage.setItem(key,btn.dataset.tab),true);
    });
    const saved=sessionStorage.getItem(key);
    if(saved && saved!=='open'){
      const target=tabs.find(btn=>btn.dataset.tab===saved);
      if(target && !target.classList.contains('active'))target.click();
    }
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',wire,{once:true});
  else wire();
})();
