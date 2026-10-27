"""Calculation helpers behind the redesigned dashboard tabs (dashboard/js), run in Node.

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
LIVE_CARD_JS = LIVE_JS + ["liveDefaultType", "liveDayPool", "typicalPathRange", "liveCardModel",
                          "intradayMethodLabel", "sessionClock", "SEG_PRODUCT", "NO_FLAGS", "periodFlags"]


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

    def test_session_progress_stops_at_the_close(self):
        got = js_eval(LIVE_JS + ["fmtElapsed", "fmtSessionProgress"],
                      "[fmtSessionProgress(305), fmtSessionProgress(405), fmtSessionProgress(435)]")
        self.assertEqual(got, ["5h 5m of 6h 45m", "full session (6h 45m)", "full session (6h 45m)"])

    def test_revenue_between_polls(self):
        polls = [{"elapsed_minutes": 30, "total_revenue": 6}, {"elapsed_minutes": 90, "total_revenue": 18}]
        js = js_eval(LIVE_JS, "[revenueAt(DATA, 15), revenueAt(DATA, 60), revenueAt(DATA, 120)]", polls)
        self.assertEqual(js, [3, 12, None])


def _path_day(frac_14, day_type="normal", date="2026-10-15"):
    """Archived day closing at 100 that had reached `frac_14` of it by 14:00 (285 min)."""
    d = _day(100.0, [5, 10, 15, 20, frac_14 * 100, 95, 100])
    d.update(day_type=day_type, date=date)
    return d


@unittest.skipUnless(NODE, "node not installed")
class LiveCards(unittest.TestCase):
    """Revenue Summary live cards: the Live Predictor's range and day pool, and the card model."""

    NORMAL = [_path_day(0.5), _path_day(0.6), _path_day(0.7)]
    EXPIRY = [_path_day(0.8, "expiry"), _path_day(0.9, "expiry")]
    POLL = {"captured_ist": "2026-10-26T14:00:00", "elapsed_minutes": 285, "total_revenue": 43.0,
            "options_revenue": 40.0, "futures_revenue": 1.0, "cash_revenue": 2.0,
            "predicted_eod": 70.0, "pred_method": "historical/normal/wd0"}
    LIVE = {"kind": "live", "isToday": True, "age": 3}
    CLOSED = {"kind": "closed", "isToday": True, "age": 200}

    def card(self, poll=None, status=None, daily=None, samples=None):
        hourly = {"date": "2026-10-26", "day_type": "normal",
                  "samples": samples if samples is not None else [{"elapsed_minutes": 0, "total_revenue": 5.0}, poll or self.POLL]}
        data = {"h": hourly, "hist": {"days": self.NORMAL + self.EXPIRY}, "daily": daily or [], "st": status or self.LIVE}
        return js_eval(LIVE_CARD_JS, "liveCardModel(DATA.h, DATA.hist, DATA.daily, DATA.st)", data)

    def test_range_is_revenue_over_share_quantiles(self):
        got = js_eval(LIVE_CARD_JS, "typicalPathRange(43, 285, DATA)", self.NORMAL + self.EXPIRY)
        # shares at 14:00: .5 .6 .7 .8 .9 → 90th pct .86, 10th pct .54
        self.assertAlmostEqual(got["lo"], 43 / 0.86, places=9)
        self.assertAlmostEqual(got["hi"], 43 / 0.54, places=9)
        self.assertEqual(got["n"], 5)
        self.assertIsNone(js_eval(LIVE_CARD_JS, "typicalPathRange(43, 285, [])"))

    def test_day_pool_and_default_type(self):
        days = self.NORMAL + self.EXPIRY
        expr = ("[liveDayPool(DATA, 'normal').length, liveDayPool(DATA, 'expiry').length, liveDayPool(DATA, 'all').length,"
                " liveDayPool(DATA, 'normal', DATA[0]).length, liveDefaultType(DATA, 'normal'), liveDefaultType(DATA, 'expiry')]")
        # 3 normal days; 2 expiry days fall back to all 5; leaving one normal day out leaves 2, so all 4 others
        self.assertEqual(js_eval(LIVE_CARD_JS, expr, days), [3, 5, 5, 4, "normal", "all"])

    def test_live_card(self):
        c = self.card()
        lo, hi = 43 / (0.6 + 0.8 * 0.1), 43 / (0.5 + 0.2 * 0.1)   # normal days only: shares .5 .6 .7
        self.assertEqual((c["kind"], c["time"], c["booked"], c["pred"]), ("live", "14:00", 43.0, 70.0))
        self.assertEqual(c["method"], "Normal days, same weekday")
        self.assertAlmostEqual(c["range"]["lo"], lo, places=9)
        self.assertAlmostEqual(c["range"]["hi"], hi, places=9)
        self.assertEqual(c["range"]["n"], 3)
        self.assertIsNone(c["outsideRange"])
        self.assertAlmostEqual(c["pctOfClose"], 43 / 70, places=9)
        scale = max(43, 70, hi) * 1.06
        self.assertAlmostEqual(c["bar"]["fill"], 43 / scale * 100, places=9)
        self.assertAlmostEqual(c["bar"]["mark"], 70 / scale * 100, places=9)
        self.assertAlmostEqual(c["bar"]["lo"], lo / scale * 100, places=9)
        self.assertEqual([s[0] for s in c["segs"]], ["Options", "Futures", "Cash"])

    def test_prediction_outside_range(self):
        self.assertEqual(self.card(dict(self.POLL, predicted_eod=90.0))["outsideRange"], "above")
        self.assertEqual(self.card(dict(self.POLL, predicted_eod=55.0))["outsideRange"], "below")

    def test_closed_session_before_and_after_the_official_close(self):
        before = self.card(status=self.CLOSED)
        self.assertEqual(before["kind"], "closed")
        self.assertIsNone(before["actual"])
        self.assertIsNotNone(before["range"])
        after = self.card(status=self.CLOSED, daily=[{"date": "2026-10-26", "total_rev": 75.0}])
        self.assertEqual(after["actual"], 75.0)
        self.assertAlmostEqual(after["predError"], 70 / 75 - 1, places=9)
        self.assertIsNone(after["range"])
        self.assertIsNone(after["pctOfClose"])
        self.assertIsNone(after["bar"]["lo"])
        self.assertAlmostEqual(after["bar"]["fill"], 75 / (75 * 1.06) * 100, places=9)
        # While the session is live, a same-day row does not count as its close
        self.assertIsNone(self.card(daily=[{"date": "2026-10-26", "total_rev": 75.0}])["actual"])

    def test_no_range_once_the_session_is_complete(self):
        # The pollers run to 16:30: from the 16:00 close every share is 1, so the range would collapse
        done = self.card(dict(self.POLL, captured_ist="2026-10-26T16:30:00", elapsed_minutes=435), status=self.CLOSED)
        self.assertTrue(done["sessionDone"])
        self.assertIsNone(done["range"])
        self.assertIsNone(done["outsideRange"])
        self.assertIsNone(done["bar"]["lo"])
        self.assertEqual((done["booked"], done["pred"]), (43.0, 70.0))
        self.assertAlmostEqual(done["pctOfClose"], 43 / 70, places=9)
        self.assertFalse(self.card(status=self.CLOSED)["sessionDone"])   # polls stopped at 14:00: range kept

    def test_no_polls_and_no_feed(self):
        self.assertEqual(self.card(samples=[{"elapsed_minutes": 0, "total_revenue": 5.0}])["kind"], "none")
        self.assertEqual(js_eval(LIVE_CARD_JS, "liveCardModel(null, null, [])")["kind"], "unavailable")

    def test_close_known_from_the_views_rows(self):
        rows = [{"date": "2026-10-22"}, {"date": "2026-10-23"}]
        got = js_eval(LIVE_CARD_JS + ["liveCloseKnown"],
                      "[liveCloseKnown(DATA, '2026-10-23'), liveCloseKnown(DATA, '2026-10-26'), liveCloseKnown(DATA, null), liveCloseKnown(undefined, '2026-10-23')]", rows)
        self.assertEqual(got, [True, False, False, False])

    def test_actual_close_is_at_todays_rates(self):
        # BSE 23 Oct: ₹10.30 Cr at today's rates (the polls' basis) vs ₹10.81 Cr as charged
        data = {"h": {"date": "2026-10-23", "day_type": "normal", "samples": [self.POLL]},
                "hist": {"days": self.NORMAL}, "today": [{"date": "2026-10-23", "total_rev": 10.30}]}
        expr = ("(LIVE_CARD_CACHE.bse = { hourly: DATA.h, history: DATA.hist, closeRows: DATA.today },"
                " liveCardFor('bse'))")
        c = js_eval(LIVE_CARD_JS + ["liveStatus", "LIVE_STALE_MINUTES", "istDateOf", "parseUtcTs",
                                    "LIVE_CARD_CACHE", "liveCardFor"], expr, data)
        self.assertEqual(c["actual"], 10.30)
        self.assertAlmostEqual(c["predError"], 70 / 10.30 - 1, places=9)

    def banner(self, ex, card):
        return js_eval(["bannerReadingFromCard"], f"bannerReadingFromCard('{ex}', DATA)", card)

    def test_banner_shows_the_cards_reading(self):
        live = self.banner("nse", self.card())
        self.assertEqual((live["total_revenue"], live["trade_date"], live["time"], live["live"], live["source"]),
                         (43.0, "2026-10-26", "14:00", True, "poll"))
        self.assertFalse(live["options_pending"])
        closed = self.banner("nse", self.card(status=self.CLOSED))
        self.assertEqual((closed["total_revenue"], closed["live"]), (43.0, False))
        actual = self.banner("nse", self.card(status=self.CLOSED, daily=[{"date": "2026-10-26", "total_rev": 75.0}]))
        self.assertEqual((actual["total_revenue"], actual["source"]), (75.0, "historical"))
        cash_only = self.banner("bse", self.card(dict(self.POLL, options_revenue=0.0, cash_revenue=0.4)))
        self.assertTrue(cash_only["options_pending"])

    def test_banner_reads_directly_without_a_current_poll(self):
        for card in (self.card(status={"kind": "stale", "isToday": True, "age": 40}),
                     self.card(samples=[]), {"kind": "unavailable"}):
            with self.subTest(kind=card["kind"]):
                self.assertIsNone(self.banner("nse", card))
        # …and falls back to the delayed poll when the direct read fails
        delayed = js_eval(["bannerReadingFromCard"], "bannerReadingFromCard('nse', DATA, true)",
                          self.card(status={"kind": "stale", "isToday": True, "age": 40}))
        self.assertEqual((delayed["total_revenue"], delayed["live"], delayed["time"]), (43.0, False, "14:00"))

    def test_trade_date_forms(self):
        forms = ["2026-10-16T15:30:00", "16/10/26", "16/10/2026", "16-10-26", "16-10-2026", "16-Oct-2026"]
        got = js_eval(["normalizeTradeDateJS"], "DATA.map(normalizeTradeDateJS)", forms)
        self.assertEqual(got, ["2026-10-16"] * len(forms))


