"""The Excel sync panel on the Valuation Model tab (dashboard/js/24-excel-sync.js):
what it shows for each API answer, who sees the Refresh button, and the refresh
flow (POST, then GET every 10 s until the run finishes or 10 minutes pass) with
fetch and the timers stubbed in Node."""

import json
import subprocess
import unittest

from helpers import NODE, js_closure, js_eval, js_source

RUNS = [
    {"id": 3, "trigger": "manual", "status": "partial", "requested_at": "2026-11-23T05:00:00Z", "started_at": "2026-11-23T05:01:00Z",
     "finished_at": "2026-11-23T05:03:00Z", "error": None, "run_url": "https://github.com/x/y/actions/runs/9",
     "files": [{"target": "nse_vf", "status": "success", "cells": 400, "sheets": ["Web Dashboard"], "error": None, "dry_run": False},
               {"target": "bse_vf", "status": "partial", "cells": 300, "sheets": ["Web Dashboard"], "error": "label check failed: A16 reads 'PB Ratio'", "dry_run": False, "inputs_written": False},
               {"target": "mcx_vf", "status": "failed", "cells": 0, "sheets": [], "error": "file locked (HTTP 423: <locked>)", "dry_run": False},
               {"target": "dashboard", "status": "success", "cells": 90000, "sheets": ["WD_Inputs"], "error": None, "dry_run": False}]},
    {"id": 2, "trigger": "scheduled", "status": "failed", "requested_at": "2026-11-22T19:30:00Z", "started_at": None,
     "finished_at": "2026-11-22T19:31:00Z", "error": "shared inputs not read from Supabase", "run_url": None, "files": []},
]


def panel(state, signed_in, **extra):
    s = {"state": state, "runs": RUNS if state == "ok" else [], "schedule": "Daily at 01:00 IST", "poll": None, "busy": False, "note": None, **extra}
    return js_eval(["excelSyncPanelHTML"], f"excelSyncPanelHTML(DATA, {json.dumps(signed_in)})", s, closure=True)


@unittest.skipUnless(NODE, "needs node")
class PanelHTML(unittest.TestCase):
    def test_runs_table(self):
        html = panel("ok", True)
        self.assertIn("Daily at 01:00 IST", html)
        self.assertIn("23 Nov, 10:33", html)                   # finished_at in IST
        self.assertIn(">Manual<", html.replace("</td>", "<").replace("<td class=\"rx-l\">", ">"))
        self.assertIn("rx-chip--warn\">Partial", html)
        self.assertIn("rx-chip--bad\">Failed", html)
        self.assertIn('class="xs-file rx-up" title="NSE vF: success · 400 cells">NSE vF ✓', html)
        self.assertIn("title=\"BSE vF: partial · 300 cells · input cells NOT written · label check failed: A16 reads &#39;PB Ratio&#39;\"", html.replace("'", "&#39;"))
        self.assertIn("MCX vF ✗", html)
        self.assertIn("&lt;locked&gt;", html)                  # errors are escaped
        self.assertIn("shared inputs not read from Supabase", html)   # a run without files shows its error
        self.assertIn('href="https://github.com/x/y/actions/runs/9"', html)

    def test_input_cells_tooltip(self):
        def text(f):
            return js_eval(["excelSyncInputsText"], "excelSyncInputsText(DATA)", f, closure=True)
        self.assertEqual(text({"inputs_written": False, "input_cells": {"B16:D16": False, "F11": True, "F12": True}}),
                         " · some input cells not written (B16:D16)")
        self.assertEqual(text({"inputs_written": False, "input_cells": {"B16:D16": False, "F11": False}}), " · input cells NOT written")
        self.assertEqual(text({"inputs_written": True, "input_cells": {"B16:D16": True}}), " · input cells written")
        self.assertEqual(text({"inputs_written": False}), " · input cells NOT written")
        self.assertEqual(text({"inputs_written": None}), "")

    def test_button_only_when_signed_in(self):
        self.assertIn("data-xs-refresh", panel("ok", True))
        out = panel("ok", False)
        self.assertNotIn("data-xs-refresh", out)
        self.assertIn("Sign in", out)

    def test_button_disabled_while_following_a_run(self):
        html = panel("ok", True, poll={"id": 3})
        self.assertIn("data-xs-refresh disabled>Refreshing…", html)

    def test_not_configured(self):
        html = panel("off", True)
        self.assertIn("Not configured", html)
        self.assertIn("Daily at 01:00 IST", html)
        self.assertNotIn("data-xs-refresh", html)

    def test_loading_error_and_empty(self):
        self.assertIn("Loading…", panel("idle", False))
        self.assertIn("Sync status unavailable", panel("error", False))
        html = js_eval(["excelSyncPanelHTML"], "excelSyncPanelHTML({...DATA, runs: []}, false)",
                       {"state": "ok", "runs": [], "schedule": "Daily at 01:00 IST", "poll": None, "busy": False, "note": None}, closure=True)
        self.assertIn("No runs yet.", html)


