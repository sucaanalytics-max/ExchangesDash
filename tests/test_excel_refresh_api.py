"""dashboard/api/excel-refresh.js in Node against a stubbed Supabase and GitHub:
the Refresh Excel button's endpoint. POST (signed in) records a queued manual run
and dispatches the excel-mirror workflow with its id; GET lists the latest runs."""

import json
import subprocess
import unittest

from helpers import DASHBOARD, NODE

API = DASHBOARD / "api"
ENV = {"TEAM_PASSWORD": "open sesame", "TEAM_SESSION_SECRET": "s" * 32, "SUPABASE_URL": "https://example.supabase.co",
       "SUPABASE_SERVICE_KEY": "service-key", "GITHUB_DISPATCH_PAT": "pat"}

# One handler call per step against in-memory excel_sync_runs; GitHub answers a
# dispatch with cfg.ghStatus (204 by default) or throws when cfg.ghThrow, and a run
# read (GET /actions/runs/{id}) with cfg.ghRuns[id] ({status}; 404 when absent, throws
# when cfg.ghRunThrow). Prints {out: [{status, body, headers}], rows, dispatches,
# ghReads: [run id], sb: [{method, path, query}]}.
RUNNER = r"""
const [dir, cfg] = [process.argv[1], JSON.parse(process.argv[2])];
for (const k of ['TEAM_PASSWORD', 'TEAM_SESSION_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'GITHUB_DISPATCH_PAT']) delete process.env[k];
Object.assign(process.env, cfg.env || {});
const auth = require(dir + '/_team_auth.js');
const rows = cfg.rows || [];
const dispatches = [], sbCalls = [], ghReads = [];
const reply = (status, body) => {
  const text = body === undefined ? '' : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
};
let nextId = 500;
global.fetch = async (url, opts = {}) => {
  const u = new URL(url), method = opts.method || 'GET';
  if (u.hostname === 'api.github.com' && u.pathname.includes('/actions/runs/')) {
    const id = u.pathname.split('/actions/runs/')[1];
    ghReads.push({ id, timed: !!opts.signal });
    if (cfg.ghRunThrow) throw new Error('network down');
    const runInfo = (cfg.ghRuns || {})[id];
    return runInfo ? reply(200, { id: Number(id), ...runInfo }) : reply(404, { message: 'Not Found' });
  }
  if (u.hostname === 'api.github.com') {
    dispatches.push({ workflow: u.pathname.split('/workflows/')[1].split('/')[0], ...JSON.parse(opts.body), timed: !!opts.signal });
    if (cfg.ghThrow) throw new Error('network down');
    const st = cfg.ghStatus || 204;
    return reply(st, st < 300 ? undefined : { message: 'Bad credentials' });
  }
  sbCalls.push({ method, path: u.pathname, query: decodeURIComponent(u.search) });
  if (cfg.sbFail) return reply(500, { message: 'boom' });
  if (cfg.patchFail && method === 'PATCH') return reply(500, { message: 'boom' });
  if (u.pathname !== '/rest/v1/excel_sync_runs') return reply(404, { message: 'no route' });
  const q = u.searchParams;
  if (method === 'GET') {
    let out = rows.slice();
    const st = q.get('status');
    if (st) { const list = st.replace(/^eq\./, '').replace(/^in\.\(|\)$/g, '').split(','); out = out.filter(r => list.includes(r.status)); }
    const gte = q.get('requested_at');
    if (gte) out = out.filter(r => r.requested_at >= gte.replace(/^gte\./, ''));
    out.sort((a, b) => b.requested_at.localeCompare(a.requested_at));
    return reply(200, out.slice(0, Number(q.get('limit') || 1000)));
  }
  if (method === 'POST') {
    const body = JSON.parse(opts.body);
    // another press inserted its manual run first: the partial unique index answers 409
    if (cfg.raceRow) { rows.push(cfg.raceRow); cfg.raceRow = null; return reply(409, { code: '23505', message: 'duplicate key value violates unique constraint "excel_sync_runs_one_manual"' }); }
    const row = { id: nextId++, requested_at: new Date().toISOString(), started_at: null, finished_at: null, files: null, error: null, github_run_id: null, ...body };
    rows.push(row);
    return reply(201, [row]);
  }
  if (method === 'PATCH') {
    let hit = rows.slice();
    if (q.get('id')) hit = hit.filter(r => r.id === Number(q.get('id').replace('eq.', '')));
    const st = q.get('status');
    if (st) { const list = st.replace(/^eq\./, '').replace(/^in\.\(|\)$/g, '').split(','); hit = hit.filter(r => list.includes(r.status)); }
    const lt = q.get('requested_at');
    if (lt) hit = hit.filter(r => r.requested_at < lt.replace(/^lt\./, ''));
    hit.forEach(r => Object.assign(r, JSON.parse(opts.body)));
    return /return=representation/.test((opts.headers || {}).Prefer || '') ? reply(200, hit) : reply(204);
  }
  return reply(405, {});
};
console.error = () => {};
const now = Math.floor(Date.now() / 1000);
(async () => {
  const out = [];
  for (const step of cfg.steps) {
    const handler = require(dir + '/excel-refresh.js');
    const headers = {};
    if (step.cookie) headers.cookie = 'team_session=' + auth.signSession(now + 3600, process.env.TEAM_SESSION_SECRET || 'x', process.env.TEAM_PASSWORD || 'x');
    const res = { code: 200, headers: {}, body: null,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      status(c) { this.code = c; return this; },
      json(b) { this.body = b; return this; },
      end() { return this; } };
    await handler({ method: step.method, headers, query: {}, body: step.body }, res);
    out.push({ status: res.code, body: res.body, headers: res.headers });
  }
  process.stdout.write(JSON.stringify({ out, rows, dispatches, ghReads, sb: sbCalls }));
})();
"""