@unittest.skipUnless(NODE, "node not installed")
class QuarterLabels(unittest.TestCase):
    def test_shift_and_short_range(self):
        js = js_eval(["shiftQuarter", "shortQuarterRange"],
                     "[shiftQuarter('Q3 FY 2027', -1), shiftQuarter('Q1 FY 2027', -1), shiftQuarter('Q3 FY 2027', -4), shiftQuarter('Q4 FY 2027', 1),"
                     " shortQuarterRange(['Q2 FY 2026', 'Q3 FY 2026']), shortQuarterRange(['Q4 FY 2026', 'Q1 FY 2027']), shortQuarterRange(['Q3 FY 2026'])]")
        self.assertEqual(js, ["Q2 FY 2027", "Q4 FY 2026", "Q3 FY 2026", "Q1 FY 2028",
                              "Q2–Q3 FY26", "Q4 FY26–Q1 FY27", "Q3 FY26"])

    def test_analyst_note_month_span(self):
        js = js_eval(["rxDate", "analystMonths"],
                     "[analystMonths('2026-05-08', '2026-05-18'), analystMonths('2026-05-08', '2026-08-04'),"
                     " analystMonths('2025-12-02', '2026-08-04'), analystMonths('2026-05-08', null)]")
        self.assertEqual(js, ["May 2026", "May–Aug 2026", "Dec 2025–Aug 2026", "May 2026"])


if __name__ == "__main__":
    unittest.main()
