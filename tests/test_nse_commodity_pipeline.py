"""NSE commodity derivatives (scripts/nse_commodity_pipeline.py): the
bhavcopy's per-contract rows aggregated per underlying, the derived options
premium, MCX's rows on the same underlyings, revenue, periods and a full run
with the network faked."""

import csv
import io
import json
import os
import tempfile
import unittest
import zipfile
from datetime import date
from pathlib import Path

import helpers  # noqa: F401  (puts scripts/ on sys.path)

import fee_register as fr
import nse_commodity_pipeline as com

COLS = ["TradDt", "BizDt", "Sgmt", "Src", "FinInstrmTp", "FinInstrmId", "ISIN", "TckrSymb", "SctySrs",
        "XpryDt", "FininstrmActlXpryDt", "StrkPric", "OptnTp", "FinInstrmNm", "OpnPric", "HghPric", "LwPric",
        "ClsPric", "LastPric", "PrvsClsgPric", "UndrlygPric", "SttlmPric", "OpnIntrst", "ChngInOpnIntrst",
        "TtlTradgVol", "TtlTrfVal", "TtlNbOfTxsExctd", "SsnId", "NewBrdLotQty", "Rmks"]


def row(tp, sym, vol, val, strike="", lo="0", hi="0", trades=None, d="2026-11-17"):
    return {"TradDt": d, "BizDt": d, "Sgmt": "CO", "Src": "NSE", "FinInstrmTp": tp, "TckrSymb": sym,
            "StrkPric": strike, "LwPric": lo, "HghPric": hi, "TtlTradgVol": str(vol), "TtlTrfVal": str(val),
            "TtlNbOfTxsExctd": str(trades if trades is not None else vol), "OpnIntrst": "5", "SsnId": "F1",
            "NewBrdLotQty": "1"}


def bhavcopy(rows, d="20261117"):
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=COLS, extrasaction="ignore")
    w.writeheader()
    for r in rows:
        w.writerow({c: r.get(c, "") for c in COLS})
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        z.writestr(f"BhavCopy_NSE_CO_0_0_0_{d}_F_0000.csv", buf.getvalue())
    return out.getvalue()


# Rows as on 17 Nov 2026: NATURALGAS 245 PE traded at 0.05 (multiplier 1,250),
# CRUDEOIL 7600 CE at an average 520 (multiplier 100), electricity and gold
# futures, and contracts that did not trade.
DAY = [
    row("FUO", "NATURALGAS", 4052, 1241178250.0, strike="245.00", lo="0.05", hi="0.05"),
    row("FUO", "CRUDEOIL", 2, 1624000.0, strike="7600.00", lo="510", hi="526.6"),
    row("COF", "CRUDEOIL", 103, 81904000.0),
    row("COF", "ELECMBL", 82, 13715950.0),
    row("COF", "GOLD10G", 100, 13513638.0),
    row("COF", "ALUMINI", 0, 0.0),
    row("FUO", "GOLD", 0, 0.0, strike="130000"),
]


