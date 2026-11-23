// dashboard/js/23-excel-sync.js — Excel sync panel at the foot of the Valuation Model tab.
// index.html loads dashboard/js/*.js in name order as classic scripts sharing one global scope.

// ========================
// EXCEL SYNC — runs of the Excel mirror (scripts/excel_mirror.py), which writes the
// shared inputs, the valuation results and the dashboard's data into the vF files and
// the Exchanges Dashboard workbook, daily at 01:00 IST and on demand.
// ========================
// GET /api/excel-refresh lists the latest runs (public); a team member signed in for
// the shared inputs (VALUATION_SHARED.signedIn, js/14-valuation.js) gets a
// Refresh Excel now button, which POSTs and then polls GET every 10 s until that run
// finishes or 10 minutes pass. /api URLs carry no cache-busting parameter.
//   state: 'idle' (never loaded) | 'loading' | 'ok' | 'off' (503: not configured) | 'error'
//   poll: { id, until, timer } while a run is followed
//   note: a line under the table ({ text, kind }), e.g. why a refresh did not start
const EXCEL_SYNC = { state: 'idle', runs: [], schedule: 'Daily at 01:00 IST', at: 0, loading: null, poll: null, busy: false, note: null };
const EXCEL_SYNC_POLL_MS = 10 * 1000;
const EXCEL_SYNC_POLL_MAX_MS = 10 * 60 * 1000;
const EXCEL_SYNC_SHOWN = 5;
const EXCEL_SYNC_TARGETS = [['nse_vf', 'NSE vF'], ['bse_vf', 'BSE vF'], ['mcx_vf', 'MCX vF'], ['dashboard', 'Dashboard']];
const EXCEL_SYNC_STATUS = {
  success: ['Success', 'ok'], partial: ['Partial', 'warn'], failed: ['Failed', 'bad'],
  queued: ['Queued', ''], running: ['Running…', 'data'],
};
const excelSyncDone = st => st === 'success' || st === 'partial' || st === 'failed';

// "23 Nov, 01:00" in IST; '—' without a time
function excelSyncWhen(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d)) return '—';
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
}

// A vF file's input cells: all written, some not (which), none; '' for the dashboard file
function excelSyncInputsText(f) {
  const cells = f.input_cells && typeof f.input_cells === 'object' ? Object.entries(f.input_cells) : null;
  if (cells && cells.length) {
    const missed = cells.filter(([, ok]) => !ok).map(([k]) => k);
    if (!missed.length) return ' · input cells written';
    if (missed.length < cells.length) return ` · some input cells not written (${missed.join(', ')})`;
    return ' · input cells NOT written';
  }
  return f.inputs_written === true ? ' · input cells written' : f.inputs_written === false ? ' · input cells NOT written' : '';
}

// One file's mark: ✓ written, ! written with an error (e.g. a label check skipped its
// input cells), ✗ failed, – not configured; the error on hover
function excelSyncFileMark(f, label) {
  if (!f) return `<span class="rx-foot" title="${escHtml(label)}: not in this run">${escHtml(label)} –</span>`;
  const [mark, cls] = f.status === 'success' ? ['✓', 'rx-up'] : f.status === 'partial' ? ['!', 'rx-warn'] : f.status === 'skipped' ? ['–', 'rx-foot'] : ['✗', 'rx-dn'];
  const inputs = excelSyncInputsText(f);
  const tip = `${label}: ${f.status}${f.cells ? ` · ${fmtNum(f.cells, 0)} cells` : ''}${inputs}${f.error ? ` · ${f.error}` : ''}`;
  return `<span class="xs-file ${cls}" title="${escHtml(tip)}">${escHtml(label)} ${mark}</span>`;
}