# The refresh flow: fetch answers from a script, timers collected and fired by hand
FLOW = r"""
const document = { querySelectorAll: () => [] };
const calls = [], delays = [];
let pending = [];
// timers are collected and fired by hand; a cleared one (valuationFetchJson's request
// timeout, once the stubbed fetch has answered) is dropped
let timerId = 0;
const setTimeout = (f, ms) => { const id = ++timerId; delays.push(ms); pending.push({ id, f }); return id; };
const clearTimeout = id => { pending = pending.filter(t => t.id !== id); };
let clock = 0;
const realNow = Date.now;
Date.now = () => clock;
const answers = DATA.answers;
const fetch = async (url, opts = {}) => {
  calls.push({ url, method: opts.method || 'GET', cache: opts.cache || null });
  const a = answers.shift() || { status: 200, body: { runs: [] } };
  return { ok: a.status < 300, status: a.status, json: async () => a.body };
};
VALUATION_SHARED.signedIn = true;
if (DATA.flushFails) valuationFlushSaves = async () => { if (DATA.signOut) VALUATION_SHARED.signedIn = false; return false; };
(async () => {
  await excelSyncRefresh();
  const notes = [EXCEL_SYNC.note && EXCEL_SYNC.note.text];
  for (let i = 0; i < 100 && pending.length; i++) {
    clock += 10000;
    const t = pending.shift();
    await t.f();
  }
  process.stdout.write(JSON.stringify({ calls, delays, note: EXCEL_SYNC.note, notes, poll: EXCEL_SYNC.poll, signedIn: VALUATION_SHARED.signedIn }));
})();
"""


def flow(answers, **data):
    names = js_closure(["excelSyncRefresh", "excelSyncFollow", "excelSyncLoad", "excelSyncRender", "VALUATION_SHARED",
                        "valuationSharedNotify"])
    code = "\n".join(js_source(n) for n in names)
    script = f"const DATA = {json.dumps({'answers': answers, **data})};\n{code}\n{FLOW}"
    out = subprocess.run([NODE, "-"], input=script, capture_output=True, text=True)
    if out.returncode:
        raise RuntimeError(out.stderr)
    return json.loads(out.stdout)


def run(id_, status):
    return {"id": id_, "trigger": "manual", "status": status, "requested_at": "2026-11-23T05:00:00Z", "files": []}


@unittest.skipUnless(NODE, "needs node")
class RefreshFlow(unittest.TestCase):
    def test_posts_then_polls_every_ten_seconds_until_done(self):
        r = flow([{"status": 202, "body": {"run": run(7, "queued"), "dispatched": True}},
                  {"status": 200, "body": {"runs": [run(7, "running")]}},
                  {"status": 200, "body": {"runs": [run(7, "running")]}},
                  {"status": 200, "body": {"runs": [run(7, "success")]}}])
        self.assertEqual([c["method"] for c in r["calls"]], ["POST", "GET", "GET", "GET"])
        self.assertTrue(all(c["url"] == "/api/excel-refresh" for c in r["calls"]))   # no cache-busting
        self.assertEqual(set(r["delays"]), {10000})
        self.assertIsNone(r["poll"])
        self.assertEqual(r["note"]["text"], "Excel files refreshed.")
        self.assertIn("Refresh started", r["notes"][0])

    def test_stops_after_ten_minutes(self):
        r = flow([{"status": 202, "body": {"run": run(7, "queued"), "dispatched": True}}]
                 + [{"status": 200, "body": {"runs": [run(7, "running")]}}] * 80)
        self.assertEqual(len([c for c in r["calls"] if c["method"] == "GET"]), 60)
        self.assertIsNone(r["poll"])
        self.assertIn("Still running after 10 minutes", r["note"]["text"])

    def test_unsaved_edits_stop_the_refresh(self):
        r = flow([{"status": 202, "body": {"run": run(7, "queued"), "dispatched": True}}], flushFails=True)
        self.assertEqual(r["calls"], [])                     # nothing posted: the run would read the old inputs
        self.assertEqual(r["note"]["text"], "Your last edits are not saved yet: retry them first.")

    def test_both_requests_use_the_shared_timeout(self):
        for name in ("excelSyncLoad", "excelSyncRefresh"):
            src = js_source(name)
            self.assertIn("valuationFetchJson('/api/excel-refresh'", src, name)   # 10 s, aborts the request
            self.assertNotIn("await fetch(", src, name)

    def test_a_signed_out_flush_says_so(self):
        r = flow([], flushFails=True, signOut=True)
        self.assertEqual(r["calls"], [])
        self.assertIn("Signed out", r["note"]["text"])

    def test_an_active_run_is_followed(self):
        r = flow([{"status": 200, "body": {"run": run(5, "running"), "dispatched": False}},
                  {"status": 200, "body": {"runs": [run(5, "failed")]}}])
        self.assertIn("already under way", r["notes"][0])
        self.assertIn("failed", r["note"]["text"])

    def test_refused_and_signed_out(self):
        r = flow([{"status": 502, "body": {"run": run(8, "failed"), "dispatched": False, "error": "GitHub dispatch failed (HTTP 401)"}}])
        self.assertEqual([c["method"] for c in r["calls"]], ["POST"])
        self.assertIn("did not start: GitHub dispatch failed", r["note"]["text"])
        r = flow([{"status": 401, "body": {"error": "Sign in"}}])
        self.assertFalse(r["signedIn"])
        self.assertIn("Signed out", r["note"]["text"])


if __name__ == "__main__":
    unittest.main()
