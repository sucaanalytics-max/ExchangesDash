"""Calculation helpers behind the redesigned dashboard tabs (app.js), run in Node.

The Revenue Predictor's NSE path must reproduce scripts/nse_pipeline.py's ratio
model, BSE's valuation must keep the Excel "Annual Predictor" formulas, and the
Live tab's archive scoring must read the history file as live_common writes it."""

import json
import unittest

from helpers import NODE, ROOT, js_eval

import nse_pipeline as nse

PREDICTOR_JS = ["PREDICTOR_SEGMENTS", "predictorScenario"]
VALUATION_JS = ["valuationScenario", "valuationFromAdr"]
LIVE_JS = ["INTRADAY_CHECKPOINTS", "SESSION_MINUTES", "dayFractionAt", "quantile", "revenueAt",
           "liveModelError", "shareOfDayError"]


def _nse_pnl():
    return json.loads((ROOT / "dashboard" / "data" / "nse_dashboard_data.json").read_text()).get("pnl") or []


@unittest.skipUnless(NODE, "node not installed")
class PredictorMirrorsPipeline(unittest.TestCase):
    """Base scenario = scripts/nse_pipeline.py compute_predicted_quarters, line for line."""

    def test_nse_scenario_matches_ratio_model(self):
        hist = _nse_pnl()
        model = nse.nse_ratio_model(hist)
        if not model:
            self.skipTest("committed nse_pnl has no two actual quarters with a revenue split")
        txn = 3500.0
        py = nse.compute_predicted_quarters({"transaction_rev_extrapolated": txn}, hist,
                                            [{"quarter": "Q3 FY 2027", "days": 11, "total_rev": 620.0}])["Q3 FY 2027"]
        # 11 sessions banked (₹620 Cr), 51 left at a daily rate that lands the quarter on `txn`
        rest_adr = (txn - 620.0) / 51
        ctx = {"segs": ["opt", "fut", "cash"], "n": 11, "banked": {"opt": 500.0, "fut": 40.0, "cash": 80.0}}
        v = {"opt": rest_adr * 0.8, "fut": rest_adr * 0.05, "cash": rest_adr * 0.15, "days": 62,
             "oor": model["other_operating_revenue_ratio"] * 100, "oi": model["non_operating_income_ratio"] * 100,
             "opex": model["operating_expense_ratio"] * 100, "dep": model["depreciation_ratio"] * 100,
             "assoc": model["share_profit_associates"], "tax": model["tax_rate"] * 100,
             "shares": 1 / model["eps_per_pat"]}
        js = js_eval(PREDICTOR_JS, "predictorScenario('nse', DATA.ctx, DATA.v)", {"ctx": ctx, "v": v})
        self.assertAlmostEqual(js["txn"], txn, places=6)
        pairs = {"op": "operating_revenue", "oi": "non_operating_income", "total": "total_revenue",
                 "opx": "operating_expenses", "ebitda": "operating_ebitda", "dep": "depreciation",
                 "pbt": "pbt", "tax": "income_tax", "pat": "pat", "eps": "eps"}
        for k, pk in pairs.items():
            with self.subTest(line=k):
                self.assertAlmostEqual(js[k], py[pk], delta=0.011)

    def test_base_rate_is_the_extrapolation(self):
        # Rest-of-quarter rate = quarter-to-date average → banked + avg × left = avg × all sessions
        ctx = {"segs": ["opt", "fut"], "n": 11, "banked": {"opt": 106.6, "fut": 23.3}}
        v = {"opt": 106.6 / 11, "fut": 23.3 / 11, "days": 62}
        js = js_eval(PREDICTOR_JS, "predictorScenario('mcx', DATA.ctx, DATA.v)", {"ctx": ctx, "v": v})
        self.assertAlmostEqual(js["txn"], (106.6 + 23.3) / 11 * 62, places=6)
        self.assertEqual(js["rest"], 51)
        self.assertNotIn("pat", js)   # MCX stops at revenue

    def test_bse_excel_quarterly_model(self):
        ctx = {"segs": ["opt", "fut", "cash"], "n": 11, "banked": {"opt": 253.3, "fut": 0, "cash": 15.1}}
        v = {"opt": 23.0, "fut": 0, "cash": 1.4, "days": 62, "oiQ": 472.16, "margin": 50, "shares": 40.73}
        js = js_eval(PREDICTOR_JS, "predictorScenario('bse', DATA.ctx, DATA.v)", {"ctx": ctx, "v": v})
        txn = 253.3 + 15.1 + (23.0 + 1.4) * 51
        self.assertAlmostEqual(js["total"], txn + 472.16, places=6)
        self.assertAlmostEqual(js["pat"], (txn + 472.16) * 0.5, places=6)
        self.assertAlmostEqual(js["eps"], (txn + 472.16) * 0.5 / 40.73, places=6)