class Parse(unittest.TestCase):
    def test_aggregates_per_underlying(self):
        d, nse, checks = com.parse_bhavcopy(bhavcopy(DAY))[:3]
        self.assertEqual(d, "2026-11-17")
        self.assertEqual(checks, [])
        self.assertEqual(set(nse), {"natgas", "crude", "electricity", "gold"})   # untraded rows left out
        self.assertEqual(nse["crude"]["f"], [103, 8.1904])
        self.assertEqual(nse["electricity"], {"f": [82, 1.3716]})

    def test_option_premium_is_value_less_strike_notional(self):
        _, nse, _ = com.parse_bhavcopy(bhavcopy(DAY))[:3]
        # (245 + 0.05) × 1,250 × 4,052 → premium 0.05 × 1,250 × 4,052 = ₹253,250
        self.assertEqual(nse["natgas"]["o"], [4052, 124.1178, 0.0253])
        # (7600 + 520) × 100 × 2 → premium 520 × 100 × 2 = ₹104,000
        self.assertEqual(nse["crude"]["o"], [2, 0.1624, 0.0104])

    def test_premium_outside_the_price_range_is_flagged(self):
        bad = [row("FUO", "CRUDEOIL", 2, 1624000.0, strike="7600.00", lo="100", hi="200")]
        _, nse, checks = com.parse_bhavcopy(bhavcopy(bad))[:3]
        self.assertEqual(nse["crude"]["o"][2], 0.0104)
        self.assertIn("CRUDEOIL: 1 option row(s) whose derived premium is outside the day's price range", checks)

    def test_cheap_option_off_its_range_by_a_few_rupees_is_flagged(self):
        # A crude option traded at ₹1–2 whose value implies ₹6: within a tolerance
        # scaled to the strike (₹8), but not within rounding
        bad = [row("FUO", "CRUDEOIL", 10, 8006000.0, strike="8000.00", lo="1", hi="2")]
        _, _, checks = com.parse_bhavcopy(bhavcopy(bad))[:3]
        self.assertIn("CRUDEOIL: 1 option row(s) whose derived premium is outside the day's price range", checks)
        ok = [row("FUO", "CRUDEOIL", 10, 8001500.0, strike="8000.00", lo="1", hi="2")]
        self.assertEqual(com.parse_bhavcopy(bhavcopy(ok))[2], [])

    def test_unknown_multiplier_leaves_premium_null(self):
        _, nse, checks = com.parse_bhavcopy(bhavcopy([row("FUO", "GOLDM", 3, 3_000_000.0, strike="13000")]))[:3]
        self.assertEqual(nse["gold"]["o"], [3, 0.3, None])
        self.assertTrue(any("no known multiplier" in c for c in checks))

    def test_options_expiring_that_day(self):
        rows = [dict(row("FUO", "CRUDEOIL", 0, 0.0, strike="7600"), XpryDt="2026-11-17"),     # untraded, still expiring
                dict(row("FUO", "NATURALGAS", 4052, 1241178250.0, strike="245.00", lo="0.05", hi="0.05"),
                     XpryDt="2026-11-25"),
                dict(row("COF", "GOLD10G", 100, 13513638.0), XpryDt="2026-11-17")]           # futures: not counted
        self.assertEqual(com.parse_bhavcopy(bhavcopy(rows))[3], ["crude"])
        self.assertEqual(com.parse_bhavcopy(bhavcopy(DAY))[3], [])                         # no XpryDt

    def test_unmapped_symbol_and_instrument(self):
        _, nse, checks = com.parse_bhavcopy(bhavcopy([row("COF", "COCOA", 1, 1e7), row("XYZ", "GOLD", 1, 1e7)]))[:3]
        self.assertEqual(nse, {"cocoa": {"f": [1, 1.0]}})
        self.assertIn("unmapped NSE symbol COCOA", checks)
        self.assertTrue(any("unknown instrument type 'XYZ'" in c for c in checks))


def mcx_row(d, sym, inst, contracts, turnover, premium=None, head="ENERGY"):
    return {"trading_date": d, "commodity": sym, "commodity_head": head, "instrument_type": inst,
            "contracts": contracts, "turnover_cr": turnover, "premium_turnover_cr": premium}


class Mcx(unittest.TestCase):
    def test_maps_symbols_to_underlyings(self):
        rows = [mcx_row("2026-11-17", "NATURALGAS", "OPTFUT", 2034688, 76911.94, 1590.9),
                mcx_row("2026-11-17", "NATGASMINI", "OPTFUT", 2376659, 17912.04, 399.44),
                mcx_row("2026-11-17", "ELECDMBL", "FUTCOM", 1699, 34.73),
                # futures rows sometimes carry premium = turnover (16 Nov 2026): ignored
                mcx_row("2026-11-17", "CRUDEOIL", "FUTCOM", 64895, 5208.18, 5208.18),
                mcx_row("2026-11-17", "MENTHAOIL", "FUTCOM", 253, 12.14, head="AGRO COMMODITIES"),
                mcx_row("2026-11-17", "MCXBULLDEX", "OPTIDX", 2, 0.5, 0.01, head="INDEX"),
                mcx_row("2026-05-27", "_TEST_PROBE_", "FUTCOM", 0, 0.0)]
        by_date, unmapped = com.mcx_by_date(rows)
        self.assertEqual(unmapped, [])                       # the all-zero probe row is skipped
        self.assertEqual(set(by_date), {"2026-11-17"})
        day = by_date["2026-11-17"]
        self.assertEqual(day["natgas"]["o"], [4411347, 94823.98, 1990.34])
        self.assertEqual(day["electricity"], {"f": [1699, 34.73]})
        self.assertEqual(day["crude"], {"f": [64895, 5208.18]})
        self.assertEqual(day["agri"]["f"], [253, 12.14])
        self.assertEqual(day["index"]["o"], [2, 0.5, 0.01])

    def test_unknown_mcx_symbol_is_reported(self):
        _, unmapped = com.mcx_by_date([mcx_row("2026-11-17", "COTTONOIL", "FUTCOM", 5, 1.0, head="BASE")])
        self.assertEqual(unmapped, ["COTTONOIL"])


