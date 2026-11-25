"""Walk-forward backtest of the trading-logic tree (scripts/signal_tree_backtest.py): the ADR
model matches the dashboard's JS, fits use only earlier sessions, the gates and ladder, option
settlement and a futures roll on a synthetic name."""

import unittest
from datetime import date, timedelta

from helpers import NODE, js_eval

import signal_tree_backtest as bt

V = {"g": 5, "pe": [40, 45, 50], "days": 247, "oi": 2363.7, "margin": 51, "d1": 18, "d2": 9}


@unittest.skipUnless(NODE, "node not installed")
class AdrModelMatchesJs(unittest.TestCase):
    def test_path_and_targets(self):
        start = {"q": 3, "fy": 2027}
        js = js_eval(["valuationAdrPath", "valuationAdrModel"],
                     "(() => { const p = valuationAdrPath(DATA.start, 21.4, 5);"
                     " const m = valuationAdrModel({days: 247, oi: 2363.7, margin: 51, pe0: 40, pe1: 45, pe2: 50,"
                     " d1: 18, d2: 9}, p.adr, 40.79); return [p.adr, m.now]; })()", {"start": start})
        adr = bt.adr_path_fy(start, 21.4, 5)
        self.assertAlmostEqual(adr, js[0], places=9)
        for a, b in zip(bt.adr_model_now(adr, V, 40.79), js[1]):
            self.assertAlmostEqual(a, b, places=6)


def weekdays(start, n):
    d, out = date.fromisoformat(start), []
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


class Signals(unittest.TestCase):
    def setUp(self):
        self.days = weekdays("2025-01-01", 200)
        self.revenue = [(d, 10.0 + (i % 7) * 0.5) for i, d in enumerate(self.days)]
        self.prices = {d: 1000.0 + i for i, d in enumerate(self.days)}

    def test_no_look_ahead(self):
        a = bt.daily_signals(self.prices, self.revenue, V, 40.0, "2025-01-01")
        t = a[100]["date"]
        later_p = {d: (p * 3 if d >= t else p) for d, p in self.prices.items()}
        later_r = [(d, x * 5 if d >= t else x) for d, x in self.revenue]
        b = bt.daily_signals(later_p, later_r, V, 40.0, "2025-01-01")
        sa, sb = a[100], next(s for s in b if s["date"] == t)
        for k in ("adr45", "short_10d", "ratio", "reg", "n_fit"):
            self.assertEqual(sa[k], sb[k], k)

    def test_ma_lags_one_session_and_fit_needs_min_rows(self):
        sig = bt.daily_signals(self.prices, self.revenue, V, 40.0, "2025-01-01")
        first = sig[0]
        self.assertEqual(first["date"], self.days[bt.MA_WINDOW])     # MA of the 45 sessions before it
        self.assertAlmostEqual(first["adr45"], sum(x for _, x in self.revenue[:45]) / 45)
        self.assertIsNone(first["ratio"])
        self.assertEqual(sig[bt.MIN_FIT]["n_fit"], bt.MIN_FIT)
        self.assertIsNotNone(sig[bt.MIN_FIT]["ratio"])

    def test_two_whole_weeks(self):
        rd = weekdays("2026-11-02", 15)                               # Mon 2 Nov – Fri 20 Nov
        rv = [1.0] * 5 + [2.0] * 5 + [4.0] * 5
        # Thursday 19 Nov: the two whole weeks before its week are 2–6 and 9–13 Nov
        self.assertEqual(bt.two_whole_weeks(rd, rv, "2026-11-19"), 1.5)


class Tree(unittest.TestCase):
    def sig(self, price, short, reg_base=None):
        return {"date": "2026-11-20", "price": price, "adr45": 10.0, "short_10d": short, "short_2w": short,
                "ratio": [900.0, 1000.0, 1100.0], "reg": [reg_base - 50, reg_base, reg_base + 50] if reg_base else None,
                "adr_model": [800.0, 1200.0, 1400.0]}

    def test_gates(self):
        cfg = bt.Config("10d", 0.10, "ratio", "rising")
        g1, g2, g3, over, down, _ = bt.gates(self.sig(950, 11.5), cfg)
        self.assertEqual((g1, g2, g3, over, down), (True, True, True, False, False))
        self.assertFalse(bt.gates(self.sig(950, 10.5), cfg)[0])
        self.assertTrue(bt.gates(self.sig(950, 9.5), bt.Config("10d", 0.10, "ratio", "not_falling"))[0])
        # AND with the regression below the price fails; OR passes
        self.assertFalse(bt.gates(self.sig(950, 11.5, reg_base=900), bt.Config("10d", 0.10, "and", "rising"))[1])
        self.assertTrue(bt.gates(self.sig(1020, 11.5, reg_base=1100), bt.Config("10d", 0.10, "or", "rising"))[1])
        # 30 % override up to mean + 0.5σ
        self.assertTrue(bt.gates(self.sig(1040, 13.5), cfg)[3])
        self.assertFalse(bt.gates(self.sig(1060, 13.5), cfg)[3])

    def test_ladder(self):
        r = [900, 1000, 1100]
        self.assertEqual([bt.ladder(p, r) for p in (880, 950, 1020, 1080, 1120)],
                         ["bear", "bear-base", "base", "base-bull", "bull"])


class Simulate(unittest.TestCase):
    """One name over four days: a put sold at bear–base expires out of the money, then a futures
    long at bear is rolled at expiry and marked to the end."""

    def test_put_and_roll(self):
        days = ["2026-10-01", "2026-10-27", "2026-10-28", "2026-10-30"]
        prices = [960.0, 980.0, 880.0, 920.0]
        sig = [{"date": d, "price": p, "adr45": 10.0, "short_10d": 11.5, "short_2w": 11.5,
                "ratio": [900.0, 1000.0, 1100.0], "reg": None, "adr_model": [800.0, 1200.0, 1400.0]}
               for d, p in zip(days, prices)]
        # Raw prices are half the adjusted ones (a 2:1 bonus later): factor 2
        opts = {
            "2026-10-01": {"und": 480.0, "fut": [("2026-10-27", 482.0), ("2026-11-24", 485.0)],
                           "PE": {"2026-10-27": [(470.0, 6.0, 10), (460.0, 4.0, 10)]}, "CE": {}},
            "2026-10-27": {"und": 490.0, "fut": [("2026-10-27", 490.0), ("2026-11-24", 492.0)], "PE": {}, "CE": {}},
            "2026-10-28": {"und": 440.0, "fut": [("2026-11-24", 441.0)], "PE": {}, "CE": {}},
            "2026-10-30": {"und": 460.0, "fut": [("2026-11-24", 462.0)], "PE": {}, "CE": {}},
        }
        trades = bt.simulate(sig, opts, bt.Config("10d", 0.10, "ratio", "rising"), "X")
        put = next(t for t in trades if t["leg"] == "put sold")
        # target = min(bear–base mid 950, price 960) / 2 = 475 → strike 470, premium 6 on 480
        self.assertEqual((put["strike"], put["premium"], put["expiry"]), (470.0, 6.0, "2026-10-27"))
        self.assertAlmostEqual(put["ret_pct"], 6 / 480 * 100, places=3)
        fut = next(t for t in trades if t["leg"] == "futures long")
        self.assertEqual(fut["entry_date"], "2026-10-28")
        self.assertTrue(fut["open"])
        # entered at 441 × 2 = 882, marked at 462 × 2 = 924
        self.assertAlmostEqual(fut["ret_pct"], (924 - 882) / 882 * 100, places=3)


if __name__ == "__main__":
    unittest.main()
