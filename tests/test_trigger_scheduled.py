"""dashboard/api/trigger-scheduled.js in Node with a stubbed GitHub API. Covered:
who may call it, which workflow each Vercel Cron slot dispatches and with what
inputs, and that the slots in vercel.json, the function and the two workflows'
own `schedule:` crons stay the same. Also checks that a dispatched slot run of
the daily update is treated like the scheduled run, not like a manual run."""

import json
import re
import subprocess
import unittest

from helpers import NODE, ROOT

HANDLER = ROOT / "dashboard" / "api" / "trigger-scheduled.js"
WORKFLOWS = ROOT / ".github" / "workflows"
PATH = "/api/trigger-scheduled"

# Calls the handler once; prints {status, body, calls} where calls lists each
# GitHub request as {workflow, ref, inputs}.
RUNNER = r"""
const [handlerPath, cfg] = [process.argv[1], JSON.parse(process.argv[2])];
for (const k of ['CRON_SECRET', 'CRON_TRIGGER_SECRET', 'GITHUB_DISPATCH_PAT']) delete process.env[k];
Object.assign(process.env, cfg.env);
const calls = [];
global.fetch = async (url, opts) => {
  calls.push({ workflow: url.split('/workflows/')[1].split('/')[0], ...JSON.parse(opts.body) });
  const status = cfg.ghStatus || 204;
  return { status, ok: status < 300, text: async () => 'GitHub said no' };
};
console.log = () => {};
const handler = require(handlerPath);
const headers = { authorization: cfg.auth, 'user-agent': cfg.ua || 'curl' };
if (cfg.schedule) headers['x-vercel-cron-schedule'] = cfg.schedule;
const res = {
  status(code) { this.code = code; return this; },
  json(body) { process.stdout.write(JSON.stringify({ status: this.code, body, calls })); },
};
handler({ headers, query: cfg.query || {} }, res);
"""

SLOTS = r"""
process.stdout.write(JSON.stringify(require(process.argv[1]).SLOTS));
"""


def workflow_crons(name):
    """The `- cron:` entries of a workflow's `schedule:` (CI has no YAML parser installed)."""
    return set(re.findall(r"^\s*- cron: '([^']+)'", (WORKFLOWS / name).read_text(), re.M))


def job_block(text, job):
    """The lines of one top-level job, up to the next job."""
    m = re.search(rf"^  {job}:\n(.*?)(?=^  [\w-]+:\n|\Z)", text, re.M | re.S)
    return m.group(1)


