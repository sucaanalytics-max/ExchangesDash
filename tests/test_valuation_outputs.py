"""scripts/valuation_outputs.py: the Valuation Model tab's figures computed outside
the browser, with the dashboard's own JS (for the Excel mirror). Pinned on a small
fixture, and checked on the real data files against what the tab's target strip
(valuationTargetTiles) renders from the same inputs."""

import json
import math
import re
import unittest

from helpers import DASHBOARD, NODE, js_eval

import valuation_outputs as vo

INPUTS = {
    "fy": 2028, "discount_to_fy_end_pct": 18, "discount_to_today_pct": 9,
    "exchanges": {
        ex: {"editable": {"adr_estimate_cr": None, "qoq_growth_pct": 5, "pe": {"bear": 40, "base": 45, "bull": 50},
                          "weights_pct": {"regression": 40, "ratio": 20, "adr_model": 40}, "regression_from": None},
             "fixed": {"other_income_cr": 100, "pat_margin_pct": 50, "sessions": 250}}
        for ex in ("bse", "mcx", "nse")
    },
}


def _dates(n, start=(2026, 4, 1)):
    """n weekday dates from `start`, ISO."""
    from datetime import date, timedelta
    d, out = date(*start), []
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


def _fixture_raw():
    """60 sessions of Q2 FY 2027 at ₹10 Cr, then 30 of Q3 FY 2027 at ₹12 Cr."""
    ds = _dates(90, (2026, 7, 1))
    return {"daily_all": [{"date": d, "fy_quarter": "Q2 FY 2027" if i < 60 else "Q3 FY 2027",
                           "total_rev": 10.0 if i < 60 else 12.0} for i, d in enumerate(ds)]}


def _fixture_share():
    """200 sessions: revenue rising 5 → 15 with a wiggle, price ≈ 100 + 50 × the
    previous session's 45-day MA, so the gate passes and the fit is published."""
    ds = _dates(200, (2025, 9, 1))
    rev = [5 + 10 * i / 199 + 0.8 * math.sin(i / 3) for i in range(200)]
    ma = [None] * 200
    for i in range(44, 200):
        ma[i] = sum(rev[i - 44:i + 1]) / 45
    series = []
    for i in range(46, 200):
        series.append({"date": ds[i], "price": round(100 + 50 * ma[i - 1] + 15 * math.sin(i / 2), 2)})
    return {"ticker": "FIX.NS", "ma_window": 45, "regression_start": ds[46], "n_days": len(series),
            "regression": {"slope": 50, "intercept": 100}, "series": series,
            "revenue_daily": [{"date": d, "revenue_cr": round(r, 4)} for d, r in zip(ds, rev)],
            "latest": {"date": ds[-1], "price_actual": 800.0}}


def _collecting_share():
    return {"ticker": "NEW.NS", "status": "collecting", "n_days": 20, "min_days_required": 60,
            "series": [], "latest": {"date": "2026-11-20", "price_actual": 2000.0}}


