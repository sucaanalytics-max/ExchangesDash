"""Contracts vs ADR chart on the Regression tab (dashboard/js/13-regression.js), run in Node.

contractsAdrSeries pairs each NSE / BSE session's F&O contracts (crore, from
contractsDailyRows in 23-contracts-view.js) with its revenue at today's rates
(total, or F&O only), keeps the sessions that have both, and takes trailing
N-session means. Sessions before `from` (the chart's own start, CADR_START) are
the MAs' lead-in only, and `anchor` starts every window on the same session.
Revenue per contract is the revenue MA ÷ the contracts MA. indexTo100 rebases
each line to its first point; contractsAdrPeriod words the window and says why a
series is empty."""

import re
import unittest
from pathlib import Path
from datetime import date, timedelta

from helpers import NODE, js_eval

CADR_JS = ["CONTRACTS_PER_CRORE", "contractsNum", "contractsDailyRows", "contractsAdrSeries", "indexTo100",
           "rxDate", "contractsAdrPeriod", "CADR_START", "CADR_EVENTS", "contractsAdrPerLabel"]
CR = 1e7
ROOT = Path(__file__).resolve().parent.parent


def weekdays(start, n):
    d, out = date.fromisoformat(start), []
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


def nse_rows(n, start="2024-12-02"):
    """NSE rows: contracts (crore) = 10 + i split over the four fields, total_rev = 2 * (10 + i) + 1."""
    out = []
    for i, d in enumerate(weekdays(start, n)):
        c = (10 + i) * CR
        out.append({"date": d, "io_contracts": c * 0.7, "so_contracts": c * 0.2, "if_contracts": c * 0.06,
                    "sf_contracts": c * 0.04, "total_contracts": 999 * CR,   # NSE ignores total_contracts
                    "total_rev": 2 * (10 + i) + 1, "opt_rev": 2 * (10 + i), "fut_rev": 0.5, "cash_rev": 0.5})
    return out


def bse_rows(n, start="2024-12-02"):
    out = []
    for i, d in enumerate(weekdays(start, n)):
        out.append({"date": d, "total_contracts": (5 + i) * CR, "total_rev": 3 + i, "opt_rev": 2 + i,
                    "fut_rev": 0.0, "cash_rev": 1.0})
    return out


def series(rows, ex, **opts):
    return js_eval(CADR_JS, "contractsAdrSeries(DATA.rows, DATA.ex, DATA.opts)", {"rows": rows, "ex": ex, "opts": opts})


def mean(xs):
    return sum(xs) / len(xs)


