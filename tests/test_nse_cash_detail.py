"""NSE activity detail: cash trade counts and per-segment contracts.

They ride along on every daily row (and special session, and the date-effective
variant) and never change a turnover or revenue figure. Rows stored before they
were parsed are filled in from a re-fetch of their months."""

import copy
import unittest

import helpers  # noqa: F401  (puts scripts/ on sys.path)

import nse_pipeline as nse

# A live row from NSE's cash-market archive (30 Oct 2026, per the request)
CM_ROW = {"F_TIMESTAMP": "30-Oct-2026", "CDT_NOS_OF_SECURITY_TRADES": 3641,
          "CDT_NOS_OF_TRADES": 43793587, "CDT_TRADES_QTY": 64151.92,
          "CDT_TRADES_VALUES": 120852.45}

REVENUE_FIELDS = ("if_turnover", "sf_turnover", "io_premium", "so_premium", "cash_traded_value",
                  "if_rev", "sf_rev", "fut_rev", "io_rev", "so_rev", "opt_rev", "fo_rev",
                  "cash_rev", "total_rev", "total_contracts", "total_turnover")


def fo_row(date="09-Oct-2026", **qty):
    row = {"F_TIMESTAMP": date, "Index_Futures_VAL": 10000, "Stock_Futures_VAL": 50000,
           "Index_Options_VAL": 9e6, "Index_Options_PREM_VAL": 80000, "Stock_Options_VAL": 4e5,
           "Stock_Options_PREM_VAL": 6000, "Index_Options_PUT_CALL_RATIO": 1.0,
           "F&O_Total_QTY": 131595782, "F&O_Total_VAL": 9.46e6}
    row.update(qty)
    return row


SEGMENTS = {"Index_Futures_QTY": 141001, "Stock_Futures_QTY": 823763,
            "Index_Options_QTY": 124021634, "Stock_Options_QTY": 6609384}


def stored_row(date, **over):
    """A daily row as an older JSON stored it (no activity detail)."""
    fo = {k: v for k, v in nse.parse_fo_record(fo_row(f"{date[8:]}-Oct-{date[:4]}", **SEGMENTS)).items()
          if k != "_dt" and k not in nse.SEGMENT_CONTRACT_KEYS}
    fo["date"] = date
    fo.update({"cash_traded_value": 120852.45, "cash_rev": nse.cash_revenue(120852.45)})
    fo["total_rev"] = nse.total_revenue(fo)
    fo.update(over)
    return fo


class Parsing(unittest.TestCase):
    def test_cash_detail(self):
        r = nse.parse_cm_record(CM_ROW)
        self.assertEqual(r["date"], "2026-10-30")
        self.assertEqual(r["cash_trades"], 43793587)
        self.assertEqual(r["cash_securities"], 3641)
        self.assertEqual(r["cash_quantity"], 6415192000)      # 64151.92 lakh shares

    def test_cash_revenue_unchanged(self):
        r = nse.parse_cm_record(CM_ROW)
        self.assertEqual(r["cash_traded_value"], 120852.45)
        self.assertEqual(r["cash_rev"], nse.cash_revenue(120852.45))

    def test_missing_counts_are_none_not_zero(self):
        row = {k: v for k, v in CM_ROW.items() if k not in ("CDT_NOS_OF_TRADES", "CDT_TRADES_QTY")}
        row["CDT_NOS_OF_SECURITY_TRADES"] = "-"
        r = nse.parse_cm_record(row)
        self.assertIsNone(r["cash_trades"])
        self.assertIsNone(r["cash_quantity"])
        self.assertIsNone(r["cash_securities"])

    def test_counts_with_commas(self):
        r = nse.parse_cm_record(dict(CM_ROW, CDT_NOS_OF_TRADES="4,37,93,587"))
        self.assertEqual(r["cash_trades"], 43793587)

    def test_segment_contracts(self):
        r = nse.parse_fo_record(fo_row(**SEGMENTS))
        self.assertEqual((r["if_contracts"], r["sf_contracts"], r["io_contracts"], r["so_contracts"]),
                         (141001, 823763, 124021634, 6609384))
        self.assertEqual(r["total_contracts"], 131595782)

    def test_segment_contracts_absent(self):
        r = nse.parse_fo_record(fo_row())
        self.assertTrue(all(r[k] is None for k in nse.SEGMENT_CONTRACT_KEYS))

    def test_fo_revenue_unchanged_by_segments(self):
        with_seg, without = nse.parse_fo_record(fo_row(**SEGMENTS)), nse.parse_fo_record(fo_row())
        for k in ("if_rev", "sf_rev", "fut_rev", "io_rev", "so_rev", "opt_rev", "fo_rev"):
            self.assertEqual(with_seg[k], without[k])


