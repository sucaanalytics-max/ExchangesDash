/**
 * Vercel Serverless Function: /api/live
 *
 * Proxies the live JSON the pollers commit to GitHub, so the dashboard sees
 * each 5-minute poll without waiting for a Vercel deploy (live-only commits
 * are not deployed — see dashboard/vercel-ignore-build.sh). GITHUB_READ_PAT is
 * optional: it is only needed while the repo is private.
 *
 * Query params:
 *   exchange = nse | bse | mcx   (mcx has only `live`)
 *   file     = live | hourly | history | share
 *
 * Example: GET /api/live?exchange=nse&file=live
 */

const REPO_RAW = 'https://raw.githubusercontent.com/sucaanalytics-max/ExchangesDash/main/dashboard/data';

const VALID_EXCHANGES = ['nse', 'bse', 'mcx'];

const FILE_MAP = {
  live:    (e) => `${e}_live.json`,
  hourly:  (e) => `${e}_live_hourly.json`,
  history: (e) => `${e}_hourly_history.json`,
  share:   ()  => 'bse_share_analysis.json',
};

module.exports = async function handler(req, res) {
  const exchange = (req.query.exchange || 'nse').toLowerCase();
  const file     = (req.query.file     || 'live').toLowerCase();

  if (!VALID_EXCHANGES.includes(exchange) || !FILE_MAP[file]) {
    return res.status(400).json({ error: 'Invalid exchange or file param' });
  }

  const filename = FILE_MAP[file](exchange);
  const url      = `${REPO_RAW}/${filename}`;

  const headers = {
    'Accept':     'application/json',
    'User-Agent': 'nse-cloud-pipeline-dashboard',
  };
  const pat = process.env.GITHUB_READ_PAT;
  if (pat) headers['Authorization'] = `token ${pat}`;

  try {
    const ghRes = await fetch(url, { headers });

    if (!ghRes.ok) {
      return res.status(502).json({ error: `GitHub returned ${ghRes.status} for ${filename}` });
    }

    const data = await ghRes.json();

    // Browser + edge cache for 30 s; fresh within one polling interval
    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=30, stale-while-revalidate=60');
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json(data);

  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
};
