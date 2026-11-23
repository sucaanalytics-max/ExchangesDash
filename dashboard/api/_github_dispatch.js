/**
 * GitHub workflow_dispatch for this repo's workflows, shared by the endpoints
 * that start them: trigger-live-polls.js, trigger-scheduled.js and
 * excel-refresh.js. Vercel does not route files whose name starts with "_",
 * so this is not an endpoint.
 *
 * The token is GITHUB_DISPATCH_PAT: a fine-grained PAT with only
 * "Actions: write" on this repo. GitHub answers 204 No Content on success.
 */

const REPO = 'sucaanalytics-max/ExchangesDash';
const GITHUB_API = `https://api.github.com/repos/${REPO}/actions/workflows`;

// Dispatches `workflow` (a file name in .github/workflows) on main, with `inputs`
// when given. Never rejects: resolves to { workflow, status, ok, detail }, where
// detail is GitHub's answer (refused) or the network error, cut to 300 characters.
async function dispatchWorkflow(pat, workflow, inputs, userAgent = 'exchangesdash-dispatch') {
  let status = null, detail = '';
  try {
    const ghRes = await fetch(`${GITHUB_API}/${workflow}/dispatches`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Accept':        'application/vnd.github+json',
        'User-Agent':    userAgent,
      },
      body: JSON.stringify(inputs ? { ref: 'main', inputs } : { ref: 'main' }),
    });
    status = ghRes.status;
    if (!ghRes.ok) detail = String(await ghRes.text().catch(() => '')).slice(0, 300);
  } catch (err) {
    detail = String((err && err.message) || err).slice(0, 300);
  }
  return { workflow, status, ok: status >= 200 && status < 300, detail };
}

module.exports = { REPO, GITHUB_API, dispatchWorkflow };
