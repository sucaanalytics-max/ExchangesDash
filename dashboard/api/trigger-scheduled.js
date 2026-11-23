/**
 * Vercel Serverless Function: /api/trigger-scheduled
 *
 * Starts the daily GitHub Actions jobs on time. GitHub runs this repo's
 * `schedule:` triggers hours late: on 2–3 Nov 2026, Exchange Daily Update's
 * 00:30 / 12:30 / 15:30 UTC slots started 6–9 hours late, and Brokers Mirror's
 * 15:02 slot at 20:52. That's the same delay trigger-live-polls.js works around
 * for the live pollers.
 *
 * Vercel Cron calls this endpoint once per slot (`crons` in vercel.json, all
 * with this path; Vercel runs crons on the production deployment only). The
 * x-vercel-cron-schedule header says which slot fired. The function then fires
 * `workflow_dispatch` for that slot's workflow, which GitHub starts at once.
 *
 * - exchange-update.yml gets the slot as its `cron` input. A dispatched run
 *   then behaves like the scheduled run it replaces, not like a manual run:
 *   share analyses only on new days, and the deploy marker only after the
 *   15:30 and 19:15 slots. The 01:45 UTC slot (07:15 IST, Tue–Sat) runs MCX
 *   only: it publishes the previous session's total_contracts, which
 *   mcx-vercel writes to mcx_commodity_daily at about 06:30–07:00 IST, after
 *   the 00:30 slot. The 19:15 UTC slot (00:45 IST, Tue–Sat) runs MTF only and
 *   deploys: NSE posts a day's margin trading file at 18:26–18:27 UTC on the
 *   next trading day, after the 15:30 slot.
 * - brokers-mirror.yml copies at 15:02 and again at 23:32 UTC. The brokers
 *   engine's own "14:17 UTC" job hits the same GitHub delay, and has published
 *   as late as 22:49 UTC.
 * - excel-mirror.yml writes the workbooks daily at 19:30 UTC (01:00 IST), with
 *   `trigger: scheduled`; a repeat run rewrites the same values.
 *
 * Each workflow keeps its own `schedule:` as a late fallback. A repeat run of
 * a slot is harmless: the pipelines find no new days and commit nothing, and
 * the mirror copy is an idempotent upsert.
 *
 * Auth: as in trigger-live-polls.js. The caller must send
 * `Authorization: Bearer <secret>`, with CRON_SECRET (sent by Vercel Cron) or
 * CRON_TRIGGER_SECRET (an external cron, or a manual call). The dispatch itself
 * uses GITHUB_DISPATCH_PAT (Actions: write on this repo). Without the Vercel
 * header, `?job=<name>` picks the slot, e.g. `?job=exchange-update-1530`.
 */

const { secretMatches } = require('./trigger-live-polls');
const { dispatchWorkflow } = require('./_github_dispatch');

// One entry per Vercel Cron schedule for this path in vercel.json, keyed by
// that schedule (UTC). Each key equals a `schedule:` cron of its workflow
// (exchange-update, brokers-mirror, excel-mirror); tests/test_trigger_scheduled.py
// checks that the lists match.
const EXCHANGE = (cron, job, exchange = 'all') => ({ job, workflow: 'exchange-update.yml', inputs: { exchange, cron } });
const MIRROR = (job) => ({ job, workflow: 'brokers-mirror.yml', inputs: { mode: 'mirror' } });
const EXCEL = (job) => ({ job, workflow: 'excel-mirror.yml', inputs: { trigger: 'scheduled' } });
const SLOTS = {
  '30 0 * * 1-5':  EXCHANGE('30 0 * * 1-5', 'exchange-update-0030'),
  '45 1 * * 2-6':  EXCHANGE('45 1 * * 2-6', 'exchange-update-0145-mcx', 'mcx'),
  '30 12 * * 1-5': EXCHANGE('30 12 * * 1-5', 'exchange-update-1230'),
  '30 15 * * 1-5': EXCHANGE('30 15 * * 1-5', 'exchange-update-1530'),
  '15 19 * * 1-5': EXCHANGE('15 19 * * 1-5', 'exchange-update-1915-mtf', 'mtf'),
  '2 15 * * 1-5':  MIRROR('brokers-mirror-1502'),
  '32 23 * * 1-5': MIRROR('brokers-mirror-2332'),
  '30 19 * * *':   EXCEL('excel-mirror-0100'),
};

function slotFor(req) {
  const schedule = req.headers['x-vercel-cron-schedule'];
  if (schedule) return SLOTS[schedule] || null;
  const job = (req.query || {}).job;
  return Object.values(SLOTS).find((s) => s.job === job) || null;
}

module.exports = async function handler(req, res) {
  const secrets = [process.env.CRON_SECRET, process.env.CRON_TRIGGER_SECRET].filter(Boolean);
  // Every call is logged, so Vercel's runtime logs show whether the crons arrive
  const caller = /vercel-cron/.test(req.headers['user-agent'] || '') ? 'vercel-cron' : 'external';
  if (!secrets.some((secret) => secretMatches(req.headers.authorization, secret))) {
    console.log(`trigger-scheduled: 401 from ${caller}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const slot = slotFor(req);
  if (!slot) {
    console.log(`trigger-scheduled: ${caller}, unknown slot ${req.headers['x-vercel-cron-schedule'] || (req.query || {}).job}`);
    return res.status(400).json({ error: 'Unknown slot', jobs: Object.values(SLOTS).map((s) => s.job) });
  }

  const pat = process.env.GITHUB_DISPATCH_PAT;
  if (!pat) {
    return res.status(500).json({ error: 'GITHUB_DISPATCH_PAT env var not set' });
  }

  const { status, ok, detail } = await dispatchWorkflow(pat, slot.workflow, slot.inputs, 'exchangesdash-cron-trigger');
  console.log(`trigger-scheduled: ${caller}, ${slot.job} -> ${slot.workflow} ${status || 'error'}${detail ? ` ${detail}` : ''}`);

  return res.status(ok ? 200 : 502).json({
    triggered_at: new Date().toISOString(),
    job: slot.job,
    workflow: slot.workflow,
    inputs: slot.inputs,
    status: status || null,
    ...(detail ? { detail } : {}),
  });
};

module.exports.SLOTS = SLOTS;
