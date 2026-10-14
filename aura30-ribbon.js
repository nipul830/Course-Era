(function () {
  function addAura30Ribbon() {
    if (document.getElementById('aura30PromoRibbon')) return;
    var header = document.querySelector('header.nav');
    if (!header) return;
    var ribbon = document.createElement('aside');
    ribbon.id = 'aura30PromoRibbon';
    ribbon.setAttribute('aria-label', 'AURA30 coupon promotion');
    ribbon.innerHTML = '<div class="aura30-ribbon-track"><span>🎁 Use AURA30 — Get 30% OFF</span><span aria-hidden="true">🎁 Use AURA30 — Get 30% OFF</span><span aria-hidden="true">🎁 Use AURA30 — Get 30% OFF</span><span aria-hidden="true">🎁 Use AURA30 — Get 30% OFF</span></div>';
    var style = document.createElement('style');
    style.textContent = '#aura30PromoRibbon{position:relative;z-index:5;overflow:hidden;width:100%;margin:0;padding:10px 0;border-top:1px solid rgba(214,179,90,.55);border-bottom:1px solid rgba(214,179,90,.55);background:linear-gradient(90deg,#100d04,#241905,#100d04);color:#f4d16c;font:800 14px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;letter-spacing:.2px}#aura30PromoRibbon .aura30-ribbon-track{display:flex;width:max-content;animation:aura30RibbonMove 24s linear infinite}#aura30PromoRibbon span{display:block;white-space:nowrap;padding:0 24px}#aura30PromoRibbon:hover .aura30-ribbon-track{animation-play-state:paused}@keyframes aura30RibbonMove{from{transform:translateX(0)}to{transform:translateX(-50%)}}@media(prefers-reduced-motion:reduce){#aura30PromoRibbon .aura30-ribbon-track{animation:none;justify-content:center;flex-wrap:wrap;width:100%}#aura30PromoRibbon span:nth-child(n+2){display:none}}';
    document.head.appendChild(style);
    header.insertAdjacentElement('afterend', ribbon);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addAura30Ribbon, { once: true });
  else addAura30Ribbon();
})();