def iso_ago(minutes):
    from datetime import datetime, timedelta, timezone
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat().replace("+00:00", "Z")


def run(steps, env=None, rows=None, **cfg):
    cfg = {"env": ENV if env is None else env, "steps": steps, "rows": rows or [], **cfg}
    p = subprocess.run([NODE, "-e", RUNNER, str(API), json.dumps(cfg)], capture_output=True, text=True)
    if p.returncode:
        raise RuntimeError(p.stderr)
    return json.loads(p.stdout)


POST = {"method": "POST", "cookie": True}
GET = {"method": "GET"}


@unittest.skipUnless(NODE, "needs node")
class ExcelRefresh(unittest.TestCase):
    def test_post_signed_out_is_401(self):
        r = run([{"method": "POST"}])
        self.assertEqual(r["out"][0]["status"], 401)
        self.assertEqual(r["rows"], [])
        self.assertEqual(r["dispatches"], [])

    def test_post_inserts_a_queued_manual_run_and_dispatches_it(self):
        r = run([POST])
        out = r["out"][0]
        self.assertEqual(out["status"], 202)
        self.assertEqual(len(r["rows"]), 1)
        row = r["rows"][0]
        self.assertEqual((row["trigger"], row["status"]), ("manual", "queued"))
        self.assertEqual(r["dispatches"], [{"workflow": "excel-mirror.yml", "ref": "main",
                                            "inputs": {"trigger": "manual", "run_id": str(row["id"])}, "timed": True}])
        self.assertEqual(out["body"]["run"]["id"], row["id"])
        self.assertTrue(out["body"]["dispatched"])

    def test_a_queued_run_is_returned_instead_of_dispatching(self):
        rows = [{"id": 7, "trigger": "manual", "status": "queued", "requested_at": iso_ago(5), "files": None, "error": None}]
        r = run([POST], rows=rows)
        out = r["out"][0]
        self.assertEqual(out["status"], 200)
        self.assertEqual(out["body"]["run"]["id"], 7)
        self.assertFalse(out["body"]["dispatched"])
        self.assertEqual(r["dispatches"], [])
        self.assertEqual(len(r["rows"]), 1)

    # Jay's review of #117: GitHub cancels a pending run when a newer one joins the
    # concurrency group, so its row would stay queued and block Refresh for 45 min
    def test_a_queued_run_whose_github_run_ended_is_closed_and_a_new_one_dispatched(self):
        rows = [{"id": 7, "trigger": "manual", "status": "queued", "requested_at": iso_ago(5), "files": None,
                 "error": None, "github_run_id": 9001}]
        r = run([POST], rows=rows, ghRuns={"9001": {"status": "completed", "conclusion": "cancelled"}})
        out = r["out"][0]
        self.assertEqual(out["status"], 202)
        self.assertTrue(out["body"]["dispatched"])
        old = next(x for x in r["rows"] if x["id"] == 7)
        self.assertEqual(old["status"], "failed")
        self.assertIn("GitHub ended the workflow run before its job began", old["error"])
        self.assertTrue(old["finished_at"])
        self.assertEqual(r["ghReads"], [{"id": "9001", "timed": True}])
        self.assertEqual(len(r["dispatches"]), 1)
        self.assertEqual(r["dispatches"][0]["inputs"]["run_id"], str(out["body"]["run"]["id"]))
        closing = [c for c in r["sb"] if c["method"] == "PATCH"]
        self.assertTrue(any("id=eq.7" in c["query"] and "status=eq.queued" in c["query"] for c in closing))

    def test_a_queued_run_still_pending_on_github_is_followed(self):
        for why, kw in {"pending": {"ghRuns": {"9001": {"status": "queued"}}},
                        "in progress": {"ghRuns": {"9001": {"status": "in_progress"}}},
                        "GitHub does not know it": {},
                        "GitHub does not answer": {"ghRunThrow": True}}.items():
            with self.subTest(why=why):
                rows = [{"id": 7, "trigger": "manual", "status": "queued", "requested_at": iso_ago(5), "files": None,
                         "error": None, "github_run_id": 9001}]
                r = run([POST], rows=rows, **kw)
                out = r["out"][0]
                self.assertEqual(out["status"], 200)
                self.assertEqual(out["body"]["run"]["id"], 7)
                self.assertFalse(out["body"]["dispatched"])
                self.assertEqual(r["rows"][0]["status"], "queued")
                self.assertEqual(r["dispatches"], [])

    def test_a_queued_run_without_a_github_id_is_not_looked_up(self):
        rows = [{"id": 7, "trigger": "manual", "status": "queued", "requested_at": iso_ago(1), "files": None,
                 "error": None, "github_run_id": None}]
        r = run([POST], rows=rows)
        self.assertEqual(r["out"][0]["body"]["run"]["id"], 7)
        self.assertEqual(r["ghReads"], [])
        self.assertEqual(r["dispatches"], [])

    def test_a_running_run_does_not_block(self):
        # it read the inputs when it started: a press now must queue a run that sees the latest edits
        for trigger in ("manual", "scheduled"):
            with self.subTest(trigger=trigger):
                rows = [{"id": 7, "trigger": trigger, "status": "running", "requested_at": iso_ago(5), "files": None, "error": None}]
                r = run([POST], rows=rows)
                self.assertEqual(r["out"][0]["status"], 202)
                self.assertEqual(len(r["dispatches"]), 1)
                self.assertEqual(r["rows"][0]["status"], "running")

    def test_a_stale_or_finished_run_does_not_block(self):
        rows = [{"id": 7, "trigger": "manual", "status": "queued", "requested_at": iso_ago(50)},
                {"id": 8, "trigger": "manual", "status": "success", "requested_at": iso_ago(2)}]
        r = run([POST], rows=rows)
        self.assertEqual(r["out"][0]["status"], 202)
        self.assertEqual(len(r["dispatches"]), 1)
        self.assertEqual(r["rows"][0]["status"], "failed")           # closed as never finished first

    def test_a_queued_run_still_blocks_after_fifteen_minutes(self):
        rows = [{"id": 7, "trigger": "manual", "status": "queued", "requested_at": iso_ago(30)}]
        r = run([POST], rows=rows)
        self.assertEqual(r["out"][0]["status"], 200)
        self.assertEqual(r["out"][0]["body"]["run"]["id"], 7)
        self.assertEqual(r["dispatches"], [])

    def test_two_presses_at_once_start_one_run(self):
        first = {"id": 9, "trigger": "manual", "status": "queued", "requested_at": iso_ago(0)}
        r = run([POST], raceRow=first)
        out = r["out"][0]
        self.assertEqual(out["status"], 200)
        self.assertEqual(out["body"]["run"]["id"], 9)
        self.assertFalse(out["body"]["dispatched"])
        self.assertEqual(r["dispatches"], [])

    def test_a_409_with_no_queued_run_is_an_error(self):
        r = run([POST], raceRow={"id": 9, "trigger": "manual", "status": "success", "requested_at": iso_ago(0)})
        self.assertEqual(r["out"][0]["status"], 502)
        self.assertEqual(r["dispatches"], [])

    def test_a_failed_dispatch_marks_the_row_failed(self):
        for cfg in ({"ghStatus": 401}, {"ghThrow": True}):
            with self.subTest(**cfg):
                r = run([POST], **cfg)
                out = r["out"][0]
                self.assertEqual(out["status"], 502)
                row = r["rows"][0]
                self.assertEqual(row["status"], "failed")
                self.assertTrue(row["finished_at"])
                self.assertIn("dispatch", row["error"])
                self.assertEqual(out["body"]["run"]["status"], "failed")

    def test_get_lists_the_latest_ten_runs_with_short_file_summaries(self):
        long = "x" * 5000
        rows = [{"id": i, "trigger": "scheduled", "status": "success", "requested_at": iso_ago(60 * i), "started_at": None,
                 "finished_at": None, "github_run_id": 123, "error": long if i == 1 else None,
                 "files": [{"target": "bse_vf", "status": "partial", "cells": 400, "sheets": ["Web Dashboard"], "duration_s": 3.2,
                            "errors": ["label check failed: " + long, "second"], "item": {"drive_id": "d", "item_id": "i"}}]}
                for i in range(1, 13)]
        r = run([GET], rows=rows)
        out = r["out"][0]
        self.assertEqual(out["status"], 200)
        body = out["body"]
        self.assertTrue(body["configured"])
        self.assertEqual(body["schedule"], "Daily at 01:00 IST")
        self.assertEqual([x["id"] for x in body["runs"]], list(range(1, 11)))
        f = body["runs"][0]["files"][0]
        self.assertEqual((f["target"], f["status"], f["cells"]), ("bse_vf", "partial", 400))
        self.assertLessEqual(len(f["error"]), 200)
        self.assertNotIn("item", f)
        self.assertLessEqual(len(body["runs"][0]["error"]), 200)
        self.assertEqual(body["runs"][0]["run_url"], "https://github.com/sucaanalytics-max/ExchangesDash/actions/runs/123")
        self.assertFalse(body["signed_in"])
        self.assertEqual([(c["method"], "limit=10" in c["query"]) for c in r["sb"]], [("GET", True)])   # one read, no write

    def test_get_closes_runs_that_never_finished(self):
        rows = [{"id": 1, "trigger": "manual", "status": "queued", "requested_at": iso_ago(50), "files": None, "error": None},
                {"id": 2, "trigger": "scheduled", "status": "running", "requested_at": iso_ago(46), "files": None, "error": None},
                {"id": 3, "trigger": "manual", "status": "running", "requested_at": iso_ago(10), "files": None, "error": None},
                {"id": 4, "trigger": "manual", "status": "success", "requested_at": iso_ago(90), "files": None, "error": None}]
        r = run([GET], rows=rows)
        by = {x["id"]: x for x in r["out"][0]["body"]["runs"]}
        self.assertEqual((by[1]["status"], by[2]["status"]), ("failed", "failed"))
        self.assertIn("never finished", by[1]["error"])
        self.assertEqual(by[3]["status"], "running")
        self.assertEqual((by[4]["status"], by[4]["error"]), ("success", None))
        self.assertTrue(r["rows"][0]["finished_at"])

    def test_get_passes_inputs_written(self):
        rows = [{"id": 1, "trigger": "manual", "status": "partial", "requested_at": iso_ago(5),
                 "files": [{"target": "bse_vf", "status": "partial", "inputs_written": False}, {"target": "dashboard", "status": "success"}]}]
        files = run([GET], rows=rows)["out"][0]["body"]["runs"][0]["files"]
        self.assertEqual([f["inputs_written"] for f in files], [False, None])

    def test_get_with_a_session_says_signed_in(self):
        r = run([{"method": "GET", "cookie": True}])
        self.assertTrue(r["out"][0]["body"]["signed_in"])
        self.assertEqual(r["out"][0]["body"]["runs"], [])

    def test_missing_env_is_503(self):
        for drop in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY", "GITHUB_DISPATCH_PAT"):
            with self.subTest(drop=drop):
                env = {k: v for k, v in ENV.items() if k != drop}
                r = run([GET, POST], env=env)
                for out in r["out"]:
                    self.assertEqual(out["status"], 503)
                    self.assertEqual(out["body"]["configured"], False)
                self.assertEqual(r["dispatches"], [])

    def test_a_failed_stale_sweep_still_lists_the_runs(self):
        rows = [{"id": 1, "trigger": "manual", "status": "queued", "requested_at": iso_ago(50), "files": None, "error": None}]
        r = run([GET], rows=rows, patchFail=True)
        out = r["out"][0]
        self.assertEqual(out["status"], 200)
        self.assertEqual([x["id"] for x in out["body"]["runs"]], [1])

    def test_input_cells_are_passed_through(self):
        rows = [{"id": 1, "trigger": "manual", "status": "partial", "requested_at": iso_ago(5),
                 "files": [{"target": "mcx_vf", "status": "partial", "inputs_written": False,
                            "input_cells": {"B16:D16": False, "F11": True}}]}]
        f = run([GET], rows=rows)["out"][0]["body"]["runs"][0]["files"][0]
        self.assertEqual(f["input_cells"], {"B16:D16": False, "F11": True})

    def test_supabase_down_is_502(self):
        r = run([GET, POST], sbFail=True)
        self.assertEqual([o["status"] for o in r["out"]], [502, 502])
        self.assertEqual(r["dispatches"], [])

    def test_every_answer_is_no_store_and_other_methods_405(self):
        r = run([GET, POST, {"method": "POST"}, {"method": "DELETE"}], env={})
        for out in r["out"]:
            self.assertEqual(out["headers"]["cache-control"], "no-store")
        r = run([{"method": "DELETE"}])
        self.assertEqual(r["out"][0]["status"], 405)

    def test_vercel_json_sends_no_store(self):
        cfg = json.loads((DASHBOARD / "vercel.json").read_text())
        h = [x for x in cfg["headers"] if x["source"] == "/api/excel-refresh"]
        self.assertEqual(h[0]["headers"], [{"key": "Cache-Control", "value": "no-store"}])

