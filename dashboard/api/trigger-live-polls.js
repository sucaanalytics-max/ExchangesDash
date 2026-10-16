/**
 * Vercel Serverless Function: /api/trigger-live-polls
 *
 * Why this exists: GitHub Actions' native `schedule:` trigger for this repo
 * has been observed to fire the NSE/BSE/MCX live-poller workflows 1-4+ hours
 * late, consistently, across many days (GitHub's status page shows no
 * incident — it's this repo's scheduled runs specifically getting
 * deprioritized under GitHub's best-effort cron scheduler, worse for repos
 * with several frequent cron triggers). Adjusting the cron expressions
 * doesn't fix this; GitHub simply doesn't guarantee timely scheduled runs.
 *
 * An external always-on cron service (e.g. cron-job.org) calls this endpoint
 * every few minutes during market hours instead. This endpoint's only job is
 * to fire `workflow_dispatch` for each live poller via GitHub's REST API —
 * an on-demand trigger, which GitHub runs immediately (dispatch is not
 * subject to the same scheduling delay as `schedule:`).
 *
 * Auth: requires `Authorization: Bearer <CRON_TRIGGER_SECRET>` — a shared
 * secret configured both here (Vercel env var) and in the external cron
 * service's request headers. This is deliberately a SEPARATE, narrowly-
 * scoped credential from GITHUB_READ_PAT (used elsewhere for read-only
 * access) — GITHUB_DISPATCH_PAT should be a fine-grained PAT scoped to only
 * "Actions: write" on this one repo.
 *
 * Outside the market session (Mon–Fri 8:55 AM–4:30 PM IST, matching
 * SESSION_START_MIN/SESSION_END_MIN in scripts/live_common.py) it returns 200
 * with `skipped: true` and dispatches nothing, so a round-the-clock external
 * cron no longer produces night and weekend runs. `?force=1` overrides.
 *
 * Example: POST /api/trigger-live-polls  (Authorization: Bearer <secret>)
 */

const crypto = require('crypto');

const REPO = 'sucaanalytics-max/ExchangesDash';
const GITHUB_API = `https://api.github.com/repos/${REPO}/actions/workflows`;
const WORKFLOWS = ['nse-live.yml', 'bse-live.yml', 'mcx-live.yml'];

const SESSION_START_MIN = 8 * 60 + 55;
const SESSION_END_MIN   = 16 * 60 + 30;

function inMarketSession(now = new Date()) {
  const ist = new Date(now.getTime() + 330 * 60000);   // IST = UTC+5:30, no DST
  const day = ist.getUTCDay();                          // 0 = Sun … 6 = Sat
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return day >= 1 && day <= 5 && mins >= SESSION_START_MIN && mins <= SESSION_END_MIN;
}

function secretMatches(header, secret) {
  const a = Buffer.from(String(header || ''));
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const secret = process.env.CRON_TRIGGER_SECRET;
  if (!secret || !secretMatches(authHeader, secret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!inMarketSession() && req.query.force !== '1') {
    return res.status(200).json({ skipped: true, reason: 'outside market session' });
  }

  const pat = process.env.GITHUB_DISPATCH_PAT;
  if (!pat) {
    return res.status(500).json({ error: 'GITHUB_DISPATCH_PAT env var not set' });
  }

  const results = await Promise.allSettled(
    WORKFLOWS.map(async (wf) => {
      const ghRes = await fetch(`${GITHUB_API}/${wf}/dispatches`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${pat}`,
          'Accept':        'application/vnd.github+json',
          'User-Agent':    'nse-cloud-pipeline-cron-trigger',
        },
        body: JSON.stringify({ ref: 'main' }),
      });
      // GitHub returns 204 No Content on a successful dispatch
      return { workflow: wf, status: ghRes.status, ok: ghRes.ok };
    })
  );

  const summary = results.map((r) =>
    r.status === 'fulfilled' ? r.value : { error: r.reason?.message || String(r.reason) }
  );
  const allOk = summary.every((s) => s.ok);

  return res.status(allOk ? 200 : 502).json({
    triggered_at: new Date().toISOString(),
    results: summary,
  });
};

module.exports.inMarketSession = inMarketSession;