@unittest.skipUnless(NODE, "needs node")
class TriggerScheduled(unittest.TestCase):
    ENV = {"CRON_SECRET": "vercel-cron-secret", "CRON_TRIGGER_SECRET": "external-secret",
           "GITHUB_DISPATCH_PAT": "pat"}

    def call(self, auth="Bearer vercel-cron-secret", schedule=None, query=None, env=None, gh_status=None):
        cfg = {"env": self.ENV if env is None else env, "auth": auth, "schedule": schedule,
               "query": query or {}, "ua": "vercel-cron/1.0" if schedule else "curl", "ghStatus": gh_status}
        out = subprocess.run([NODE, "-e", RUNNER, str(HANDLER), json.dumps(cfg)],
                             capture_output=True, text=True, check=True).stdout
        return json.loads(out)

    @classmethod
    def slots(cls):
        out = subprocess.run([NODE, "-e", SLOTS, str(HANDLER)], capture_output=True, text=True, check=True).stdout
        return json.loads(out)

    def test_each_exchange_slot_dispatches_the_daily_update_with_its_slot(self):
        for cron in ("30 0 * * 1-5", "30 12 * * 1-5", "30 15 * * 1-5"):
            with self.subTest(cron=cron):
                r = self.call(schedule=cron)
                self.assertEqual(r["status"], 200)
                self.assertEqual(r["calls"], [{"workflow": "exchange-update.yml", "ref": "main",
                                               "inputs": {"exchange": "all", "cron": cron}}])

    def test_mirror_slots_dispatch_a_copy(self):
        for cron in ("2 15 * * 1-5", "32 23 * * 1-5"):
            with self.subTest(cron=cron):
                r = self.call(schedule=cron)
                self.assertEqual(r["status"], 200)
                self.assertEqual(r["calls"], [{"workflow": "brokers-mirror.yml", "ref": "main",
                                               "inputs": {"mode": "mirror"}}])

    def test_job_parameter_picks_a_slot_without_the_vercel_header(self):
        r = self.call("Bearer external-secret", query={"job": "exchange-update-1530"})
        self.assertEqual(r["status"], 200)
        self.assertEqual(r["calls"][0]["inputs"], {"exchange": "all", "cron": "30 15 * * 1-5"})

    def test_unknown_slot_dispatches_nothing(self):
        for kw in ({"schedule": "0 9 * * *"}, {"query": {"job": "nope"}}, {}):
            with self.subTest(**{k: str(v) for k, v in kw.items()}):
                r = self.call(**kw)
                self.assertEqual(r["status"], 400)
                self.assertEqual(r["calls"], [])

    def test_rejects_wrong_or_missing_secret(self):
        for auth in ("Bearer wrong", "", "vercel-cron-secret", "Bearer "):
            with self.subTest(auth=auth):
                r = self.call(auth, schedule="30 15 * * 1-5")
                self.assertEqual(r["status"], 401)
                self.assertEqual(r["calls"], [])

    def test_fails_closed_without_any_secret_configured(self):
        r = self.call("Bearer ", schedule="30 15 * * 1-5", env={"GITHUB_DISPATCH_PAT": "pat"})
        self.assertEqual(r["status"], 401)
        self.assertEqual(r["calls"], [])

    def test_a_refused_dispatch_is_reported(self):
        r = self.call(schedule="30 15 * * 1-5", gh_status=422)
        self.assertEqual(r["status"], 502)
        self.assertEqual(r["body"]["status"], 422)
        self.assertIn("GitHub said no", r["body"]["detail"])

    def test_vercel_crons_match_the_slots(self):
        crons = json.loads((ROOT / "dashboard" / "vercel.json").read_text())["crons"]
        scheduled = [c["schedule"] for c in crons if c["path"] == PATH]
        self.assertEqual(len(scheduled), len(set(scheduled)))
        self.assertEqual(set(scheduled), set(self.slots()))

    def test_workflow_fallback_schedules_match_the_slots(self):
        slots = self.slots()
        for workflow in ("exchange-update.yml", "brokers-mirror.yml"):
            with self.subTest(workflow=workflow):
                mine = {k for k, s in slots.items() if s["workflow"] == workflow}
                self.assertEqual(workflow_crons(workflow), mine)


class DailyUpdateSlotRuns(unittest.TestCase):
    """A run Vercel Cron dispatches for a slot (inputs.cron set) must behave like
    the scheduled run it stands in for: only a manual dispatch (no slot) always
    publishes, runs the share analyses and deploys."""

    def setUp(self):
        self.text = (WORKFLOWS / "exchange-update.yml").read_text()

    def test_declares_the_cron_input(self):
        dispatch = self.text[self.text.index("  workflow_dispatch:"):self.text.index("\npermissions:")]
        self.assertRegex(dispatch, r"\n      cron:\n(        .*\n)*?        default: ''\n")
        self.assertRegex(dispatch, r"\n      exchange:\n(        .*\n)*?        default: 'all'\n")

    def test_every_manual_branch_excludes_slot_runs(self):
        manual = "(github.event_name == 'workflow_dispatch' && inputs.cron == '')"
        bare = self.text.replace(manual, "")
        self.assertNotIn("event_name == 'workflow_dispatch'", bare)
        # MCX commit, Excel sync, three share analyses, deploy (NSE/BSE commit whatever changed)
        self.assertEqual(self.text.count(manual), 6)

    def test_the_1530_slot_deploys_whichever_way_it_ran(self):
        cond = re.search(r"^    if: (.*)$", job_block(self.text, "deploy"), re.M).group(1)
        self.assertIn("github.event.schedule == '30 15 * * 1-5'", cond)
        self.assertIn("inputs.cron == '30 15 * * 1-5'", cond)

    def test_slot_reaches_shell_only_through_env(self):
        for line in self.text.splitlines():
            if "inputs.cron" in line and "${{" in line:
                stripped = line.strip()
                with self.subTest(line=stripped):
                    self.assertTrue(stripped.startswith(("if:", "SLOT:")), stripped)


if __name__ == "__main__":
    unittest.main()