class Backfill(unittest.TestCase):
    def test_missing_detail(self):
        complete = stored_row("2026-10-09", cash_trades=1, cash_securities=1, cash_quantity=1,
                              if_contracts=1, sf_contracts=1, io_contracts=1, so_contracts=1)
        self.assertEqual(nse.missing_detail(complete), set())
        self.assertEqual(nse.missing_detail(stored_row("2026-10-16")), {"cm", "fo"})
        # nse_daily's 12–15 Oct rows: option contracts 0 although the day traded
        zeros = dict(complete, if_contracts=0, sf_contracts=0, io_contracts=0, so_contracts=0)
        self.assertEqual(nse.missing_detail(zeros), {"fo"})

    def test_detail_months(self):
        rows = [stored_row("2026-10-16"),
                stored_row("2023-04-03", if_contracts=1, sf_contracts=1, io_contracts=1, so_contracts=1)]
        self.assertEqual(nse.detail_months(rows), {(2023, 4): {"cm"}, (2026, 10): {"cm", "fo"}})
        self.assertEqual(nse.detail_months(rows, skip={(2026, 10)}), {(2023, 4): {"cm"}})

    def test_fill_touches_only_detail_fields(self):
        rows = [stored_row("2026-10-30"), stored_row("2026-10-09")]
        before = copy.deepcopy(rows)
        cm = {"2026-10-30": nse.parse_cm_record(CM_ROW)}
        fo = {"2026-10-09": nse.parse_fo_record(fo_row(**SEGMENTS))}
        changed = nse.fill_detail_fields(rows, fo, cm)
        self.assertEqual(changed, {"2026-10-30", "2026-10-09"})
        self.assertEqual(rows[0]["cash_trades"], 43793587)
        self.assertEqual(rows[1]["io_contracts"], 124021634)
        for new, old in zip(rows, before):
            self.assertEqual({k: new[k] for k in REVENUE_FIELDS}, {k: old[k] for k in REVENUE_FIELDS})
            self.assertEqual(set(new) - set(old) <= set(nse.DETAIL_FIELDS), True)

    def test_fill_never_writes_none_or_overwrites_complete_rows(self):
        row = stored_row("2026-10-30", cash_trades=5, cash_securities=5, cash_quantity=5)
        nse.fill_detail_fields([row], {}, {"2026-10-30": nse.parse_cm_record(CM_ROW)})
        self.assertEqual(row["cash_trades"], 5)                # already complete: untouched
        bare = stored_row("2026-10-30")
        nse.fill_detail_fields([bare], {}, {"2026-10-30": nse.parse_cm_record({"F_TIMESTAMP": "30-Oct-2026"})})
        self.assertNotIn("cash_trades", bare)                  # nothing published: stays absent

    def test_fetch_detail_months_requests_only_needed_archives(self):
        urls = []

        class Resp:
            status_code = 200

            def __init__(self, url):
                self.url = url

            def json(self):
                return {"data": [CM_ROW] if "/cm/" in self.url else [fo_row("30-Oct-2026", **SEGMENTS)]}

        class Session:
            def get(self, url, **kw):
                urls.append(url)
                return Resp(url)
        fo, cm = nse.fetch_detail_months(Session(), {(2023, 4): {"cm"}, (2026, 10): {"cm", "fo"}},
                                         pause=lambda s: None)
        self.assertEqual(len(urls), 3)
        self.assertTrue(any("cm/tbg/daily?month=Apr&year=23" in u for u in urls))
        self.assertTrue(any("fo/tbg/daily?month=Oct&year=2026" in u for u in urls))
        self.assertEqual(cm["2026-10-30"]["cash_trades"], 43793587)
        self.assertEqual(fo["2026-10-30"]["so_contracts"], 6609384)

    def test_failed_month_is_skipped(self):
        class Session:
            def get(self, url, **kw):
                raise RuntimeError("blocked")
        fo, cm = nse.fetch_detail_months(Session(), {(2024, 1): {"cm"}}, pause=lambda s: None)
        self.assertEqual((fo, cm), ({}, {}))

    def test_time_budget_stops_backfill(self):
        ticks = iter([0, 0, 10_000])

        class Session:
            def get(self, url, **kw):
                class R:
                    status_code = 200

                    def json(self):
                        return {"data": []}
                return R()
        urls = []
        s = Session()
        orig = s.get
        s.get = lambda url, **kw: urls.append(url) or orig(url, **kw)
        nse.fetch_detail_months(s, {(2024, 1): {"cm"}, (2024, 2): {"cm"}},
                                clock=lambda: next(ticks), pause=lambda s: None)
        self.assertEqual(len(urls), 1)


class Outputs(unittest.TestCase):
    def test_detail_reaches_every_output(self):
        regular = stored_row("2026-10-30", cash_trades=43793587, cash_securities=3641, cash_quantity=6415192000)
        muhurat = dict(stored_row("2025-10-21", cash_trades=123, cash_securities=1, cash_quantity=1),
                       fy_quarter="Q3 FY 2026", fy_month="FY 2026 October", fy="FY 2026", day="Tuesday")
        out = nse.build_outputs([muhurat, regular], [], [], {})
        self.assertEqual(out["dashboard"]["daily_all"][0]["cash_trades"], 43793587)
        self.assertEqual(out["dashboard"]["special_sessions"][0]["cash_trades"], 123)
        eff = nse.build_date_effective_outputs([muhurat, regular], [], [], {})
        self.assertEqual(eff["dashboard"]["daily_all"][0]["cash_trades"], 43793587)
        self.assertEqual(eff["dashboard"]["special_sessions"][0]["cash_trades"], 123)


if __name__ == "__main__":
    unittest.main()
