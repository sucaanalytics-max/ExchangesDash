"""dashboard/api/trigger-live-polls.js in Node with a stubbed GitHub API: who may
call it (Vercel Cron's CRON_SECRET or the external CRON_TRIGGER_SECRET), the
market-session window, the vercel.json cron that calls it, and the poller
workflows it dispatches."""

import json
import subprocess
import unittest

from helpers import NODE, ROOT

HANDLER = ROOT / "dashboard" / "api" / "trigger-live-polls.js"
WORKFLOWS = ["nse-live.yml", "bse-live.yml", "mcx-live.yml"]

# Calls the handler once with the given env, Authorization header and query;
# prints {status, body, dispatched} where dispatched lists the workflow files
# whose dispatch endpoint was hit.
RUNNER = r"""
const [handlerPath, cfg] = [process.argv[1], JSON.parse(process.argv[2])];
for (const k of ['CRON_SECRET', 'CRON_TRIGGER_SECRET', 'GITHUB_DISPATCH_PAT']) delete process.env[k];
Object.assign(process.env, cfg.env);
const dispatched = [];
global.fetch = async (url, opts) => {
  dispatched.push(url.split('/workflows/')[1].split('/')[0]);
  return { status: 204, ok: true };
};
console.log = () => {};
const handler = require(handlerPath);
const req = { headers: { authorization: cfg.auth, 'user-agent': cfg.ua || 'curl' }, query: cfg.query || {} };
const res = {
  status(code) { this.code = code; return this; },
  json(body) { process.stdout.write(JSON.stringify({ status: this.code, body, dispatched })); },
};
handler(req, res);
"""

SESSION = r"""
const { inMarketSession } = require(process.argv[1]);
const at = s => inMarketSession(new Date(s));
process.stdout.write(JSON.stringify([
  at('2026-10-19T03:24:00Z'), at('2026-10-19T03:25:00Z'),   // Mon 08:54 / 08:55 IST
  at('2026-10-19T11:00:00Z'), at('2026-10-19T11:01:00Z'),   // Mon 16:30 / 16:31 IST
  at('2026-10-17T06:00:00Z'), at('2026-10-18T06:00:00Z'),   // Sat / Sun 11:30 IST
]));
"""


@unittest.skipUnless(NODE, "needs node")
class TriggerLivePolls(unittest.TestCase):
    ENV = {"CRON_SECRET": "vercel-cron-secret", "CRON_TRIGGER_SECRET": "external-secret",
           "GITHUB_DISPATCH_PAT": "pat"}

    def call(self, auth, env=None, query=None, ua=None):
        cfg = {"env": self.ENV if env is None else env, "auth": auth, "query": query or {"force": "1"}, "ua": ua}
        out = subprocess.run([NODE, "-e", RUNNER, str(HANDLER), json.dumps(cfg)],
                             capture_output=True, text=True, check=True).stdout
        return json.loads(out)

    def test_vercel_cron_secret_dispatches_all_pollers(self):
        r = self.call("Bearer vercel-cron-secret", ua="vercel-cron/1.0")
        self.assertEqual(r["status"], 200)
        self.assertEqual(r["dispatched"], ["nse-live.yml", "bse-live.yml", "mcx-live.yml"])

    def test_external_secret_still_accepted(self):
        self.assertEqual(self.call("Bearer external-secret")["status"], 200)

    def test_either_secret_alone_is_enough(self):
        self.assertEqual(self.call("Bearer vercel-cron-secret",
                                   env={"CRON_SECRET": "vercel-cron-secret", "GITHUB_DISPATCH_PAT": "pat"})["status"], 200)
        self.assertEqual(self.call("Bearer external-secret",
                                   env={"CRON_TRIGGER_SECRET": "external-secret", "GITHUB_DISPATCH_PAT": "pat"})["status"], 200)

    def test_rejects_wrong_or_missing_secret(self):
        for auth in ("Bearer wrong", "", "vercel-cron-secret", "Bearer "):
            r = self.call(auth)
            self.assertEqual(r["status"], 401, auth)
            self.assertEqual(r["dispatched"], [])

    def test_fails_closed_without_any_secret_configured(self):
        r = self.call("Bearer ", env={"GITHUB_DISPATCH_PAT": "pat"})
        self.assertEqual(r["status"], 401)
        self.assertEqual(r["dispatched"], [])

    def test_market_session_window(self):
        out = subprocess.run([NODE, "-e", SESSION, str(HANDLER)], capture_output=True, text=True, check=True).stdout
        self.assertEqual(json.loads(out), [False, True, True, False, False, False])

    def test_vercel_cron_covers_the_session(self):
        """The cron must fire every 5 minutes, Mon–Fri, across 03:25–11:00 UTC."""
        crons = json.loads((ROOT / "dashboard" / "vercel.json").read_text())["crons"]
        cron = [c for c in crons if c["path"] == "/api/trigger-live-polls"]
        self.assertEqual(len(cron), 1)
        minute, hour, dom, month, dow = cron[0]["schedule"].split()
        self.assertEqual((minute, dom, month, dow), ("*/5", "*", "*", "1-5"))
        lo, hi = map(int, hour.split("-"))
        self.assertLessEqual(lo, 3)
        self.assertGreaterEqual(hi, 11)


class LivePollerWorkflows(unittest.TestCase):
    """Dispatched and late scheduled runs of one poller queue behind each other;
    each must start from main as it is then, or it rebases onto the previous
    run's write to the same JSON and conflicts (MCX, 20 Oct 08:25 UTC)."""

    def test_one_run_at_a_time_from_the_current_main(self):
        for wf in WORKFLOWS:
            text = (ROOT / ".github" / "workflows" / wf).read_text()
            with self.subTest(wf=wf):
                self.assertIn("group: ${{ github.workflow }}", text)
                self.assertIn("cancel-in-progress: false", text)
                checkout = text[text.index("uses: actions/checkout@"):].split("- name:")[0]
                self.assertRegex(checkout, r"\n\s+ref: main\s*\n")


if __name__ == "__main__":
    unittest.main()
