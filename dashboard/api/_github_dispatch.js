/**
 * GitHub workflow_dispatch for this repo's workflows, shared by the endpoints
 * that start them: trigger-live-polls.js, trigger-scheduled.js and
 * excel-refresh.js. Vercel does not route files whose name starts with "_",
 * so this is not an endpoint.
 *
 * The token is GITHUB_DISPATCH_PAT: a fine-grained PAT with only
 * "Actions: write" on this repo. GitHub answers 204 No Content on success.
 * A call not answered within DISPATCH_TIMEOUT_MS is aborted and reported as failed
 * (status null), so a caller answers before Vercel's own limit.
 */

const REPO = 'sucaanalytics-max/ExchangesDash';
const GITHUB_API = `https://api.github.com/repos/${REPO}/actions/workflows`;
const DISPATCH_TIMEOUT_MS = 8000;
// A run-status read comes before a dispatch in the same request, so it gets less
const RUN_READ_TIMEOUT_MS = 2000;

// Dispatches `workflow` (a file name in .github/workflows) on main, with `inputs`
// when given. Never rejects: resolves to { workflow, status, ok, detail }, where
// detail is GitHub's answer (refused) or the network error, cut to 300 characters.
// timeoutMs: a caller that already spent part of its budget passes what is left.
async function dispatchWorkflow(pat, workflow, inputs, userAgent = 'exchangesdash-dispatch', timeoutMs = DISPATCH_TIMEOUT_MS) {
  let status = null, detail = '';
  try {
    const ghRes = await fetch(`${GITHUB_API}/${workflow}/dispatches`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
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
    detail = (err && err.name === 'TimeoutError' ? `no answer in ${Math.round(timeoutMs / 100) / 10} s` : String((err && err.message) || err)).slice(0, 300);
  }
  return { workflow, status, ok: status >= 200 && status < 300, detail };
}

// Whether a workflow run has ended (GitHub status "completed": success, failure,
// cancelled …): true / false, or null when GitHub does not answer within
// RUN_READ_TIMEOUT_MS or refuses (the token needs Actions: read, which Actions: write
// includes). Never rejects.
async function workflowRunEnded(pat, runId, userAgent = 'exchangesdash-dispatch') {
  if (!/^\d+$/.test(String(runId))) return null;
  try {
    const ghRes = await fetch(`https://api.github.com/repos/${REPO}/actions/runs/${runId}`, {
      signal: AbortSignal.timeout(RUN_READ_TIMEOUT_MS),
      headers: { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/vnd.github+json', 'User-Agent': userAgent },
    });
    if (!ghRes.ok) return null;
    const run = await ghRes.json();
    return run && typeof run.status === 'string' ? run.status === 'completed' : null;
  } catch (err) {
    return null;
  }
}

module.exports = { REPO, GITHUB_API, DISPATCH_TIMEOUT_MS, RUN_READ_TIMEOUT_MS, dispatchWorkflow, workflowRunEnded };