class Revenue(unittest.TestCase):
    def test_futures_on_notional_options_on_premium(self):
        nse = {"crude": {"f": [237, 18.9543], "o": [18177, 1525.5914, 63.7014]},
               "electricity": {"f": [82, 1.3716]}}
        want = (18.9543 + 1.3716) * fr.fraction(10) + 63.7014 * fr.fraction(100)
        self.assertAlmostEqual(com.revenue(nse), round(want, 6))
        self.assertAlmostEqual(com.revenue(nse, "2026-11-17"), round(want, 6))

    def test_electricity_waiver_in_the_date_effective_figure(self):
        nse = {"electricity": {"f": [100, 10.0]}}
        self.assertEqual(com.revenue(nse, "2025-08-01"), 0)
        self.assertAlmostEqual(com.revenue(nse), 10.0 * fr.fraction(10))

    def test_unknown_premium_counts_zero(self):
        self.assertEqual(com.revenue({"gold": {"o": [3, 0.3, None]}}), 0)

    def test_revenue_by_underlying_adds_up_to_the_total(self):
        nse = {"crude": {"f": [237, 18.9543], "o": [18177, 1525.5914, 63.7014]},
               "electricity": {"f": [82, 1.3716]}}
        ru = com.revenue_by_underlying(nse)
        self.assertAlmostEqual(ru["electricity"], 1.3716 * fr.fraction(10))
        self.assertAlmostEqual(round(sum(ru.values()), 6), com.revenue(nse))

    def test_mcx_split_by_futures_notional_and_options_premium(self):
        mcx = {"crude": {"f": [10, 300.0], "o": [100, 9000.0, 60.0]},
               "gold": {"f": [10, 700.0], "o": [100, 9000.0, 40.0]}, "agri": {"f": [1, 0.0]}}
        ru = com.mcx_revenue_by_underlying(mcx, 2.0, 10.0)
        self.assertAlmostEqual(ru["crude"], 2.0 * 0.3 + 10.0 * 0.6)
        self.assertAlmostEqual(ru["gold"], 2.0 * 0.7 + 10.0 * 0.4)
        self.assertEqual(ru["agri"], 0)
        self.assertAlmostEqual(sum(ru.values()), 12.0)

    def test_mcx_split_needs_rows_revenue_and_something_to_split_over(self):
        self.assertIsNone(com.mcx_revenue_by_underlying(None, 1.0, 1.0))
        self.assertIsNone(com.mcx_revenue_by_underlying({"crude": {"f": [1, 5.0]}}, None, 1.0))
        # 2026-06-23: option rows with premium 0 against reported options revenue
        self.assertIsNone(com.mcx_revenue_by_underlying({"crude": {"f": [1, 5.0], "o": [9, 90.0, 0.0]}}, 1.0, 6.15))


