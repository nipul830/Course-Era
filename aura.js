function logout(){
  try{ceAuth.signOut().then(()=>location.href='index.html')}
  catch(e){location.href='index.html'}
}

// Keep the five-account selector in the exact 1/2/3/4/5 arrangement
// from the supplied reference drawing, including on phone-sized screens.
(function(){
  function applyAccountLayout(){
    if(document.getElementById('auraAccountLayoutFix'))return;
    const style=document.createElement('style');
    style.id='auraAccountLayoutFix';
    style.textContent=`
      @media(max-width:700px){
        .aura-attach-grid{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;grid-template-rows:auto auto auto!important;gap:8px!important}
        .aura-attach-slot.slot-2{grid-column:1 / 4!important;grid-row:1!important;min-height:82px!important}
        .aura-attach-slot.slot-3{grid-column:1!important;grid-row:2!important}
        .aura-attach-slot.slot-1{grid-column:2!important;grid-row:2!important;min-height:118px!important}
        .aura-attach-slot.slot-4{grid-column:3!important;grid-row:2!important}
        .aura-attach-slot.slot-5{grid-column:1 / 4!important;grid-row:3!important;min-height:82px!important}
        .aura-attach-slot{min-width:0!important;padding:9px!important;gap:7px!important}
        .aura-attach-slot-name{font-size:12px!important}
        .aura-attach-slot.slot-1 .aura-attach-slot-name{font-size:15px!important}
        .aura-attach-slot-num,.aura-attach-id,.aura-attach-size{font-size:8px!important}
        .aura-attach-actions{gap:4px!important}
        .aura-attach-actions button{padding:5px 4px!important;font-size:9px!important}
        .aura-attach-selected{font-size:7px!important}
      }
      @media(max-width:380px){
        .aura-attach-card{padding:12px!important}
        .aura-attach-grid{gap:6px!important}
        .aura-attach-slot{padding:7px!important}
        .aura-attach-slot-name{font-size:10px!important}
        .aura-attach-slot.slot-1 .aura-attach-slot-name{font-size:12px!important}
        .aura-attach-actions button{font-size:8px!important;padding:4px 2px!important}
      }
    `;
    document.head.appendChild(style);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',applyAccountLayout,{once:true});
  else applyAccountLayout();
})();