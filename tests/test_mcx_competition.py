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


@unittest.skipUnless(NODE, "node not installed")
class Alpha(unittest.TestCase):
    def test_hex_to_rgba_and_other_colours_unchanged(self):
        got = js_eval(["rxAlpha"], "['#2a78d6', '#FFF', 'var(--x)', 'rgb(1,2,3)', null].map(c => rxAlpha(c, 0.35))")
        self.assertEqual(got, ["rgba(42, 120, 214, 0.35)", "rgba(255, 255, 255, 0.35)", "var(--x)", "rgb(1,2,3)", None])


if __name__ == "__main__":
    unittest.main()