@unittest.skipUnless(NODE, "node not installed")
class ValuationModel(unittest.TestCase):
    CTX = {"elapsed": 136, "revToDate": 2525.0, "adr45": 17.39, "mkt": {"total45": 65.14, "share20": 0.265}}
    BSE = {"src": "mkt", "days": 247, "oiMode": "fixed", "oi": 2055.39, "margin": 52, "shares": 40.73, "disc": 18}

    def scenario(self, v, g, pe, cmp=3363):
        return js_eval(VALUATION_JS, f"valuationScenario(DATA.ctx, DATA.v, {g}, {pe}, {cmp})", {"ctx": self.CTX, "v": v})

    def test_bse_matches_excel_annual_predictor(self):
        for g, pe in ((-5, 40), (0, 45), (5, 50)):
            with self.subTest(g=g, pe=pe):
                js = self.scenario(self.BSE, g, pe)
                adr = (2525.0 + 65.14 * (1 + g / 100) * 0.265 * (247 - 136)) / 247   # Excel Method 2
                eps = (adr * 247 + 2055.39) * 0.52 / 40.73
                self.assertAlmostEqual(js["adr"], adr, places=9)
                self.assertAlmostEqual(js["fwd"], eps * pe, places=6)
                self.assertAlmostEqual(js["now"], eps * pe / 1.18, places=6)
                self.assertAlmostEqual(js["upNow"], eps * pe / 1.18 / 3363 - 1, places=9)

    def test_fy_projection_uses_trailing_average(self):
        js = self.scenario({**self.BSE, "src": "proj"}, 0, 45)
        self.assertAlmostEqual(js["adr"], (2525.0 + 17.39 * 111) / 247, places=9)

    def test_other_income_as_share_of_total(self):
        v = {**self.BSE, "oiMode": "pct", "oi": 30}
        js = js_eval(VALUATION_JS, "valuationFromAdr(50, DATA.v, 35, null)", {"v": v})
        self.assertAlmostEqual(js["oi"] / js["total"], 0.30, places=9)
        self.assertIsNone(js["upFwd"])   # no CMP, no upside

    def test_saved_inputs_carry_over(self):
        expr = """(() => {
          const store = {
            'quickValuation_bse_v1': JSON.stringify({ patMarginPct: 50, otherIncomeCr: 2100, peBear: 38, peBase: 44, peBull: 52 }),
            'bseValuationAssumptions_v1': JSON.stringify({ adrGrowthBearPct: -8, discountPct: 15, sharesOutstandingCr: 40.6 }),
          };
          globalThis.localStorage = { getItem: k => (k in store ? store[k] : null) };
          const migrated = loadValuationInputs('bse');
          store['valuation_bse_v2'] = JSON.stringify({ pe1: 47 });
          return { migrated, saved: loadValuationInputs('bse') };
        })()"""
        js = js_eval(["SHARES_OUTSTANDING_CR", "VALUATION_DEFAULTS", "valuationStorageKey", "loadValuationInputs"], expr)
        m = js["migrated"]
        self.assertEqual((m["margin"], m["oi"], m["pe0"], m["pe1"], m["pe2"]), (50, 2100, 38, 44, 52))
        self.assertEqual((m["g0"], m["g1"], m["disc"], m["shares"]), (-8, 0, 15, 40.6))
        # Once saved under the new key, only that is read (plus defaults)
        self.assertEqual((js["saved"]["pe1"], js["saved"]["margin"], js["saved"]["disc"]), (47, 52, 18))


