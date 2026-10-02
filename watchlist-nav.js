(() => {
  function applyWatchlistNav() {
    const nav = document.querySelector('.bottom-nav');
    if (!nav) return false;
    const links = nav.querySelectorAll('a');
    if (!links.length) return false;

    const watch = links[0];
    watch.href = 'terminal-home.html';
    watch.classList.remove('active');
    watch.innerHTML = '<span class="bn-icon" aria-hidden="true">☷</span><span class="bn-label">Watchlist</span>';
    return true;
  }

  if (applyWatchlistNav()) return;
  const observer = new MutationObserver(() => {
    if (applyWatchlistNav()) observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