class Periods(unittest.TestCase):
    def test_sums_only_days_with_both_exchanges_and_no_special_sessions(self):
        daily = [
            {"date": "2026-10-30", "nse": {"crude": {"o": [10, 100.0, 1.0]}},
             "mcx": {"crude": {"o": [1000, 9000.0, 99.0]}}, "rev": [0.1, 0.1]},
            {"date": "2026-11-02", "nse": {"crude": {"o": [10, 100.0, 1.0]}},
             "mcx": {"crude": {"o": [1000, 9000.0, 99.0]}}, "rev": [0.1, 0.1]},
            {"date": "2026-11-08", "session": "muhurat", "nse": {"crude": {"o": [5, 50.0, 0.5]}},
             "mcx": {"crude": {"o": [9, 90.0, 0.9]}}, "rev": [0.05, 0.05]},
            {"date": "2026-11-17", "nse": {"crude": {"o": [10, 100.0, None]}}, "mcx": None, "rev": [0.0, 0.0]},
        ]
        months = com.periods(daily, "month")
        self.assertEqual([(m["month"], m["days"]) for m in months], [("2026-10", 1), ("2026-11", 1)])
        self.assertEqual(months[1]["nse"]["crude"]["o"], [10, 100.0, 1.0])
        quarters = com.periods(daily, "quarter")
        self.assertEqual([(q["quarter"], q["days"]) for q in quarters], [("Q3 FY 2027", 2)])
        self.assertEqual(quarters[0]["mcx"]["crude"]["o"], [2000, 18000.0, 198.0])

    def test_revenue_per_underlying_sums_over_days_that_have_it(self):
        day = lambda d, mcx_ru: {"date": d, "nse": {"crude": {"o": [1, 10.0, 1.0]}},
                                 "mcx": {"crude": {"o": [9, 90.0, 9.0]}}, "rev": [0.01, 0.01],
                                 "ru": {"nse": {"crude": 0.01}, "mcx": mcx_ru}}
        m = com.periods([day("2026-06-22", {"crude": 1.5}), day("2026-06-23", None),
                         day("2026-06-24", {"crude": 2.5, "gold": 1.0})], "month")[0]
        self.assertEqual(m["days"], 3)
        self.assertEqual(m["ru_days"], {"nse": 3, "mcx": 2})
        self.assertEqual(m["ru"], {"nse": {"crude": 0.03}, "mcx": {"crude": 4.0, "gold": 1.0}})

    def test_zero_premium_day_adds_no_premium_on_either_side(self):
        # 23 Jun 2026: every MCX option row has premium 0 though options traded
        day = lambda d, mcx_prem: {"date": d, "nse": {"crude": {"f": [5, 50.0], "o": [10, 100.0, 1.0]}},
                                   "mcx": {"crude": {"f": [50, 500.0], "o": [1000, 9000.0, mcx_prem]},
                                           "gold": {"o": [100, 900.0, mcx_prem]}},
                                   "rev": [0.1, 0.1]}
        daily = [day("2026-06-22", 99.0), day("2026-06-23", 0.0), day("2026-06-24", 99.0)]
        self.assertEqual([com.premium_out(r) for r in daily], [False, True, False])
        m = com.periods(daily, "month")[0]
        self.assertEqual((m["days"], m["prem_days"]), (3, 2))
        # contracts and notional count every day; premium only the two good ones, on both sides
        self.assertEqual(m["nse"]["crude"]["o"], [30, 300.0, 2.0])
        self.assertEqual(m["mcx"]["crude"]["o"], [3000, 27000.0, 198.0])
        self.assertEqual(m["mcx"]["gold"]["o"], [300, 2700.0, 198.0])
        self.assertEqual(m["nse"]["crude"]["f"], [15, 150.0])
        self.assertEqual(com.periods(daily, "quarter")[0]["prem_days"], 2)
        # the stored day itself is unchanged
        self.assertEqual(daily[1]["nse"]["crude"]["o"], [10, 100.0, 1.0])

    def test_premium_out_needs_options_traded_and_a_known_zero(self):
        self.assertFalse(com.premium_out({"mcx": None}))
        self.assertFalse(com.premium_out({"mcx": {"crude": {"f": [1, 10.0]}}}))             # no options
        self.assertFalse(com.premium_out({"mcx": {"crude": {"o": [0, 0.0, 0.0]}}}))         # none traded
        self.assertFalse(com.premium_out({"mcx": {"crude": {"o": [1, 9.0, None]}}}))        # unknown, not 0
        # one underlying's premium rounding to 0 (MCX's 1–4 contract index / zinc trades) is a real figure
        self.assertFalse(com.premium_out({"mcx": {"crude": {"o": [9, 90.0, 5.0]}, "index": {"o": [2, 0.2, 0.0]}}}))
        self.assertTrue(com.premium_out({"mcx": {"crude": {"o": [9, 90.0, 0.0]}, "gold": {"o": [1, 9.0, 0]}}}))

    def test_none_propagates(self):
        acc = {}
        com._add(acc, {"gold": {"o": [3, 0.3, None]}})
        com._add(acc, {"gold": {"o": [1, 0.1, 0.01]}})
        self.assertEqual(acc["gold"]["o"][2], None)

    def test_fy_quarters(self):
        self.assertEqual(com.fy_quarter_label("2026-03-31"), "Q4 FY 2026")
        self.assertEqual(com.fy_quarter_label("2026-04-01"), "Q1 FY 2027")
        self.assertLess(com.quarter_sort_key("Q4 FY 2026"), com.quarter_sort_key("Q1 FY 2027"))