class OneQueuedManualRunIndex(unittest.TestCase):
    """valuation_sync_schema.sql: the update before excel_sync_runs_one_manual leaves at
    most one queued manual row, so the unique index can always be built (Jay's review of
    #117: two rows queued within the same 45 minutes made it fail). Run in SQLite, which
    accepts this partial index; Postgres-only bits (schema, now()) are swapped out."""

    def block(self):
        sql = (API.parent.parent / "valuation_sync_schema.sql").read_text()
        start = sql.index("update public.excel_sync_runs\n   set status = 'failed'")
        end = sql.index(";", sql.index("create unique index if not exists excel_sync_runs_one_manual")) + 1
        return sql[start:end].replace("public.", "").replace("now()", "CURRENT_TIMESTAMP")

    def db(self, rows):
        import sqlite3
        con = sqlite3.connect(":memory:")
        con.execute("create table excel_sync_runs (id integer primary key, trigger text, status text, finished_at text, error text)")
        con.executemany("insert into excel_sync_runs (id, trigger, status) values (?, ?, ?)", rows)
        return con

    def test_the_index_builds_with_several_queued_manual_rows(self):
        con = self.db([(1, "manual", "queued"), (2, "manual", "queued"), (3, "scheduled", "queued"),
                       (4, "manual", "running"), (5, "manual", "queued")])
        con.executescript(self.block())
        got = dict(con.execute("select id, status from excel_sync_runs").fetchall())
        self.assertEqual(got, {1: "failed", 2: "failed", 3: "queued", 4: "running", 5: "queued"})   # the newest stays
        with self.assertRaises(Exception):   # the index now holds: a second queued manual row is refused
            con.execute("insert into excel_sync_runs (id, trigger, status) values (6, 'manual', 'queued')")
        con.executescript(self.block())      # safe to run again
        self.assertEqual(con.execute("select count(*) from excel_sync_runs where status = 'queued'").fetchone()[0], 2)

    def test_no_queued_manual_rows_changes_nothing(self):
        con = self.db([(1, "manual", "success")])
        con.executescript(self.block())
        self.assertEqual(con.execute("select status from excel_sync_runs").fetchall(), [("success",)])


if __name__ == "__main__":
    unittest.main()