@unittest.skipUnless(NODE, "node not installed")
class ContractsAdrSeriesTest(unittest.TestCase):
    def test_trailing_means_with_lead_in_before_from(self):
        rows = nse_rows(30)
        frm = rows[10]["date"]
        out = series(rows, "nse", **{"from": frm, "window": 5, "revenue": "total"})
        # The line starts at `from`: its first MA reaches back 4 sessions before it
        self.assertEqual(out[0]["date"], frm)
        self.assertEqual([p["date"] for p in out], [r["date"] for r in rows[10:]])
        first = out[0]
        self.assertAlmostEqual(first["contracts"], mean([10 + i for i in range(6, 11)]))
        self.assertAlmostEqual(first["adr"], mean([2 * (10 + i) + 1 for i in range(6, 11)]))
        self.assertAlmostEqual(first["perContract"], first["adr"] / first["contracts"])
        last = out[-1]
        self.assertAlmostEqual(last["contracts"], mean([10 + i for i in range(25, 30)]))
        self.assertAlmostEqual(last["adr"], mean([2 * (10 + i) + 1 for i in range(25, 30)]))

    def test_no_from_starts_at_the_nth_session(self):
        rows = nse_rows(12)
        out = series(rows, "nse", **{"from": None, "window": 5, "revenue": "total"})
        self.assertEqual(out[0]["date"], rows[4]["date"])
        self.assertEqual(len(out), 8)
        self.assertAlmostEqual(out[0]["contracts"], mean([10, 11, 12, 13, 14]))

    def test_anchor_starts_every_window_on_the_same_session(self):
        rows = nse_rows(30)
        outs = {w: series(rows, "nse", **{"from": None, "window": w, "revenue": "total", "anchor": 8}) for w in (2, 5, 8)}
        for w, out in outs.items():
            self.assertEqual(out[0]["date"], rows[7]["date"], w)
            self.assertEqual(len(out), 23, w)
        # Each window still averages its own sessions
        self.assertAlmostEqual(outs[2][0]["contracts"], mean([16, 17]))
        self.assertAlmostEqual(outs[8][0]["contracts"], mean(range(10, 18)))

    def test_from_after_the_anchor_wins(self):
        rows = nse_rows(30)
        out = series(rows, "nse", **{"from": rows[12]["date"], "window": 3, "revenue": "total", "anchor": 8})
        self.assertEqual(out[0]["date"], rows[12]["date"])

    def test_unsorted_rows_are_ordered_by_date(self):
        rows = nse_rows(12)
        out = series(list(reversed(rows)), "nse", **{"from": None, "window": 5, "revenue": "total"})
        self.assertEqual([p["date"] for p in out], [r["date"] for r in rows[4:]])

    def test_days_without_contracts_are_dropped_not_zero(self):
        rows = bse_rows(12)
        for r in rows[2:4]:
            r["total_contracts"] = None
        rows[5].pop("total_contracts")
        out = series(rows, "bse", **{"from": None, "window": 3, "revenue": "total"})
        kept = [r for i, r in enumerate(rows) if i not in (2, 3, 5)]
        self.assertEqual([p["date"] for p in out], [r["date"] for r in kept[2:]])
        # The first window is sessions 0, 1, 4: the gap days are skipped, not averaged in as 0
        self.assertAlmostEqual(out[0]["contracts"], mean([5, 6, 9]))
        self.assertAlmostEqual(out[0]["adr"], mean([3, 4, 7]))

    def test_days_without_revenue_are_dropped(self):
        rows = bse_rows(8)
        rows[3]["total_rev"] = None
        out = series(rows, "bse", **{"from": None, "window": 3, "revenue": "total"})
        self.assertNotIn(rows[3]["date"], [p["date"] for p in out])
        self.assertAlmostEqual(out[1]["contracts"], mean([6, 7, 9]))

    def test_bse_uses_total_contracts(self):
        rows = bse_rows(6)
        out = series(rows, "bse", **{"from": None, "window": 2, "revenue": "total"})
        self.assertAlmostEqual(out[0]["contracts"], mean([5, 6]))
        self.assertAlmostEqual(out[-1]["contracts"], mean([9, 10]))

    def test_nse_sums_the_four_contract_fields(self):
        rows = nse_rows(4)
        rows[0]["sf_contracts"] = None   # one field missing: no contract figure that day
        out = series(rows, "nse", **{"from": None, "window": 1, "revenue": "total"})
        self.assertEqual([p["date"] for p in out], [r["date"] for r in rows[1:]])
        self.assertAlmostEqual(out[0]["contracts"], 11)   # 0.7 + 0.2 + 0.06 + 0.04 of 11 Cr, not total_contracts

    def test_fo_revenue_mode(self):
        rows = nse_rows(6)
        tot = series(rows, "nse", **{"from": None, "window": 2, "revenue": "total"})
        fo = series(rows, "nse", **{"from": None, "window": 2, "revenue": "fo"})
        self.assertAlmostEqual(fo[0]["adr"], mean([2 * 10 + 0.5, 2 * 11 + 0.5]))
        self.assertAlmostEqual(tot[0]["adr"] - fo[0]["adr"], 0.5)   # cash left out
        self.assertAlmostEqual(fo[0]["perContract"], fo[0]["adr"] / fo[0]["contracts"])
        self.assertEqual(fo[0]["contracts"], tot[0]["contracts"])

    def test_other_exchanges_and_empty_input(self):
        self.assertEqual(series(bse_rows(5), "mcx", **{"from": None, "window": 2, "revenue": "total"}), [])
        self.assertEqual(series([], "nse", **{"from": None, "window": 2, "revenue": "total"}), [])


@unittest.skipUnless(NODE, "node not installed")
class IndexTo100Test(unittest.TestCase):
    def test_first_point_100_and_ratios_preserved(self):
        s = [{"date": "a", "x": 4, "y": 50, "z": 7}, {"date": "b", "x": 5, "y": 40, "z": 8}, {"date": "c", "x": 8, "y": 75, "z": 9}]
        out = js_eval(CADR_JS, "indexTo100(DATA, ['x', 'y'])", s)
        self.assertEqual([p["date"] for p in out], ["a", "b", "c"])
        self.assertEqual((out[0]["x"], out[0]["y"]), (100, 100))
        self.assertAlmostEqual(out[1]["x"], 125)
        self.assertAlmostEqual(out[2]["y"], 150)
        self.assertAlmostEqual(out[2]["x"] / out[1]["x"], 8 / 5)
        self.assertEqual(out[2]["z"], 9)            # keys not listed are copied as they are
        self.assertEqual(s[1]["x"], 5)              # the input is left alone

    def test_zero_or_missing_base_gives_null(self):
        out = js_eval(CADR_JS, "indexTo100(DATA, ['x'])", [{"x": 0}, {"x": 3}])
        self.assertEqual([p["x"] for p in out], [None, None])
        self.assertEqual(js_eval(CADR_JS, "indexTo100([], ['x'])"), [])


@unittest.skipUnless(NODE, "node not installed")
class StartTest(unittest.TestCase):
    def test_nse_has_no_start(self):
        self.assertIsNone(js_eval(CADR_JS, "CADR_START.nse.from"))

    def test_bse_starts_where_its_share_regression_does(self):
        src = (ROOT / "scripts" / "bse_share_analysis.py").read_text()
        reg_start = re.search(r'^REGRESSION_START\s*=\s*"([0-9-]+)"', src, re.M).group(1)
        self.assertEqual(js_eval(CADR_JS, "CADR_START.bse.from"), reg_start)

    def test_neither_reads_the_valuation_inputs(self):
        src = (ROOT / "dashboard" / "js" / "13-regression.js").read_text()
        body = src[src.index("function buildContractsAdr"):]
        for name in ("loadValuationDefaults", "readValuationOverrides", "valuationInputsFor"):
            self.assertNotIn(name, body)


