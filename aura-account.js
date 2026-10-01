(function(){
  const AURA_API_BASE='https://aurafirming.in';
  const ACCOUNT_TIMEOUT_MS=8000;
  let accountPromise=null;
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));

  function decodeTerminalToken(token){
    try{
      const parts=String(token||'').split('.');
      if(parts.length!==3||parts[0]!=='AF1')return null;
      const raw=parts[1].replace(/-/g,'+').replace(/_/g,'/');
      const json=decodeURIComponent(escape(atob(raw+'='.repeat((4-raw.length%4)%4))));
      const payload=JSON.parse(json);
      const accountId=String(payload.accountId||'').trim();
      return accountId?payload:null;
    }catch(e){return null;}
  }

  function terminalAccountContext(){
    const token=sessionStorage.getItem('auraTerminalSession')||'';
    const payload=decodeTerminalToken(token);
    if(!payload)return null;
    const accountId=String(payload.accountId||'').trim();
    if(!accountId)return null;
    return {accountId,payload};
  }

  function terminalAccountStorageKey(accountId){
    return 'auraTerminalAccount:'+String(accountId||'').trim();
  }

  function saveTerminalAccount(account){
    try{
      const ctx=terminalAccountContext();
      const accountId=String(account?.accountId||account?.id||ctx?.accountId||'').trim();
      if(!accountId||!account)return;
      sessionStorage.setItem('auraTerminalAccount',JSON.stringify(account));
      localStorage.setItem(terminalAccountStorageKey(accountId),JSON.stringify(account));
      paintTerminalAccountNumber(accountId);
    }catch(e){}
  }

  function getSavedTerminalAccount(){
    try{
      const ctx=terminalAccountContext();
      if(!ctx)return null;
      const raw=localStorage.getItem(terminalAccountStorageKey(ctx.accountId));
      return raw?JSON.parse(raw):null;
    }catch(e){return null;}
  }

  function paintTerminalAccountNumber(accountId){
    if(!accountId)return;
    const paint=()=>{
      const label=document.querySelector('.mobile-terminal .account-label');
      if(!label)return;
      let el=document.getElementById('terminalAccountNumber');
      if(!el){
        el=document.createElement('span');
        el.id='terminalAccountNumber';
        el.style.cssText='display:inline-block;margin-left:7px;padding:2px 6px;border:1px solid #d6b35a;border-radius:6px;color:#8b6b22;font-size:9px;font-weight:900;letter-spacing:.03em;text-transform:none;vertical-align:middle;';
        label.appendChild(el);
      }
      el.textContent='A/C '+accountId;
    };
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',paint,{once:true});else paint();
  }

  function syncTerminalAccountNumber(){
    const ctx=terminalAccountContext();
    if(ctx)paintTerminalAccountNumber(ctx.accountId);
  }

  async function auraAccount(){
    if(typeof ceAuth==='undefined'||!ceAuth.currentUser)return null;
    if(accountPromise)return accountPromise;
    accountPromise=(async()=>{
      let lastError=null;
      for(let attempt=0;attempt<2;attempt++){
        try{
          const user=ceAuth.currentUser;
          const token=await user.getIdToken(false);
          const controller=new AbortController();
          const timeout=setTimeout(()=>controller.abort(),ACCOUNT_TIMEOUT_MS);
          const res=await fetch(AURA_API_BASE+'/api/trading-account',{
            headers:{Authorization:'Bearer '+token},
            cache:'no-store',
            signal:controller.signal
          });
          clearTimeout(timeout);
          let data={};try{data=await res.json()}catch(e){}
          if(!res.ok){
            const err=new Error(data.error||'Account unavailable');
            err.status=res.status;
            throw err;
          }
          return data.account||null;
        }catch(e){
          lastError=e;
          if(String(e.message||'').includes('RESOURCE_EXHAUSTED')||e.status===429)break;
          if(attempt===0)await sleep(1200);
        }
      }
      console.warn('Aura account unavailable:',lastError?.message||lastError);
      return { __error: String(lastError?.message||'Account unavailable') };
    })().finally(()=>{accountPromise=null});
    return accountPromise;
  }

  function auraMoney(v){
    return '$'+Number(v||0).toLocaleString('en-US',{
      minimumFractionDigits:2,
      maximumFractionDigits:2
    });
  }

  function filterByActiveAccount(data){
    const ctx=terminalAccountContext();
    if(!ctx||!data||typeof data!=='object')return data;
    const accountId=String(ctx.accountId);
    const belongsToAccount=(p)=>{
      if(!p||typeof p!=='object')return true;
      const candidate=p.accountId??p.tradingAccountId??p.account?.accountId??p.account?.id;
      return candidate==null||String(candidate)===accountId;
    };
    const out={...data};
    for(const key of ['open','closed','positions','trades','history']){
      if(Array.isArray(data[key]))out[key]=data[key].filter(belongsToAccount);
    }
    return out;
  }

  function positionDailyKey(date){
    if(!(date instanceof Date)||Number.isNaN(date.getTime()))return '';
    const parts=new Intl.DateTimeFormat('en-GB',{
      timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'
    }).formatToParts(date);
    const get=t=>parts.find(x=>x.type===t)?.value||'';
    let y=Number(get('year')),m=Number(get('month')),d=Number(get('day')),h=Number(get('hour'));
    if(h<6){
      const prev=new Date(Date.UTC(y,m-1,d)-86400000);
      y=prev.getUTCFullYear();m=prev.getUTCMonth()+1;d=prev.getUTCDate();
    }
    return y+'-'+String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0');
  }

  function setupPositionDailyPnl(){
    if(!/position\.html$/i.test(window.location.pathname))return;
    const row=document.querySelector('.sub-row');
    const closeAll=document.getElementById('closeAllTrades');
    if(!row||!closeAll)return;
    let summary=document.getElementById('positionDailyPnl');
    if(!summary){
      summary=document.createElement('div');
      summary.id='positionDailyPnl';
      summary.style.cssText='display:none;align-items:center;justify-content:center;min-height:34px;padding:6px 12px;border:1px solid #dfe5e9;border-radius:9px;background:#fff;font-size:12px;font-weight:900;white-space:nowrap;';
      row.appendChild(summary);
    }
    const update=(data)=>{
      const closed=Array.isArray(data?.closed)?data.closed:[];
      const today=positionDailyKey(new Date());
      let total=0;
      for(const trade of closed){
        const when=trade?.closedAt||trade?.closeTime||trade?.closed_at||trade?.updatedAt||trade?.updated_at;
        if(!when||positionDailyKey(new Date(when))!==today)continue;
        total+=Number(trade?.realizedPnl??trade?.pnl??0)||0;
      }
      summary.textContent='Today P&L '+(total>=0?'+':'-')+auraMoney(Math.abs(total));
      summary.style.color=total>0?'#008a5b':total<0?'#e6004d':'#687786';
      summary.style.borderColor=total>0?'#b9ead9':total<0?'#f2bfd0':'#dfe5e9';
    };
    const sync=()=>{
      const closedActive=document.querySelector('.tab[data-tab="closed"]')?.classList.contains('active');
      closeAll.style.display=closedActive?'none':'';
      summary.style.display=closedActive?'inline-flex':'none';
    };
    window.auraUpdateDailyPnl=update;
    window.auraSyncDailyPnl=sync;
    sync();
    const tabs=document.querySelectorAll('.tab');
    tabs.forEach(tab=>tab.addEventListener('click',()=>setTimeout(sync,0)));
    setInterval(sync,500);
  }

  const nativeFetch=window.fetch.bind(window);
  window.fetch=async function(input,init){
    const response=await nativeFetch(input,init);
    try{
      const url=typeof input==='string'?input:(input?.url||'');
      if(!url.includes('/api/trading/history')&&!url.includes('/api/trading/positions'))return response;
      const clone=response.clone();
      const data=await clone.json();
      const filtered=filterByActiveAccount(data);
      if(typeof window.auraUpdateDailyPnl==='function')window.auraUpdateDailyPnl(filtered);
      return new Response(JSON.stringify(filtered),{
        status:response.status,
        statusText:response.statusText,
        headers:response.headers
      });
    }catch(e){
      return response;
    }
  };

  function addDashboardBuyChallengeLink(){
    const path=window.location.pathname.replace(/\/+$/,'');
    if(path!=='/courses' && !path.endsWith('/courses.html'))return;
    const dashboard=document.querySelector('.dashboard');
    const pageTitle=dashboard?.querySelector('.page-title');
    if(!dashboard||!pageTitle||document.getElementById('dashboardBuyChallenge'))return;
    const link=document.createElement('a');
    link.id='dashboardBuyChallenge';
    link.href='challenge.html';
    link.textContent='Buy Challenge';
    link.style.cssText='display:block;width:max-content;margin:0 auto 28px;padding:10px 24px;border:1px solid #d6b35a;border-radius:999px;background:linear-gradient(180deg,#2a220f,#171106);color:#f1d98a;text-decoration:none;font-size:14px;font-weight:800;letter-spacing:.6px;cursor:pointer;';
    link.setAttribute('aria-label','Buy Challenge');
    dashboard.insertBefore(link,pageTitle);
  }

  async function terminalSwitchAccount(accountId){
    const id=String(accountId||'').trim();
    if(!id)return;
    try{
      if(typeof ceAuth==='undefined'||!ceAuth.currentUser)throw new Error('Login required');
      const token=await ceAuth.currentUser.getIdToken(false);
      const mode=(typeof terminalRole!=='undefined'&&terminalRole==='investor')?'investor':'trader';
      const selectRes=await fetch(AURA_API_BASE+'/api/trading-account/select',{
        method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({accountId:id})
      });
      const selectData=await selectRes.json().catch(()=>({}));
      if(!selectRes.ok)throw new Error(selectData.error||'Could not select account');
      const credRes=await fetch(AURA_API_BASE+'/api/trading-credentials',{headers:{Authorization:'Bearer '+token},cache:'no-store'});
      const creds=await credRes.json().catch(()=>({}));
      if(!credRes.ok||!creds.loginId)throw new Error(creds.error||'Terminal credentials unavailable');
      const password=mode==='investor'?creds.investorPassword:creds.tradingPassword;
      const loginRes=await fetch(AURA_API_BASE+'/api/terminal/login',{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({loginId:creds.loginId,password,mode})
      });
      const loginData=await loginRes.json().catch(()=>({}));
      if(!loginRes.ok||!loginData.token)throw new Error(loginData.error||'Could not switch terminal account');
      sessionStorage.setItem('auraTerminalSession',loginData.token);
      sessionStorage.removeItem('auraTerminalAccount');
      window.location.reload();
    }catch(e){
      console.warn('Terminal account switch failed:',e);
      const status=document.getElementById('terminalStatus');
      if(status)status.textContent=e.message||'Could not switch account';
    }
  }

  async function renderTerminalAccountSwitcher(){
    const root=document.querySelector('.mobile-terminal .m-top');
    if(!root||document.getElementById('auraTerminalAccountSwitcher'))return;
    const label=root.querySelector('.account-label');
    if(!label)return;
    const role=label.querySelector('#terminalRoleBadge');
    if(role)role.style.display='none';
    label.textContent='Account Switch';
    label.id='auraTerminalAccountSwitchButton';
    label.setAttribute('role','button');label.setAttribute('aria-haspopup','listbox');label.setAttribute('aria-expanded','false');
    label.style.cssText='display:inline-flex;align-items:center;gap:6px;cursor:pointer;color:#182332;font-size:12px;font-weight:900;letter-spacing:.04em;text-transform:none;position:relative;';
    const chev=document.createElement('span');chev.textContent='▾';chev.style.cssText='font-size:15px;color:#667585;line-height:1;';label.appendChild(chev);
    const menu=document.createElement('div');menu.id='auraTerminalAccountSwitcher';menu.setAttribute('role','listbox');menu.style.cssText='display:none;position:absolute;left:28px;right:28px;top:43px;background:#fff;border:1px solid #dce2e7;border-radius:16px;box-shadow:0 12px 30px #0002;z-index:120;overflow:hidden;';
    const head=document.createElement('div');head.textContent='TRADING ACCOUNTS';head.style.cssText='padding:10px 14px 7px;color:#8a96a2;font-size:10px;font-weight:900;letter-spacing:.08em;border-bottom:1px solid #eef1f4;';menu.appendChild(head);
    const list=document.createElement('div');list.style.cssText='max-height:330px;overflow-y:auto;-webkit-overflow-scrolling:touch;';menu.appendChild(list);root.style.position='relative';root.appendChild(menu);
    label.addEventListener('click',async(e)=>{
      e.stopPropagation();const open=menu.style.display==='block';menu.style.display=open?'none':'block';label.setAttribute('aria-expanded',String(!open));if(open)return;
      list.innerHTML='<div style="padding:16px;color:#7b8793;font-size:12px;font-weight:700">Loading accounts…</div>';
      try{
        const user=ceAuth?.currentUser;if(!user)throw new Error('Login required');
        const token=await user.getIdToken(false);const res=await fetch(AURA_API_BASE+'/api/trading-accounts',{headers:{Authorization:'Bearer '+token},cache:'no-store'});const data=await res.json().catch(()=>({}));
        if(!res.ok)throw new Error(data.error||'Could not load accounts');
        const accounts=Array.isArray(data.accounts)?data.accounts:[];const current=terminalAccountContext()?.accountId||'';list.innerHTML='';
        if(!accounts.length){list.innerHTML='<div style="padding:16px;color:#7b8793;font-size:12px">No purchased accounts found</div>';return;}
        accounts.forEach((a,i)=>{
          const id=String(a.accountId||a.id||'').trim();if(!id)return;const challenge=String(a.challenge||a.name||'Account '+(i+1));const size=Number(a.startingBalance??a.accountSize??a.size??0);const sizeText=size?'$'+size.toLocaleString('en-US'):'Account';
          const item=document.createElement('button');item.type='button';item.setAttribute('role','option');item.setAttribute('aria-selected',String(id===current));item.style.cssText='display:block;width:100%;padding:13px 14px;border:0;border-bottom:1px solid #eef1f4;background:#fff;text-align:left;color:#17212b;cursor:pointer;-webkit-tap-highlight-color:transparent;';if(id===current)item.style.background='#fff8e8';
          const top=document.createElement('strong');top.textContent=id;top.style.cssText='display:block;font-size:13px;font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
          const sub=document.createElement('span');sub.textContent=challenge+' · '+sizeText;sub.style.cssText='display:block;margin-top:4px;color:#7c8995;font-size:11px;font-weight:800;';item.append(top,sub);item.addEventListener('click',()=>terminalSwitchAccount(id));list.appendChild(item);
        });
      }catch(err){list.innerHTML='<div style="padding:16px;color:#e6004d;font-size:12px;font-weight:700">Unable to load accounts</div>';console.warn('Terminal account switcher:',err);}
    });
    document.addEventListener('click',(e)=>{if(menu.style.display==='block'&&!menu.contains(e.target)&&e.target!==label){menu.style.display='none';label.setAttribute('aria-expanded','false');}});
  }

  function fixPositionDashboardLeverage(){
    if(!/position\.html$/i.test(window.location.pathname))return;
    const el=document.getElementById('detailPositionLeverage');
    const cards=[...document.querySelectorAll('.position-card .pos-symbol')];
    if(!el)return;
    const values=new Set(cards.map(node=>{
      const s=(node.textContent||'').trim().toUpperCase();
      if(s.includes('GOLD')||s.includes('XAUUSD'))return '1:50';
      if(s.includes('EURUSD')||s.includes('GBPUSD')||s.includes('AUDUSD')||s.includes('USDJPY')||s.includes('FOREX'))return '1:100';
      if(s.includes('BTC')||s.includes('ETH')||s.includes('SOL')||s.includes('XRP')||s.includes('CRYPTO'))return '1:10';
      return null;
    }).filter(Boolean));
    if(values.size===1)el.textContent=[...values][0];
    else if(values.size>1)el.textContent='Mixed';
  }

  window.auraTerminalAccountContext=terminalAccountContext;
  window.auraTerminalAccountStorageKey=terminalAccountStorageKey;
  window.auraSaveTerminalAccount=saveTerminalAccount;
  window.auraGetSavedTerminalAccount=getSavedTerminalAccount;
  window.auraSyncTerminalAccountNumber=syncTerminalAccountNumber;
  window.auraAccount=auraAccount;
  window.auraMoney=auraMoney;
  window.auraTerminalAccountSwitcher=renderTerminalAccountSwitcher;

  syncTerminalAccountNumber();
  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',()=>{
      addDashboardBuyChallengeLink();
      renderTerminalAccountSwitcher();
      fixPositionDashboardLeverage();
      setupPositionDailyPnl();
      const positions=document.getElementById('positions');
      if(positions)new MutationObserver(fixPositionDashboardLeverage).observe(positions,{childList:true,subtree:true});
    },{once:true});
  }else{
    addDashboardBuyChallengeLink();
    renderTerminalAccountSwitcher();
    fixPositionDashboardLeverage();
    setupPositionDailyPnl();
    const positions=document.getElementById('positions');
    if(positions)new MutationObserver(fixPositionDashboardLeverage).observe(positions,{childList:true,subtree:true});
  }
})();