@unittest.skipUnless(NODE, "needs node")
class Fixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        raw = _fixture_raw()
        cls.overrides = {"bse": {"pe1": 48, "w2": 60}, "nse": {"adr": 13.5, "pe9": 1, "g": -150}}
        cls.out = vo.compute(INPUTS, {"bse": raw, "mcx": raw, "nse": raw},
                             {"bse": _fixture_share(), "mcx": None, "nse": _collecting_share()}, cls.overrides)
        cls.shares = js_eval(["SHARES_OUTSTANDING_CR"], "SHARES_OUTSTANDING_CR")

    def test_effective_inputs_are_defaults_with_usable_overrides(self):
        bse = self.out["exchanges"]["bse"]["inputs"]
        self.assertEqual((bse["pe0"], bse["pe1"], bse["pe2"], bse["w2"]), (40, 48, 50, 60))
        self.assertEqual(self.out["exchanges"]["bse"]["edited"], ["pe1", "w2"])
        nse = self.out["exchanges"]["nse"]
        self.assertEqual(nse["inputs"]["adr"], 13.5)
        self.assertEqual(nse["inputs"]["g"], 5)            # −150 % is refused: the default stays
        self.assertEqual(nse["edited"], ["adr"])
        for key in ("oi", "margin", "days", "d1", "d2"):
            self.assertIn(key, nse["inputs"])
        self.assertEqual(self.out["fy"], 2028)

    def test_adr_path_and_model_by_hand(self):
        e = self.out["exchanges"]["mcx"]
        self.assertEqual(e["context"]["q_label"], "Q3 FY 2027")
        self.assertAlmostEqual(e["context"]["q_adr"], 12.0)
        self.assertAlmostEqual(e["context"]["adr45"], (15 * 10 + 30 * 12) / 45)
        path = [12 * 1.05 ** i for i in range(6)]
        self.assertEqual([p["label"] for p in e["adr_path"]["quarters"]],
                         ["Q3 FY27", "Q4 FY27", "Q1 FY28", "Q2 FY28", "Q3 FY28", "Q4 FY28"])
        for got, want in zip(e["adr_path"]["quarters"], path):
            self.assertAlmostEqual(got["adr"], want)
        adr_fy = sum(path[2:]) / 4
        self.assertEqual(e["adr_path"]["fy"], 2028)
        self.assertAlmostEqual(e["adr_path"]["adr"], adr_fy)
        m = e["adr_model"]
        shares = self.shares["mcx"]["value"]
        self.assertEqual(e["shares_cr"], shares)
        eps = (adr_fy * 250 + 100) * 0.5 / shares
        self.assertAlmostEqual(m["eps"], eps)
        for i, pe in enumerate((40, 45, 50)):
            self.assertAlmostEqual(m["fy_next_end"][i], eps * pe)
            self.assertAlmostEqual(m["fy_end"][i], eps * pe / 1.18)
            self.assertAlmostEqual(m["today"][i], eps * pe / 1.18 / 1.09)

    def test_no_share_file_leaves_only_the_adr_model(self):
        e = self.out["exchanges"]["mcx"]
        self.assertIsNone(e["fit"])
        self.assertIsNone(e["ratio"])
        self.assertIsNone(e["cmp"])
        for tri in ("dma", "est"):
            t = e[tri]
            self.assertIsNone(t["regression"])
            self.assertIsNone(t["ratio"])
            self.assertEqual(t["dropped"], ["reg", "ratio"])
            for i in range(3):
                self.assertAlmostEqual(t["avg"][i], e["adr_model"]["today"][i])
        self.assertIsNone(e["target"]["upside"])

    def test_collecting_share_file_has_cmp_but_no_fit(self):
        e = self.out["exchanges"]["nse"]
        self.assertEqual((e["cmp"], e["cmp_date"], e["cmp_live"]), (2000.0, "2026-11-20", False))
        self.assertIsNone(e["fit"])
        self.assertIn("20 of 60 sessions", e["fit_why"])
        self.assertFalse(e["est_is_dma"])
        self.assertEqual(e["est"]["adr"], 13.5)

    def test_fitted_exchange_triangulates(self):
        e = self.out["exchanges"]["bse"]
        fit = e["fit"]
        self.assertAlmostEqual(fit["slope"], 50, delta=3)
        self.assertAlmostEqual(fit["intercept"], 100, delta=40)
        self.assertGreater(fit["n"], 60)
        self.assertEqual(e["window"]["first_point"], e["window"]["fit_start"])
        self.assertEqual(e["data_from"], e["window"]["fit_start"])
        self.assertTrue(e["est_is_dma"])
        t = e["dma"]
        base = fit["intercept"] + fit["slope"] * t["adr"]
        self.assertEqual([round(x, 6) for x in t["regression"]], [round(x, 6) for x in (base - fit["se"], base, base + fit["se"])])
        r = e["ratio"]
        self.assertAlmostEqual(t["ratio"][1], r["mean"] * t["adr"])
        w = (40, 20, 60)
        for i in range(3):
            want = (w[0] * t["regression"][i] + w[1] * t["ratio"][i] + w[2] * t["adr_model"][i]) / sum(w)
            self.assertAlmostEqual(t["avg"][i], want)
        self.assertEqual(e["target"]["values"], t["avg"])
        self.assertAlmostEqual(e["target"]["upside"][1], t["avg"][1] / 800 - 1)
        self.assertEqual(t["w_total"], 120)

    def test_pinned(self):
        """The fixture's figures, so any change in the maths shows up here."""
        bse = self.out["exchanges"]["bse"]
        self.assertEqual([round(x) for x in bse["target"]["values"]], [1026, 1174, 1218])
        self.assertEqual([round(x, 2) for x in (bse["fit"]["intercept"], bse["fit"]["slope"], bse["fit"]["se"])], [99.75, 50.0, 10.74])
        self.assertEqual([round(x, 2) for x in bse["dma"]["ratio"]], [654.87, 685.83, 716.79])
        self.assertEqual(bse["fit"]["n"], 154)

    def test_output_is_json_and_carries_no_share_file(self):
        text = json.dumps(self.out)
        self.assertNotIn("revenue_daily", text)
        self.assertLess(len(text), 20000)


@unittest.skipUnless(NODE, "needs node")
class RealData(unittest.TestCase):
    """On the committed data files, the base-case target equals the figure the tab's
    strip renders from the same inputs, with and without shared overrides."""

    def check(self, overrides):
        data = vo.load_data(DASHBOARD / "data")
        out = vo.compute(data["inputs"], data["raw"], data["share"], overrides)
        html = js_eval(["valuationTargetTiles", "valuationDefaultsFrom", "valuationContextFor"], """(() => {
            const defaults = valuationDefaultsFrom(DATA.inputs);
            const list = VALUATION_EXCHANGES.map(ex => ({ ex, c: valuationContextFor(DATA.raw[ex], DATA.share[ex]), error: null }));
            return VALUATION_EXCHANGES.map(ex => valuationTargetTiles(list.filter(d => d.ex === ex), defaults, DATA.overrides, ex));
        })()""", {**data, "overrides": overrides}, closure=True)
        for ex, tile in zip(("bse", "mcx", "nse"), html):
            with self.subTest(ex=ex):
                shown = re.search(r'rx-kpi-v[^"]*">₹([\d,]+)<', tile).group(1)
                base = out["exchanges"][ex]["target"]["values"][1]
                self.assertEqual(int(shown.replace(",", "")), round(base))
                self.assertEqual(out["exchanges"][ex]["cmp"], data["share"][ex]["latest"]["price_actual"])

    def test_defaults(self):
        self.check({})

    def test_with_overrides(self):
        self.check({"bse": {"pe1": 52, "from": "2025-06-02", "adr": 30}, "mcx": {"g": 3, "w0": 50}, "nse": {"adr": 70}})


if __name__ == "__main__":
    unittest.main()
