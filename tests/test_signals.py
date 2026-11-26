"""Results Signals tab (dashboard/js/24-signals.js), run in Node.

Each measure's daily series (NSE+BSE summed on the dates both have, modelled
MCX rows and unpublished counts left out), a quarter's daily average against
the quarter before's, the running average by session, quarter labels across
the FY boundary, and which quarter the tab opens on in results season."""

import unittest

from helpers import NODE, js_eval

SIG_JS = ["SIG_MEASURES", "SIG_SEASON_SESSIONS", "sigPrevQuarter", "sigQuarterEnd", "sigSeries",
          "sigQuarterChange", "sigRunning", "sigDefaultBasis"]


def row(date, quarter, **fields):
    return {"date": date, "fy_quarter": quarter, **fields}


@unittest.skipUnless(NODE, "needs node")
class Quarters(unittest.TestCase):
    def test_previous_quarter_across_the_fy_boundary(self):
        self.assertEqual(js_eval(SIG_JS, "['Q3 FY 2027', 'Q1 FY 2027', 'Q4 FY 2026', 'Sep 2026'].map(sigPrevQuarter)"),
                         ["Q2 FY 2027", "Q4 FY 2026", "Q3 FY 2026", None])

    def test_quarter_end(self):
        self.assertEqual(js_eval(SIG_JS, "['Q1 FY 2027', 'Q2 FY 2027', 'Q3 FY 2027', 'Q4 FY 2027'].map(sigQuarterEnd)"),
                         ["2026-06-30", "2026-09-30", "2026-12-31", "2027-03-31"])

    def test_results_season_opens_on_the_completed_quarter(self):
        self.assertEqual(js_eval(SIG_JS, "[0, 29, 30, 60].map(sigDefaultBasis)"),
                         ["completed", "completed", "current", "current"])


@unittest.skipUnless(NODE, "needs node")
class Series(unittest.TestCase):
    ROWS = {
        "nse": [row("2026-09-29", "Q2 FY 2027", total_rev=60, cash_trades=40_000_000),
                row("2026-09-30", "Q2 FY 2027", total_rev=62, cash_trades=None),     # count not published
                row("2026-10-01", "Q3 FY 2027", total_rev=80, cash_trades=45_000_000),
                row("2026-10-03", "Q3 FY 2027", total_rev=90, cash_trades=46_000_000)],  # BSE has no 3 Oct row
        "bse": [row("2026-09-29", "Q2 FY 2027", total_rev=20),
                row("2026-09-30", "Q2 FY 2027", total_rev=22),
                row("2026-10-01", "Q3 FY 2027", total_rev=30)],
        "mcx": [row("2026-09-30", "Q2 FY 2027", total_rev=10, modelled=True),
                row("2026-10-01", "Q3 FY 2027", total_rev=12, modelled=False)],
    }

    def series(self, measure):
        return js_eval(SIG_JS, f"sigSeries(DATA, '{measure}')", self.ROWS)

    def test_two_exchanges_sum_on_dates_both_have(self):
        self.assertEqual(self.series("adr"), [
            {"date": "2026-09-29", "quarter": "Q2 FY 2027", "value": 80},
            {"date": "2026-09-30", "quarter": "Q2 FY 2027", "value": 84},
            {"date": "2026-10-01", "quarter": "Q3 FY 2027", "value": 110},
        ])

    def test_modelled_rows_and_unpublished_counts_are_left_out(self):
        self.assertEqual([r["date"] for r in self.series("mcx")], ["2026-10-01"])
        self.assertEqual([r["date"] for r in self.series("cash")], ["2026-09-29", "2026-10-01", "2026-10-03"])


@unittest.skipUnless(NODE, "needs node")
class QuarterChange(unittest.TestCase):
    SERIES = [{"date": "2026-09-29", "quarter": "Q2 FY 2027", "value": 80},
              {"date": "2026-09-30", "quarter": "Q2 FY 2027", "value": 100},
              {"date": "2026-10-01", "quarter": "Q3 FY 2027", "value": 99},
              {"date": "2026-10-03", "quarter": "Q3 FY 2027", "value": 117}]

    def test_daily_average_against_the_quarter_before(self):
        qc = js_eval(SIG_JS, "sigQuarterChange(DATA, 'Q3 FY 2027')", self.SERIES)
        self.assertEqual({k: qc[k] for k in ("quarter", "prev", "days", "prevDays", "avg", "prevAvg", "from", "to")},
                         {"quarter": "Q3 FY 2027", "prev": "Q2 FY 2027", "days": 2, "prevDays": 2,
                          "avg": 108, "prevAvg": 90, "from": "2026-10-01", "to": "2026-10-03"})
        self.assertAlmostEqual(qc["chg"], 0.2)

    def test_no_sessions_or_no_previous_quarter(self):
        self.assertIsNone(js_eval(SIG_JS, "sigQuarterChange(DATA, 'Q4 FY 2027')", self.SERIES))
        qc = js_eval(SIG_JS, "sigQuarterChange(DATA, 'Q2 FY 2027')", self.SERIES)
        self.assertEqual((qc["prevDays"], qc["prevAvg"], qc["chg"]), (0, None, None))

    def test_running_average_by_session(self):
        out = js_eval(SIG_JS, "sigRunning(DATA, sigQuarterChange(DATA, 'Q3 FY 2027'))", self.SERIES)
        self.assertEqual([(r["session"], r["date"]) for r in out], [(1, "2026-10-01"), (2, "2026-10-03")])
        self.assertAlmostEqual(out[0]["chg"], 0.1)
        self.assertAlmostEqual(out[1]["chg"], 0.2)
        self.assertEqual(js_eval(SIG_JS, "sigRunning(DATA, null)", self.SERIES), [])


if __name__ == "__main__":
    unittest.main()