class Planning(unittest.TestCase):
    def test_recent_window_then_older_not_stored(self):
        dates = [date(2026, 11, d) for d in (9, 10, 11, 12, 13, 16, 17)]
        window, older = com.plan_dates(dates, {"2026-11-11": {}}, {"2026-11-10": "x"}, recent=2, backfill=5)
        self.assertEqual(window, [date(2026, 11, 16), date(2026, 11, 17)])
        self.assertEqual(older, [date(2026, 11, 13), date(2026, 11, 12), date(2026, 11, 9)])
        _, older = com.plan_dates(dates, {}, {"2026-11-10": "x"}, recent=2, backfill=5, retry=True)
        self.assertIn(date(2026, 11, 10), older)

    def test_rows_from_an_older_parser_stay_until_re_read(self):
        tmp = Path(tempfile.mkdtemp()) / "out.json"
        tmp.write_text(json.dumps({"daily": [
            {"date": "2026-11-16", "nse": {"crude": {"f": [1, 1.0]}}},
            {"date": "2026-11-17", "nse": {"crude": {"f": [1, 1.0]}}, "xo": ["crude"], "parser": com.PARSER_VERSION}]}))
        store, _ = com.load_store(tmp)
        self.assertEqual(set(store), {"2026-11-16", "2026-11-17"})   # still published
        self.assertTrue(store["2026-11-16"]["stale"])
        self.assertNotIn("stale", store["2026-11-17"])
        self.assertEqual(store["2026-11-17"]["xo"], ["crude"])
        served = {"2026-11-16": bhavcopy([dict(r, TradDt="2026-11-16") for r in DAY], "20261116")}

        def fetch(session, d):
            body = served.get(d.isoformat())
            return "url", body, None if body else "not posted (HTTP 404)"
        dates = [date(2026, 11, 16), date(2026, 11, 17)]
        changed, _ = com.run_nse(None, store, {}, dates, set(), 5, "now", date(2026, 11, 18),
                                 fetch=fetch, pause=lambda s: None)
        self.assertIn("2026-11-16", changed)                          # re-read by the backfill
        self.assertEqual(store["2026-11-16"]["parser"], com.PARSER_VERSION)
        self.assertNotIn("stale", store["2026-11-16"])

    def test_commodity_dates_add_weekdays_after_mcx(self):
        tmp = Path(tempfile.mkdtemp()) / "mcx.json"
        tmp.write_text(json.dumps({"daily_all": [{"date": "2024-08-30"}, {"date": "2026-11-13"}],
                                   "special_sessions": [{"date": "2026-11-08"}]}))
        dates, mcx = com.commodity_dates(date(2026, 11, 18), tmp)
        self.assertEqual([d.isoformat() for d in dates],
                         ["2026-11-08", "2026-11-13", "2026-11-16", "2026-11-17"])   # before Sep 2024 dropped
        self.assertIn("2024-08-30", mcx)


class FakeResp:
    def __init__(self, status, body=b""):
        self.status_code, self.content = status, body