// The panel. s: EXCEL_SYNC; signedIn: may this viewer refresh
function excelSyncPanelHTML(s, signedIn) {
  const following = !!s.poll;
  const right = s.state === 'off' ? ''
    : signedIn ? `<button type="button" class="rx-btn rx-btn--primary" data-xs-refresh${following || s.busy ? ' disabled' : ''}>${following ? 'Refreshing…' : 'Refresh Excel now'}</button>`
    : '<span class="rx-foot">Sign in (Edit inputs) to refresh now</span>';
  let body;
  if (s.state === 'off') body = '<div class="rx-empty"><b>Not configured</b>The Excel mirror is not set up on this deployment.</div>';
  else if (s.state === 'idle' || (s.state === 'loading' && !s.runs.length)) body = '<div class="rx-empty">Loading…</div>';
  else if (s.state === 'error' && !s.runs.length) body = '<div class="rx-empty"><b>Sync status unavailable</b>The run log did not load.</div>';
  else if (!s.runs.length) body = '<div class="rx-empty">No runs yet.</div>';
  else {
    const rows = s.runs.slice(0, EXCEL_SYNC_SHOWN).map(r => {
      const [txt, kind] = EXCEL_SYNC_STATUS[r.status] || [r.status, ''];
      const byTarget = Object.fromEntries((r.files || []).map(f => [f.target, f]));
      const files = (r.files || []).length ? EXCEL_SYNC_TARGETS.map(([k, label]) => excelSyncFileMark(byTarget[k], label)).join(' ')
        : r.error ? `<span class="rx-foot" title="${escHtml(r.error)}">${escHtml(r.error.length > 60 ? `${r.error.slice(0, 59)}…` : r.error)}</span>` : '<span class="rx-foot">—</span>';
      const dry = (r.files || []).some(f => f.dry_run) ? ' <span class="rx-foot">dry run</span>' : '';
      const when = excelSyncWhen(r.finished_at || r.started_at || r.requested_at);
      const link = r.run_url ? ` <a class="rx-link" href="${escHtml(r.run_url)}" target="_blank" rel="noopener noreferrer" title="GitHub Actions log">log ↗</a>` : '';
      return `<tr><td class="rx-l">${when}</td><td class="rx-l">${r.trigger === 'manual' ? 'Manual' : 'Scheduled'}${dry}</td>
        <td class="rx-l">${rxChip(txt, kind)}</td><td class="rx-l xs-files">${files}${link}</td></tr>`;
    }).join('');
    body = `<div class="rx-scroll"><table class="rx-table" aria-label="Latest Excel sync runs">
      <thead><tr><th scope="col" class="rx-l">When (IST)</th><th scope="col" class="rx-l">Run</th><th scope="col" class="rx-l">Status</th><th scope="col" class="rx-l">Files</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }
  const note = s.note ? `<p class="rx-foot xs-note${s.note.kind === 'bad' ? ' rx-dn' : ''}" role="status">${escHtml(s.note.text)}</p>` : '';
  return rxPanel({
    title: 'Excel sync', cls: 'xs-panel',
    meta: `${escHtml(s.schedule)} · inputs and results into the NSE, BSE and MCX vF files, data into the Exchanges Dashboard workbook`,
    right, body: body + note,
    foot: s.state === 'off' ? '' : 'Each run writes the shared inputs as last saved. Hover a file for its error.',
    attrs: 'data-excel-sync',
  });
}

// Redraws every panel on the page (the Valuation tab is rendered per exchange)
function excelSyncRender() {
  if (typeof document === 'undefined') return;
  const signedIn = !!VALUATION_SHARED.signedIn;
  document.querySelectorAll('[data-excel-sync]').forEach(el => { el.outerHTML = excelSyncPanelHTML(EXCEL_SYNC, signedIn); });
}

// Loads the run log; one request at a time. With `maxAgeMs`, a fresh enough log is kept.
function excelSyncLoad(maxAgeMs) {
  const S = EXCEL_SYNC;
  if (S.loading) return S.loading;
  if (maxAgeMs != null && S.state === 'ok' && Date.now() - S.at < maxAgeMs) return Promise.resolve();
  if (S.state === 'idle') S.state = 'loading';
  S.loading = (async () => {
    try {
      const r = await fetch('/api/excel-refresh', { cache: 'no-store', credentials: 'same-origin' });
      if (r.status === 503) { S.state = 'off'; return; }
      const j = await r.json();
      if (!r.ok || !j || !Array.isArray(j.runs)) throw new Error(`HTTP ${r.status}`);
      S.state = 'ok';
      S.runs = j.runs;
      if (j.schedule) S.schedule = j.schedule;
      S.at = Date.now();
    } catch (e) {
      if (S.state !== 'ok') S.state = 'error';
    } finally {
      S.loading = null;
      excelSyncRender();
    }
  })();
  return S.loading;
}

// Follows run `id` until it finishes or EXCEL_SYNC_POLL_MAX_MS pass
function excelSyncFollow(id) {
  const S = EXCEL_SYNC;
  if (S.poll) clearTimeout(S.poll.timer);
  S.poll = { id, until: Date.now() + EXCEL_SYNC_POLL_MAX_MS, timer: null };
  const tick = async () => {
    await excelSyncLoad();
    const p = S.poll;
    if (!p || p.id !== id) return;
    const run = S.runs.find(r => r.id === id);
    if (run && excelSyncDone(run.status)) {
      S.poll = null;
      S.note = { text: run.status === 'success' ? 'Excel files refreshed.' : run.status === 'partial' ? 'Refreshed with errors on some files: hover them for details.' : `The refresh failed${run.error ? `: ${run.error}` : ''}.`, kind: run.status === 'failed' ? 'bad' : '' };
    } else if (Date.now() >= p.until) {
      S.poll = null;
      S.note = { text: 'Still running after 10 minutes: the table updates when you come back to this tab.', kind: '' };
    } else {
      p.timer = setTimeout(tick, EXCEL_SYNC_POLL_MS);
      return;
    }
    excelSyncRender();
  };
  S.poll.timer = setTimeout(tick, EXCEL_SYNC_POLL_MS);
  excelSyncRender();
}

// Refresh Excel now: POST, then follow the run it started (or the one already under way)
async function excelSyncRefresh() {
  const S = EXCEL_SYNC;
  if (S.busy || S.poll) return;
  S.busy = true;
  S.note = null;
  excelSyncRender();
  try {
    const r = await fetch('/api/excel-refresh', { method: 'POST', credentials: 'same-origin' });
    let j = null;
    try { j = await r.json(); } catch (e) { /* no body */ }
    if (r.status === 401) { VALUATION_SHARED.signedIn = false; S.note = { text: 'Signed out: sign in again to refresh.', kind: 'bad' }; valuationSharedNotify(); return; }
    if (r.status === 503) { S.state = 'off'; return; }
    const run = j && j.run;
    if (run) {
      S.runs = [run, ...S.runs.filter(x => x.id !== run.id)];
      if (r.ok && !excelSyncDone(run.status)) {
        S.note = { text: j.dispatched ? 'Refresh started: it usually takes a few minutes.' : 'A run is already under way: following it.', kind: '' };
        excelSyncFollow(run.id);
        return;
      }
    }
    S.note = { text: `The refresh did not start${(j && j.error) ? `: ${j.error}` : ` (HTTP ${r.status})`}.`, kind: 'bad' };
  } catch (e) {
    S.note = { text: 'Could not reach the refresh service.', kind: 'bad' };
  } finally {
    S.busy = false;
    excelSyncRender();
  }
}

// Sign-in or sign-out changes who sees the button
VALUATION_SHARED.listeners.add(() => { if (EXCEL_SYNC.state !== 'idle') excelSyncRender(); });