def _day(eod, revs, preds=None):
    cps = {}
    for i, label in enumerate(["10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00"]):
        cps[label] = {"revenue": revs[i], "fraction": revs[i] / eod}
        if preds and label in preds:
            cps[label]["predicted_eod"] = preds[label]
    return {"date": "2026-10-15", "day_type": "normal", "eod_revenue": eod, "checkpoints": cps}


@unittest.skipUnless(NODE, "node not installed")
class LiveArchiveScoring(unittest.TestCase):
    DAY = _day(50.0, [10, 18, 25, 31, 38, 45, 50], {"12:00": 55.0})

    def test_fraction_interpolates_between_checkpoints(self):
        js = js_eval(LIVE_JS, "[dayFractionAt(DATA, 0), dayFractionAt(DATA, 75), dayFractionAt(DATA, 405)]", self.DAY)
        self.assertEqual(js[0], 0)
        self.assertAlmostEqual(js[1], (10 + 8 * 30 / 60) / 50, places=9)   # halfway 10:00 → 11:00
        self.assertEqual(js[2], 1)

    def test_missing_checkpoint_gives_no_fraction(self):
        d = json.loads(json.dumps(self.DAY))
        d["checkpoints"]["13:00"]["fraction"] = None
        self.assertIsNone(js_eval(LIVE_JS, "dayFractionAt(DATA, 300)", d))

    def test_model_and_share_of_day_errors(self):
        others = [_day(40.0, [8, 15, 20, 25, 30, 36, 40]), _day(60.0, [12, 21, 30, 37, 45, 54, 60])]
        js = js_eval(LIVE_JS, "[liveModelError(DATA.d, '12:00'), liveModelError(DATA.d, '14:00'), shareOfDayError(DATA.d, '12:00', DATA.o)]",
                     {"d": self.DAY, "o": others})
        self.assertAlmostEqual(js[0], 55 / 50 - 1, places=9)
        self.assertIsNone(js[1])                                      # no prediction recorded at 14:00
        self.assertAlmostEqual(js[2], (25 / 0.5) / 50 - 1, places=9)  # both others at 50 % by 12:00

    def test_revenue_between_polls(self):
        polls = [{"elapsed_minutes": 30, "total_revenue": 6}, {"elapsed_minutes": 90, "total_revenue": 18}]
        js = js_eval(LIVE_JS, "[revenueAt(DATA, 15), revenueAt(DATA, 60), revenueAt(DATA, 120)]", polls)
        self.assertEqual(js, [3, 12, None])


@unittest.skipUnless(NODE, "node not installed")
class QuarterLabels(unittest.TestCase):
    def test_shift_and_short_range(self):
        js = js_eval(["shiftQuarter", "shortQuarterRange"],
                     "[shiftQuarter('Q3 FY 2027', -1), shiftQuarter('Q1 FY 2027', -1), shiftQuarter('Q3 FY 2027', -4), shiftQuarter('Q4 FY 2027', 1),"
                     " shortQuarterRange(['Q2 FY 2026', 'Q3 FY 2026']), shortQuarterRange(['Q4 FY 2026', 'Q1 FY 2027']), shortQuarterRange(['Q3 FY 2026'])]")
        self.assertEqual(js, ["Q2 FY 2027", "Q4 FY 2026", "Q3 FY 2026", "Q1 FY 2028",
                              "Q2–Q3 FY26", "Q4 FY26–Q1 FY27", "Q3 FY26"])


if __name__ == "__main__":
    unittest.main()