@unittest.skipUnless(NODE, "node not installed")
class ContractSizeTest(unittest.TestCase):
    def test_per_contract_label_names_what_is_divided(self):
        self.assertEqual(js_eval(CADR_JS, "contractsAdrPerLabel('total')"), "Total revenue per F&O contract")
        self.assertEqual(js_eval(CADR_JS, "contractsAdrPerLabel('fo')"), "F&O revenue per contract")

    def test_events_are_nse_only_and_dated(self):
        ev = js_eval(CADR_JS, "CADR_EVENTS")
        self.assertEqual([e["date"] for e in ev["nse"]], ["2024-11-20", "2025-12-31"])
        self.assertEqual(ev["bse"], [])
        for e in ev["nse"]:
            self.assertTrue(e["short"] and e["text"])

    def test_nse_notional_per_index_option_steps_at_the_events(self):
        """The marked dates are where NSE's own file shows the contract size moving."""
        import json
        rows = json.loads((ROOT / "dashboard" / "data" / "nse_dashboard_data.json").read_text())["daily_all"]
        def size(a, b):
            r = [x["io_notional"] / x["io_contracts"] for x in rows
                 if a <= x["date"] <= b and x.get("io_contracts") and x.get("io_notional")]
            return sum(r) / len(r) if r else None
        before, after = size("2024-10-01", "2024-11-19"), size("2025-01-02", "2025-02-28")
        if before and after:
            self.assertGreater(after / before, 1.8)   # about doubled once the old monthly contracts expired
        before, after = size("2025-12-01", "2025-12-30"), size("2025-12-31", "2026-01-31")
        if before and after:
            self.assertLess(after / before, 0.92)     # lot sizes cut


@unittest.skipUnless(NODE, "node not installed")
class PeriodTest(unittest.TestCase):
    def run_period(self, rows, ex, frm, window=5, note=""):
        return js_eval(CADR_JS, """(() => {
          const s = contractsAdrSeries(DATA.rows, DATA.ex, { from: DATA.from, window: DATA.w, revenue: 'total' });
          return { s, p: contractsAdrPeriod(DATA.rows, { from: DATA.from, note: DATA.note }, s, DATA.w) };
        })()""", {"rows": rows, "ex": ex, "from": frm, "w": window, "note": note})

    def test_null_from_gives_full_history(self):
        rows = nse_rows(30, start="2023-04-03")
        out = self.run_period(rows, "nse", None)
        self.assertEqual(out["s"][0]["date"], rows[4]["date"])
        self.assertEqual(out["s"][-1]["date"], rows[-1]["date"])
        # The line starts after the averages' lead-in, and says so
        self.assertEqual(out["p"]["text"], "all trading history; the averages start on 7 Apr 2023, the index base")
        self.assertEqual(out["p"]["message"], "")

    def test_series_from_the_first_day_says_since(self):
        rows = nse_rows(3, start="2023-04-03")
        out = js_eval(CADR_JS, "contractsAdrPeriod(DATA, CADR_START.nse, [{ date: '2023-04-03' }], 1).text", rows)
        self.assertEqual(out, "all trading history since 3 Apr 2023")

    def test_from_clips_the_start(self):
        rows = bse_rows(40)
        frm = "2025-01-01"
        out = self.run_period(rows, "bse", frm, note="why")
        self.assertEqual(out["s"][0]["date"], "2025-01-01")
        self.assertTrue(all(p["date"] >= frm for p in out["s"]))
        self.assertEqual(out["p"]["text"], "from 1 Jan 2025 (why)")
        self.assertEqual(out["p"]["message"], "")

    def test_the_real_starts_word_the_window(self):
        rows = bse_rows(400, start="2024-01-01")
        out = js_eval(CADR_JS, "contractsAdrPeriod(DATA, CADR_START.bse, [{}], 45).text", rows)
        self.assertTrue(out.startswith("from 1 Mar 2025 (the share-price regression's start"), out)

    def test_from_beyond_the_data_gives_empty_series_and_message(self):
        rows = bse_rows(20)
        out = self.run_period(rows, "bse", "2027-01-01")
        self.assertEqual(out["s"], [])
        self.assertIn("1 Jan 2027", out["p"]["message"])
        self.assertIn("ends on", out["p"]["message"])
        self.assertNotIn("Valuation Inputs", out["p"]["message"])

    def test_too_few_sessions_message(self):
        out = self.run_period(bse_rows(3), "bse", None, window=45)
        self.assertEqual(out["s"], [])
        self.assertIn("45", out["p"]["message"])


if __name__ == "__main__":
    unittest.main()
