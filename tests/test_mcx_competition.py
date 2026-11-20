"""MCX Competition tab (dashboard/js/19-mcx-competition.js), run in Node: the
zero-premium day rule matches the pipeline's (scripts/nse_commodity_pipeline.py
premium_out), per-session premium averages over a period divide by its
prem_days, and the faded bar colour (rxAlpha, 00-core.js)."""

import json
import unittest

from helpers import NODE, js_eval  # also puts scripts/ on sys.path

import nse_commodity_pipeline as com

CC_JS = ["ccVal", "ccPremOk", "ccPeriodDays", "CC_TOP_UNDS", "ccTopVal", "ccTopDays", "ccTopPer"]

ROWS = [
    {"mcx": None},
    {"mcx": {"crude": {"f": [1, 10.0]}}},
    {"mcx": {"crude": {"o": [0, 0.0, 0.0]}}},
    {"mcx": {"crude": {"o": [1, 9.0, None]}}},
    {"mcx": {"crude": {"o": [9, 90.0, 5.0]}, "index": {"o": [2, 0.2, 0.0]}}},
    {"mcx": {"crude": {"o": [9, 90.0, 0.0]}, "gold": {"o": [1, 9.0, 0]}}},
    {"mcx": {"crude": {"f": [3, 30.0], "o": [9, 90.0, 0.0]}}},
]


@unittest.skipUnless(NODE, "node not installed")
class ZeroPremiumDay(unittest.TestCase):
    def test_js_rule_matches_the_pipeline(self):
        got = js_eval(CC_JS, f"{json.dumps(ROWS)}.map(r => !ccPremOk(r))")
        self.assertEqual(got, [com.premium_out(r) for r in ROWS])
        self.assertEqual(got, [False, False, False, False, False, True, True])

    def test_period_premium_divides_by_prem_days(self):
        p = {"month": "2026-06", "days": 3, "prem_days": 2,
             "nse": {"crude": {"o": [30, 300.0, 2.0]}}, "mcx": {"crude": {"o": [3000, 27000.0, 198.0]}}}
        old = {k: v for k, v in p.items() if k != "prem_days"}   # a file written before prem_days
        got = js_eval(CC_JS, f"""(() => {{ const p = {json.dumps(p)}, old = {json.dumps(old)};
            return [ccTopPer(p, 'mcx', 'crude', 'prem'), ccTopPer(p, 'mcx', 'crude', 'con'),
                    ccTopPer(old, 'mcx', 'crude', 'prem'), ccPeriodDays(p, 'onot'), ccPeriodDays(p, 'prem')]; }})()""")
        self.assertEqual(got, [99.0, 1000.0, 66.0, 3, 2])


RISK_JS = ["ccVal", "ccExpiryWindow", "ccRiskDay", "ccRiskSum", "ccRiskLoss", "ccRiskYear", "ccRiskByMonth"]

# Four sessions: crude options expire on 10 Nov (xo), so 9 and 10 Nov are its expiry window.
# MCX: futures notional 1,000 and options premium 100 each day, fut_rev 0.042 (₹420/Cr two-sided)
# and opt_rev 0.0836 (₹8,360/Cr). NSE: futures notional 10 and crude premium 2 (natgas 1 on 9 Nov).
P2 = {"parser": 2}
MCX_CELLS = {"crude": {"f": [9, 1000.0], "o": [9, 900.0, 100.0]}}
RISK_DAYS = [
    {"date": "2026-11-06", "nse": {"crude": {"f": [1, 10.0], "o": [1, 20.0, 2.0]}}, "mcx": MCX_CELLS, "rev": [0.0003, 0.0003], **P2},
    {"date": "2026-11-09", "nse": {"crude": {"f": [1, 10.0], "o": [1, 20.0, 2.0]}, "natgas": {"o": [1, 5.0, 1.0]}},
     "mcx": MCX_CELLS, "rev": [0.0003, 0.0003], **P2},
    {"date": "2026-11-10", "nse": {"crude": {"f": [1, 10.0], "o": [1, 20.0, 2.0]}}, "mcx": MCX_CELLS, "rev": [0.0003, 0.0003],
     "xo": ["crude"], **P2},
    {"date": "2026-11-11", "nse": {"crude": {"f": [1, 10.0], "o": [1, 20.0, 2.0]}}, "mcx": MCX_CELLS, "rev": [0.0003, 0.0003]},
]
MCX_REV = [{"date": d, "fut_rev": 0.042, "opt_rev": 0.0836} for d in ("2026-11-06", "2026-11-09", "2026-11-10", "2026-11-11")]


