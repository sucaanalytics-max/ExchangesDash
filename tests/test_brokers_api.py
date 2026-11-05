"""Each Brokers Summary panel's last data day: worked out by
dashboard/api/brokers.js (panelsThrough), and shown by js/30-brokers.js as
"MTF through …", flagged when it trails the run's as-of date. Run in Node."""

import json
import subprocess
import unittest

from helpers import DASHBOARD, NODE, js_eval

API = DASHBOARD / "api" / "brokers.js"


def through(last, recent):
    script = (f"const {{ panelsThrough }} = require({json.dumps(str(API))});\n"
              f"process.stdout.write(JSON.stringify(panelsThrough({json.dumps(last)}, {json.dumps(recent)})));")
    out = subprocess.run([NODE, "-"], input=script, capture_output=True, text=True)
    if out.returncode:
        raise RuntimeError(out.stderr)
    return json.loads(out.stdout)


def rows(days, segs):
    return [{"trade_date": d, "segment": s} for d in days for s in segs]


# Trading days 13 Oct-2 Nov 2026; 20 Oct is an equity holiday that MCX traded
DAYS = ["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19", "2026-10-21", "2026-10-22",
        "2026-10-23", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-11-02"]
RECENT = rows(DAYS, ["fo", "cash", "comm"]) + rows(["2026-10-20"], ["comm"]) \
    + rows([d for d in DAYS if d <= "2026-10-19"], ["mtf_gross", "mtf_net"])
LAST = {"fo": "2026-11-02", "cash": "2026-11-02", "comm": "2026-11-02", "mtf_gross": "2026-10-19", "mtf_net": "2026-10-19"}


@unittest.skipUnless(NODE, "node not installed")
class PanelsThrough(unittest.TestCase):
    def test_mtf_stopped_early(self):
        # The 4 Nov 2026 Angel One run: MTF to 19 Oct, the rest to 2 Nov
        out = through(LAST, RECENT)
        self.assertEqual(out["MTF"], {"through": "2026-10-19", "segment": "mtf_gross", "days_behind": 9})
        self.assertEqual(out["MTF (net)"], {"through": "2026-10-19", "segment": "mtf_net", "days_behind": 9})
        # Consolidated is as current as its earliest-ending segment, and names it
        self.assertEqual(out["Consolidated"], {"through": "2026-10-19", "segment": "mtf_gross", "days_behind": 9})
        for panel in ("Broking", "F&O", "Cash", "Commodities"):
            self.assertEqual((out[panel]["through"], out[panel]["days_behind"]), ("2026-11-02", 0))

    def test_mcx_only_days_are_not_trading_days_behind(self):
        # MTF to 19 Oct, the run as of 21 Oct: 20 Oct (MCX only) doesn't count
        cut = [r for r in RECENT if r["trade_date"] <= "2026-10-21"]
        last = {**LAST, "fo": "2026-10-21", "cash": "2026-10-21", "comm": "2026-10-21"}
        self.assertEqual(through(last, cut)["MTF"]["days_behind"], 1)

    def test_unpublished_segments_are_skipped(self):
        # Motilal Oswal: MTF is net interest income, no mtf_gross or mtf_net
        last = {"fo": "2026-11-02", "cash": "2026-11-02", "comm": "2026-11-02", "mtf_nii": "2026-11-02"}
        out = through(last, rows(DAYS, ["fo", "cash", "comm", "mtf_nii"]))
        self.assertEqual(out["MTF"], {"through": "2026-11-02", "segment": "mtf_nii", "days_behind": 0})
        self.assertNotIn("MTF (net)", out)

    def test_a_day_before_the_window_has_no_count(self):
        # A segment whose last day falls before the window read: the count would be short
        out = through({**LAST, "mtf_gross": "2026-05-29"}, RECENT)
        self.assertEqual(out["MTF"], {"through": "2026-05-29", "segment": "mtf_gross", "days_behind": None})


PAGE = ["MONTHS_SHORT", "fmtLongDate", "escHtml", "brkLag", "brkBehind", "brkMtfThrough"]


def page(summary, expr):
    return js_eval(PAGE, f"(() => {{ globalThis.BRK = {{ summary: DATA }}; return {expr}; }})()", summary)


def summary(as_of, mtf, days_behind):
    return {"run": {"as_of_date": as_of},
            "through": {"MTF": {"through": mtf, "days_behind": days_behind},
                        "Broking": {"through": as_of, "days_behind": 0}}}


@unittest.skipUnless(NODE, "node not installed")
class Page(unittest.TestCase):
    def test_current_mtf_is_plain(self):
        out = page(summary("2026-11-03", "2026-11-03", 0), "[brkLag('MTF'), brkMtfThrough()]")
        self.assertIsNone(out[0])
        self.assertEqual(out[1], {"item": " · MTF through <b>3 Nov 2026</b>", "note": ""})

    def test_late_mtf_is_flagged_with_a_note(self):
        lag, mtf = page(summary("2026-11-02", "2026-10-19", 9), "[brkLag('MTF'), brkMtfThrough()]")
        self.assertEqual(lag, {"through": "2026-10-19", "days_behind": 9})
        self.assertIn("MTF through <b>19 Oct 2026</b> (9 trading days behind)", mtf["item"])
        self.assertIn("ends on 19 Oct 2026, 9 trading days before its as-of date, 2 Nov 2026", mtf["note"])
        self.assertIsNone(page(summary("2026-11-02", "2026-10-19", 9), "brkLag('Broking')"))

    def test_no_mtf_panel_shows_nothing(self):
        out = page({"run": {"as_of_date": "2026-11-03"}, "through": {}}, "brkMtfThrough()")
        self.assertEqual(out, {"item": "", "note": ""})


if __name__ == "__main__":
    unittest.main()
