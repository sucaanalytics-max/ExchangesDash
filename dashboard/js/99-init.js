// dashboard/js/99-init.js — Start-up: startDashboard() runs init() last, once every other file has loaded.
// index.html loads dashboard/js/*.js in name order as classic scripts sharing one global scope.

// ========================
// INIT
// ========================

async function init() {
  showLoading('nse');
  initExchangeSwitcher();
  initFeeToggle();
  updateHeaderExchange('nse');
  buildSidebarNav('nse');
  toggleExchangeContent('nse');
  if (GLANCE_MEDIA.matches && glancePref() !== 'full') enterGlance(false);
  if (GLANCE_MEDIA.addEventListener) GLANCE_MEDIA.addEventListener('change', m => { if (!m.matches) exitGlance(false); });
  setInterval(() => { if (glanceActive() && !document.hidden) renderGlance(); }, 5 * 60 * 1000);
  preloadMarketData().then(() => {
    if ((currentExchange === 'all' || currentExchange === 'nsebse') && shownExchange === currentExchange) rebuildAll();
  });
  // Loads NSE and opens its first tab; a failure shows the overlay's Retry
  await switchExchange('nse');
  updateLatestRevBanner();
  setInterval(() => { if (bannerDue(false)) updateLatestRevBanner(); }, 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (bannerDue(true)) updateLatestRevBanner(); });
}

// The banner refreshes every 5 min while the tab is visible in market hours
// (Mon–Fri 08:50–16:40 IST) and every 30 min otherwise, so an open tab still
// drops its LIVE tag once the day changes. A tab coming back into view
// catches up if its banner is more than 5 min old; a hidden tab never polls.
function bannerDue(returning) {
  if (document.hidden) return false;
  const now = new Date(Date.now() + 330 * 60000);   // IST wall clock as UTC fields
  const day = now.getUTCDay(), mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const open = day >= 1 && day <= 5 && mins >= 530 && mins <= 1000;
  return Date.now() - BANNER_AT >= (returning || open ? 5 : 30) * 60 * 1000;
}

// Starts the dashboard only when Chart.js and every dashboard script loaded and
// ran (SCRIPT_LOAD_ERRORS, 00-core.js). Otherwise the loading overlay names what
// failed and offers a reload, as a single-file app would have failed as a whole.
function startDashboard() {
  const failed = typeof SCRIPT_LOAD_ERRORS === 'undefined' ? ['00-core.js'] : SCRIPT_LOAD_ERRORS.slice();
  if (typeof recordScriptLoadError === 'function') window.removeEventListener('error', recordScriptLoadError, true);
  if (typeof Chart === 'undefined') failed.unshift('Chart.js');
  if (!failed.length) { init(); return; }
  console.error('Dashboard not started; failed to load:', failed);
  document.getElementById('loadingText').textContent =
    `Part of the dashboard failed to load (${failed.join('; ')}). Reload the page; if this persists, a deploy may be in progress.`;
  const actions = document.getElementById('loadingActions');
  actions.innerHTML = '<button type="button" class="loading-btn loading-btn--primary">Reload</button>';
  actions.hidden = false;
  actions.firstChild.onclick = () => location.reload();
  document.getElementById('loadingOverlay').classList.add('visible', 'is-error');
}

startDashboard();