@unittest.skipUnless(NODE, "node not installed")
class RevenueAtRisk(unittest.TestCase):
    def run_js(self, expr, days=RISK_DAYS, mcx=MCX_REV):
        return js_eval(RISK_JS, f"""(() => {{ const days = {json.dumps(days)}, mcx = {json.dumps(mcx)};
            const ew = ccExpiryWindow(days), by = new Map(mcx.map(r => [r.date, r]));
            return {expr}; }})()""")

    def test_window_is_the_expiry_day_and_the_session_before(self):
        got = self.run_js("days.map(r => [[...(ew.win.get(r.date) || [])], ew.known.get(r.date)])")
        # 10 Nov's split needs 11 Nov's file read with parser 2, which it isn't
        self.assertEqual(got, [[[], True], [["crude"], True], [["crude"], False], [[], False]])

    def test_split_adds_up_to_the_ceiling(self):
        d = self.run_js("days.slice(0, 2).map(r => ccRiskDay(r, by.get(r.date), ew))")
        fut = 10 * 0.042 / 1000                       # NSE futures at MCX's futures rate
        self.assertAlmostEqual(d[0]["fut"], fut)
        self.assertAlmostEqual(d[0]["optOrd"], 2 * 0.0836 / 100)
        self.assertAlmostEqual(d[0]["optExp"], 0)
        # 9 Nov: crude's premium is in the window, natgas's is not
        self.assertAlmostEqual(d[1]["optExp"], 2 * 0.0836 / 100)
        self.assertAlmostEqual(d[1]["optOrd"], 1 * 0.0836 / 100)
        t = self.run_js("ccRiskSum(days.slice(0, 2), by, ew)")
        self.assertEqual(t["days"], 2)
        self.assertAlmostEqual(t["ord"] + t["exp"], t["ceil"])
        self.assertAlmostEqual(t["mcx"], 2 * 0.1256)

    def test_unknown_split_and_left_out_days(self):
        t = self.run_js("ccRiskSum(days, by, ew)")
        self.assertEqual((t["days"], t["unknown"], t["ord"], t["exp"]), (4, 2, None, None))
        self.assertIsNone(self.run_js("ccRiskLoss(ccRiskSum(days, by, ew), {ord: 100, exp: 30})"))
        # MCX's premium 0 (23 Jun 2026) or no MCX revenue row: the session is left out
        zero = [dict(RISK_DAYS[0], mcx={"crude": {"f": [9, 1000.0], "o": [9, 900.0, 0.0]}})]
        self.assertEqual(self.run_js("ccRiskSum(days, by, ew).days", zero), 0)
        self.assertEqual(self.run_js("ccRiskSum(days, by, ew).days", RISK_DAYS[:1], []), 0)

    def test_loss_and_a_year(self):
        loss = self.run_js("ccRiskLoss({ord: 2, exp: 1}, {ord: 100, exp: 30})")
        self.assertAlmostEqual(loss, 2.3)
        y = self.run_js("ccRiskYear(0.5, 258, 57, 25.45, 46)")
        self.assertAlmostEqual(y["rev"], 129)
        self.assertAlmostEqual(y["pat"], 129 * 0.57)
        self.assertAlmostEqual(y["eps"], 129 * 0.57 / 25.45)
        self.assertAlmostEqual(y["value"], 129 * 0.57 / 25.45 * 46)
        self.assertIsNone(self.run_js("ccRiskYear(0.5, 258, 57, 0, 46)")["eps"])

    def test_by_month(self):
        m = self.run_js("ccRiskByMonth(days, mcx, ew)")
        self.assertEqual([(p["month"], p["days"]) for p in m], [("2026-11", 4)])


@unittest.skipUnless(NODE, "node not installed")
class Alpha(unittest.TestCase):
    def test_hex_to_rgba_and_other_colours_unchanged(self):
        got = js_eval(["rxAlpha"], "['#2a78d6', '#FFF', 'var(--x)', 'rgb(1,2,3)', null].map(c => rxAlpha(c, 0.35))")
        self.assertEqual(got, ["rgba(42, 120, 214, 0.35)", "rgba(255, 255, 255, 0.35)", "var(--x)", "rgb(1,2,3)", None])


if __name__ == "__main__":
    unittest.main()
