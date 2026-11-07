"""Brokers → Summary: periods still open at the run's as-of date. The API counts the
F&O trading days published in the FY, quarter and month holding the as-of date
(openPeriods in dashboard/api/brokers.js); the page opens on the period before one
with fewer than 5 days and labels an open period (dashboard/js/30-brokers.js)."""

import json
import subprocess
import unittest

from helpers import DASHBOARD, NODE, js_eval

# F&O days around the end of October 2026 (31 Oct and 1 Nov are a weekend)
FO_DAYS = ["2026-09-30", "2026-10-01", "2026-10-29", "2026-10-30", "2026-11-02"]


def open_periods(as_of, fo_days):
    script = (f"const b = require({json.dumps(str(DASHBOARD / 'api' / 'brokers.js'))});"
              f"process.stdout.write(JSON.stringify(b.openPeriods({json.dumps(as_of)}, {json.dumps(fo_days)})));")
    out = subprocess.run([NODE, "-e", script], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def summary(open_m_days, months=("FY 2027 November", "FY 2027 October", "FY 2027 September")):
    return {"periods": {"FY": ["FY 2027", "FY 2026"], "Q": ["Q3 FY 2027", "Q2 FY 2027"], "M": list(months)},
            "open": {"FY": {"key": "FY 2027", "days": 146, "through": "2026-11-02"},
                     "Q": {"key": "Q3 FY 2027", "days": 22, "through": "2026-11-02"},
                     "M": {"key": months[0], "days": open_m_days, "through": "2026-11-02"}}}


def page(expr, data):
    return js_eval(["BRK_MIN_OPEN_DAYS", "brkDefaultKey", "brkOpenSuffix", "brkOpenNote"],
                   f"(() => {{ globalThis.BRK = {{ summary: DATA }}; globalThis.fmtLongDate = d => d; return {expr}; }})()",
                   data)


@unittest.skipUnless(NODE, "node not installed")
class OpenPeriods(unittest.TestCase):
    def test_api_counts_days_in_the_periods_holding_the_as_of_date(self):
        out = open_periods("2026-11-02", FO_DAYS)
        self.assertEqual(out["M"], {"key": "FY 2027 November", "days": 1, "through": "2026-11-02"})
        self.assertEqual(out["Q"], {"key": "Q3 FY 2027", "days": 4, "through": "2026-11-02"})
        self.assertEqual(out["FY"], {"key": "FY 2027", "days": 5, "through": "2026-11-02"})

    def test_api_ignores_days_after_the_as_of_date(self):
        out = open_periods("2026-10-30", FO_DAYS)
        self.assertEqual(out["M"], {"key": "FY 2027 October", "days": 3, "through": "2026-10-30"})

    def test_a_month_one_day_old_is_not_the_default(self):
        self.assertEqual(page("brkDefaultKey(DATA, 'M')", summary(1)), "FY 2027 October")
        self.assertEqual(page("brkDefaultKey(DATA, 'Q')", summary(1)), "Q3 FY 2027")     # 22 days: shown
        self.assertEqual(page("brkDefaultKey(DATA, 'FY')", summary(1)), "FY 2027")

    def test_a_month_with_five_days_is_the_default(self):
        self.assertEqual(page("brkDefaultKey(DATA, 'M')", summary(5)), "FY 2027 November")

    def test_no_open_info_keeps_the_latest(self):
        data = summary(1)
        del data["open"]                                      # a cached reply from before this field
        self.assertEqual(page("brkDefaultKey(DATA, 'M')", data), "FY 2027 November")

    def test_open_periods_are_labelled_and_noted(self):
        out = page("[brkOpenSuffix('M', 'FY 2027 November'), brkOpenSuffix('Q', 'Q3 FY 2027'), "
                   "brkOpenSuffix('M', 'FY 2027 October'), brkOpenNote('M', 'FY 2027 November'), "
                   "brkOpenNote('M', 'FY 2027 October')]", summary(1))
        self.assertEqual(out[:3], [" (1 day)", " (22 days)", ""])
        self.assertEqual(out[3], "FY 2027 November is still open: this run is as of 2026-11-02, 1 trading day into it. "
                                 "Its figures are averages over the days published so far; the periods it is compared "
                                 "with are complete.")
        self.assertIsNone(out[4])


if __name__ == "__main__":
    unittest.main()