class MainRun(unittest.TestCase):
    """main() with NSE and MCX faked, writing to a temp dir."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.saved = {k: getattr(com, k) for k in ("OUT_PATH", "MCX_DATES_PATH", "NEW_DAYS_FILE")}
        com.OUT_PATH = self.tmp / "nse_commodity_daily.json"
        com.MCX_DATES_PATH = self.tmp / "mcx_dashboard_data.json"
        com.NEW_DAYS_FILE = self.tmp / ".count"
        com.MCX_DATES_PATH.write_text(json.dumps({"daily_all": [
            {"date": "2026-11-05"}, {"date": "2026-11-16", "fut_rev": 0.0, "opt_rev": 0.5},
            {"date": "2026-11-17"}]}))
        import mcx_pipeline
        self.mcx_key = mcx_pipeline.MCX_SUPABASE_KEY
        mcx_pipeline.MCX_SUPABASE_KEY = "test"
        self.env = {k: os.environ.pop(k, None) for k in ("EVENT", "SLOT", "NSE_COM_BACKFILL")}

    def tearDown(self):
        for k, v in self.saved.items():
            setattr(com, k, v)
        import mcx_pipeline
        mcx_pipeline.MCX_SUPABASE_KEY = self.mcx_key
        for k, v in self.env.items():
            if v is not None:
                os.environ[k] = v

    def run_main(self, served, mcx_rows):
        fetched = []

        def fetch(session, d):
            fetched.append(d.isoformat())
            body = served.get(d.isoformat())
            if body is None:
                return "url", None, "not posted (HTTP 404)"
            return "url", body, None

        code = com.main(session_factory=lambda: None, fetch=fetch, mcx_fetch=lambda: mcx_rows,
                        pause=lambda s: None, today=date(2026, 11, 18))
        return code, fetched, json.loads(com.OUT_PATH.read_text())

    def test_full_run(self):
        served = {"2026-11-16": bhavcopy([dict(r, TradDt="2026-11-16") for r in DAY], "20261116"),
                  "2026-11-17": bhavcopy(DAY)}
        mcx_rows = [mcx_row("2026-11-16", "NATURALGAS", "OPTFUT", 100, 1000.0, 20.0),
                    mcx_row("2026-11-17", "NATURALGAS", "OPTFUT", 100, 1000.0, 20.0)]
        code, fetched, doc = self.run_main(served, mcx_rows)
        self.assertEqual(code, 0)
        self.assertEqual(sorted(fetched), ["2026-11-05", "2026-11-16", "2026-11-17"])
        self.assertEqual([r["date"] for r in doc["daily"]], ["2026-11-16", "2026-11-17"])
        self.assertEqual(doc["unavailable"], {"2026-11-05": "not posted (HTTP 404)"})   # MCX traded, NSE never posted
        self.assertEqual(doc["daily"][1]["mcx"]["natgas"]["o"], [100, 1000.0, 20.0])
        self.assertEqual(doc["monthly"][0]["days"], 2)
        self.assertEqual(doc["daily"][0]["ru"]["mcx"], {"natgas": 0.5})   # MCX's reported revenue, split
        self.assertIsNone(doc["daily"][1]["ru"]["mcx"])                    # no reported revenue that day
        self.assertAlmostEqual(sum(doc["daily"][1]["ru"]["nse"].values()), doc["daily"][1]["rev"][0], places=5)
        self.assertEqual(doc["monthly"][0]["ru_days"], {"nse": 2, "mcx": 1})
        self.assertEqual(com.NEW_DAYS_FILE.read_text(), "3")

        # Next run: MCX's 17 Nov rows are gone (not landed): that day publishes mcx null
        code, fetched, doc = self.run_main(served, mcx_rows[:1])
        self.assertEqual(sorted(fetched), ["2026-11-05", "2026-11-16", "2026-11-17"])   # all in the recent window
        self.assertIsNone(doc["daily"][1]["mcx"])
        self.assertEqual(doc["monthly"][0]["days"], 1)
        self.assertEqual(com.NEW_DAYS_FILE.read_text(), "1")                       # file changed: commit

    def test_expiring_options_are_published(self):
        day = DAY + [dict(row("FUO", "CRUDEOIL", 0, 0.0, strike="7600"), XpryDt="2026-11-17")]
        _, _, doc = self.run_main({"2026-11-17": bhavcopy(day)}, [])
        self.assertEqual(doc["daily"][-1]["xo"], ["crude"])
        self.assertEqual(doc["daily"][-1]["parser"], com.PARSER_VERSION)

    def test_unchanged_run_counts_zero(self):
        served = {"2026-11-17": bhavcopy(DAY)}
        mcx_rows = [mcx_row("2026-11-17", "NATURALGAS", "OPTFUT", 100, 1000.0, 20.0)]
        self.run_main(served, mcx_rows)
        self.run_main(served, mcx_rows)
        self.assertEqual(com.NEW_DAYS_FILE.read_text(), "0")

    def test_mcx_failure_keeps_previous_figures(self):
        served = {"2026-11-17": bhavcopy(DAY)}
        self.run_main(served, [mcx_row("2026-11-17", "NATURALGAS", "OPTFUT", 100, 1000.0, 20.0)])

        def boom():
            raise OSError("down")
        com.main(session_factory=lambda: None, fetch=lambda s, d: ("u", served.get(d.isoformat()), "x"),
                 mcx_fetch=boom, pause=lambda s: None, today=date(2026, 11, 18))
        doc = json.loads(com.OUT_PATH.read_text())
        self.assertEqual(doc["daily"][-1]["mcx"]["natgas"]["o"], [100, 1000.0, 20.0])


if __name__ == "__main__":
    unittest.main()
