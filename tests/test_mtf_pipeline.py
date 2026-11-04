"""scripts/mtf_pipeline.py: NSE / BSE margin trading files → mtf_daily.json.

The fixtures copy the layout of real files: NSE's standard file (title row, four
summary rows, one row per security), NSE's revised file (original and revised
blocks side by side; the right-hand block is used), and BSE's CSV (ISIN rows,
quoted names with commas)."""

import io
import json
import tempfile
import unittest
import zipfile
from datetime import date
from pathlib import Path

from helpers import ROOT  # also puts scripts/ on the path
import mtf_pipeline as m

NSE_STANDARD = """SEBI Report as on Reporting Date 29DEC2025,,,
Sr.No.,Particulars,Rs. In Lakhs,
1,Scripwise Total Outstanding on the beginning of the day,1000.00,
2,Fresh Exposure taken during the day,300.50,
3,Exposure liquidated during the day,100.25,
4,Net scripwise outstanding at the end of the day,1200.25,
Symbol,Name,Qty Fin by all the members(No.of Shares),Amt Fin by all the members(Rs. In Lakhs)
20MICRONS,20 MICRONS LTD,181987,700.20
360ONE,360 ONE WAM LIMITED,237595,"500.00"
3MINDIA,3M INDIA LIMITED,5762,0.05
* Figures are rounded to the nearest decimal.,,,
"""

NSE_REVISED = """,,,,,,Data revised for reporting date 03NOV2025 to include late member submissions,,,
SEBI REPORT AS ON 03-NOV-2025,,,,,,,,,
,,As on Reporting Date 03-NOV-2025,,,,,,As on Current Date 06-NOV-2025 for reporting date 03-NOV-2025,
,Sr.No.,Particulars,Rs. In Lakhs,,,,Sr.No.,Particulars,Rs. In Lakhs
,1,Scripwise Total Outstanding on the beginning of the day,1000.00,,,,1,Scripwise Total Outstanding on the beginning of the day,1001.00
,2,Fresh Exposure taken during the day,200.00,,,,2,Fresh Exposure taken during the day,210.00
,3,Exposure liquidated during the day,100.00,,,,3,Exposure liquidated during the day,101.00
,4,Net scripwise outstanding at the end of the day,1100.00,,,,4,Net scripwise outstanding at the end of the day,1110.00
Symbol,Name,Qty Fin by all the members(No.of Shares),Amt Fin by all the members(Rs. In Lakhs),,,Symbol,Name,Qty Fin by all the members(No.of Shares),Amt Fin by all the members(Rs. In Lakhs)
AAA,AAA LTD,10,600.00,,,AAA,AAA LTD,10,605.00
BBB,BBB LTD,20,500.00,,,BBB,BBB LTD,21,505.00
,,,,,,CCC,CCC LTD,1,0.00
* Figures are rounded to the nearest decimal.,,,,,,* Figures are rounded to the nearest decimal.,,,
"""

BSE_CSV = ('ISIN,Security,Quantity Financed by Members (No.of Shares),Amount Financed by Members (Rs. lakh)\r\n'
           'INE117A01022,ABB Ltd.,9924,728.12\r\n'
           'INE059A01026,"Cipla Ltd.,",22323,323.22\r\n'
           'INE296A01032,Total Transport Systems Ltd,10,1.00\r\n'
           'INF277KA1984,Tata Mutual Fund - Permitted,1137985,258.93\r\n')

BSE_ARCHIVE = ('Security Code,Security,Quantity Financed by Members (No.of Shares),Amount Financed by Members (Rs. lakh),'
               'Total Outstanding at BOD,Fresh Exposure during Day,Exposure Liquidated during Day,Net Outstanding Position at EOD\r\n'
               '533655,TRITURBINE,1010318,2844.55,2844.61,0.03,0.09,2844.55\r\n'
               '534976,VMART,73281,2075.83,2076.00,0.00,0.18,2075.82\r\n')


def nse_zip(text):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("Mrg_Trading_291225.csv", text)
    return buf.getvalue()


class NseParsing(unittest.TestCase):
    def test_standard_file(self):
        p = m.parse_nse_csv(NSE_STANDARD)
        self.assertEqual((p["opening"], p["fresh"], p["liquidated"], p["closing"]), (1000.0, 300.5, 100.25, 1200.25))
        self.assertEqual([s["symbol"] for s in p["securities"]], ["20MICRONS", "360ONE", "3MINDIA"])
        self.assertFalse(p["revised"])
        self.assertEqual(p["title_dates"], {date(2025, 12, 29)})
        rec, reason = m.nse_record(date(2025, 12, 29), p, "sha", "mrg_trading_291225.zip", "t")
        self.assertIsNone(reason)
        self.assertEqual(rec["closing_cr"], 12.0025)
        self.assertEqual(rec["securities"], 3)
        self.assertEqual(rec["flags"], [])

    def test_revised_file_uses_the_right_hand_block(self):
        p = m.parse_nse_csv(NSE_REVISED)
        self.assertEqual((p["opening"], p["fresh"], p["liquidated"], p["closing"]), (1001.0, 210.0, 101.0, 1110.0))
        self.assertEqual([(s["symbol"], s["amount_lakh"]) for s in p["securities"]],
                         [("AAA", 605.0), ("BBB", 505.0), ("CCC", 0.0)])
        self.assertTrue(p["revised"])
        self.assertEqual(p["revised_as_of"], date(2025, 11, 6))
        self.assertEqual(p["title_dates"], {date(2025, 11, 3)})
        rec, _ = m.nse_record(date(2025, 11, 3), p, "sha", "f", "t")
        self.assertEqual((rec["revised"], rec["revised_as_of"]), (True, "2025-11-06"))

    def test_file_for_another_date_is_rejected(self):
        rec, reason = m.nse_record(date(2025, 12, 30), m.parse_nse_csv(NSE_STANDARD), "sha", "f", "t")
        self.assertIsNone(rec)
        self.assertIn("2025-12-29", reason)

    def test_checks_flag_inconsistent_totals(self):
        bad = NSE_STANDARD.replace("1200.25,", "1300.25,")
        rec, _ = m.nse_record(date(2025, 12, 29), m.parse_nse_csv(bad), "sha", "f", "t")
        self.assertEqual(rec["flags"], ["arithmetic", "detail_sum"])

    def test_residual_is_kept_and_judged_by_the_rounding_bound(self):
        # 3 rows: the bound is 0.005 × 4 = 0.02 lakh
        ok = NSE_STANDARD.replace("0.05\n", "0.06\n")            # residual +0.01: within rounding
        rec, _ = m.nse_record(date(2025, 12, 29), m.parse_nse_csv(ok), "sha", "f", "t")
        self.assertEqual((rec["detail_residual_lakh"], rec["flags"]), (0.01, []))
        off = NSE_STANDARD.replace("0.05\n", "0.10\n")           # residual +0.05: beyond it
        rec, _ = m.nse_record(date(2025, 12, 29), m.parse_nse_csv(off), "sha", "f", "t")
        self.assertEqual(rec["flags"], ["detail_sum"])

    def test_duplicate_and_negative_rows_are_flagged_and_kept(self):
        text = NSE_STANDARD.replace("3MINDIA,3M INDIA LIMITED,5762,0.05", "360ONE,DUPLICATE,-5,0.05")
        rec, _ = m.nse_record(date(2025, 12, 29), m.parse_nse_csv(text), "sha", "f", "t")
        self.assertEqual(rec["flags"], ["duplicate_ids", "negative_values"])
        self.assertEqual(rec["securities"], 3)

    def test_empty_file_is_not_stored(self):
        rec, reason = m.nse_record(date(2025, 12, 29), m.parse_nse_csv("SEBI Report,,,\n"), "sha", "f", "t")
        self.assertIsNone(rec)
        self.assertIn("no closing", reason)

    def test_zip_round_trip(self):
        text, sha = m.read_nse_zip(nse_zip(NSE_STANDARD))
        self.assertEqual(text, NSE_STANDARD)
        self.assertEqual(len(sha), 64)


class BseParsing(unittest.TestCase):
    def test_financed_csv(self):
        p = m.parse_bse_csv(BSE_CSV.encode())
        self.assertEqual([s["id"] for s in p["securities"]],
                         ["INE117A01022", "INE059A01026", "INE296A01032", "INF277KA1984"])
        self.assertEqual(p["securities"][1]["name"], "Cipla Ltd.,")
        self.assertEqual(p["securities"][1]["isin"], "INE059A01026")
        rec, _ = m.bse_record(date(2026, 9, 24), p, "sha", "t")
        self.assertEqual(rec["amount_financed_cr"], round((728.12 + 323.22 + 1.00 + 258.93) / 100, 4))
        self.assertIsNone(rec["closing_cr"])           # this layout publishes no flows

    def test_archive_layout_sums_the_flows(self):
        p = m.parse_bse_csv(BSE_ARCHIVE)
        self.assertEqual(p["opening"], 4920.61)
        self.assertEqual(p["closing"], 4920.37)
        self.assertEqual(p["securities"][0]["id"], "533655")

    def test_total_row_without_an_id_is_skipped(self):
        p = m.parse_bse_csv(BSE_CSV + ",Total,,1311.27\r\n")
        self.assertEqual(len(p["securities"]), 4)


class Planning(unittest.TestCase):
    DATES = [date(2026, 10, d) for d in (20, 21, 22, 23, 26, 27, 28, 29, 30)]

    def test_recent_window_then_older_missing_days_newest_first(self):
        window, older = m.plan_dates(self.DATES, {"2026-10-21": {}}, {"2026-10-20": "404"}, recent=3, backfill=10)
        self.assertEqual(window, self.DATES[-3:])
        self.assertEqual(older, [date(2026, 10, d) for d in (27, 26, 23, 22)])

    def test_backfill_cap_and_retry(self):
        _, older = m.plan_dates(self.DATES, {}, {"2026-10-27": "404"}, recent=3, backfill=2)
        self.assertEqual(older, [date(2026, 10, 26), date(2026, 10, 23)])
        _, older = m.plan_dates(self.DATES, {}, {"2026-10-27": "404"}, recent=3, backfill=2, retry=True)
        self.assertEqual(older, [date(2026, 10, 27), date(2026, 10, 26)])


class Reply:
    def __init__(self, status, content):
        self.status_code, self.content = status, content


class FakeSession:
    def __init__(self, replies):
        self.replies, self.urls = replies, []

    def get(self, url, **kw):
        self.urls.append(url)
        for key, reply in self.replies.items():
            if key in url:
                if isinstance(reply, Exception):
                    raise reply
                return reply
        return Reply(404, b"")


def empty_store():
    return {"nse": {}, "bse": {}, "unavailable": {"nse": {}, "bse": {}}, "updated_at": None}


class Runs(unittest.TestCase):
    def test_nse_run_stores_new_days_and_skips_unchanged_files(self):
        dates = [date(2025, 12, 26), date(2025, 12, 29)]
        session = FakeSession({"291225": Reply(200, nse_zip(NSE_STANDARD)), "261225": Reply(200, b"")})
        store = empty_store()
        changed, errors, ok, latest = m.run_exchange("nse", session, m.fetch_nse, store, dates, 5, "t",
                                                     pause=lambda s: None)
        self.assertEqual((changed, errors, ok), (["2025-12-29"], 0, 2))
        self.assertEqual(latest[0], "2025-12-29")
        self.assertEqual(store["unavailable"]["nse"], {})   # recent days are never marked unavailable
        again, *_ = m.run_exchange("nse", session, m.fetch_nse, store, dates, 5, "t2", pause=lambda s: None)
        self.assertEqual(again, [])
        self.assertEqual(store["nse"]["2025-12-29"]["fetched_at"], "t")

    def test_old_missing_day_is_marked_unavailable_and_errors_are_not(self):
        dates = [date(2025, 1, 2), date(2025, 1, 3)] + [date(2025, 12, d) for d in range(1, 11)]
        session = FakeSession({"020125": Reply(404, b""), "030125": Reply(503, b"busy")})
        store = empty_store()
        _, errors, _, _ = m.run_exchange("nse", session, m.fetch_nse, store, dates, 5, "t", pause=lambda s: None)
        self.assertEqual(errors, 1)
        self.assertEqual(list(store["unavailable"]["nse"]), ["2025-01-02"])

    def test_bse_run(self):
        session = FakeSession({"24%2F09%2F2026": Reply(200, BSE_CSV.encode())})
        store = empty_store()
        changed, *_ = m.run_exchange("bse", session, m.fetch_bse, store, [date(2026, 9, 24)], 5, "t",
                                     pause=lambda s: None)
        self.assertEqual(changed, ["2026-09-24"])
        self.assertEqual(store["bse"]["2026-09-24"]["securities"], 4)

    def test_a_refusing_exchange_is_asked_nothing_more(self):
        session = FakeSession({"mrg_trading": Reply(403, b"denied")})
        dates = [date(2025, 12, d) for d in (1, 2, 3, 4)]
        _, errors, ok, _ = m.run_exchange("nse", session, m.fetch_nse, empty_store(), dates, 5, "t",
                                          pause=lambda s: None)
        self.assertEqual((errors, ok, len(session.urls)), (1, 0, 1))

    def test_partial_file_is_not_stored(self):
        store = empty_store()
        for day in ("2026-09-21", "2026-09-22", "2026-09-23"):
            store["bse"][day] = {"date": day, "securities": 10, "amount_financed_cr": 7.0, "sha256": day}
        session = FakeSession({"24%2F09%2F2026": Reply(200, BSE_CSV.encode())})   # 4 rows vs usual 10
        changed, *_ = m.run_exchange("bse", session, m.fetch_bse, store, [date(2026, 9, 24)], 5, "t",
                                     pause=lambda s: None)
        self.assertEqual(changed, [])
        self.assertNotIn("2026-09-24", store["bse"])

    def test_stored_partial_days_move_to_unavailable(self):
        store = empty_store()
        for day, n in (("2026-01-13", 1688), ("2026-01-14", 326), ("2026-01-16", 1690), ("2026-03-02", 11)):
            store["bse"][day] = {"date": day, "securities": n, "amount_financed_cr": 1.0, "sha256": day}
        dropped = m.drop_partial_days(store)
        self.assertEqual([k for _, k, _ in dropped], ["2026-01-14", "2026-03-02"])
        self.assertEqual(sorted(store["bse"]), ["2026-01-13", "2026-01-16"])
        self.assertIn("partial file (326 securities", store["unavailable"]["bse"]["2026-01-14"])

    def test_bse_html_error_page_is_an_error(self):
        session = FakeSession({"24%2F09%2F2026": Reply(200, b"<html>" + b"x" * 500 + b"</html>")})
        _, errors, ok, _ = m.run_exchange("bse", session, m.fetch_bse, empty_store(), [date(2026, 9, 24)], 5, "t",
                                          pause=lambda s: None)
        self.assertEqual((errors, ok), (1, 0))


class Output(unittest.TestCase):
    def store(self):
        s = empty_store()
        s["nse"]["2026-10-29"] = {"date": "2026-10-29", "closing_cr": 100.0, "sha256": "a"}
        s["nse"]["2026-10-30"] = {"date": "2026-10-30", "closing_cr": 110.0, "sha256": "b"}
        s["bse"]["2026-10-30"] = {"date": "2026-10-30", "amount_financed_cr": 7.5, "sha256": "c"}
        return s

    def test_combined_only_where_both_exchanges_published(self):
        doc = m.build_doc(self.store(), "t")
        self.assertEqual(doc["combined"], [{"date": "2026-10-30", "nse_cr": 110.0, "bse_cr": 7.5, "total_cr": 117.5}])
        self.assertEqual(doc["latest"], {"nse": "2026-10-30", "bse": "2026-10-30", "combined": "2026-10-30"})

    def test_file_is_rewritten_only_when_data_changes_and_round_trips(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "mtf_daily.json"
            self.assertTrue(m.write_if_changed(path, m.build_doc(self.store(), "t1")))
            self.assertFalse(m.write_if_changed(path, m.build_doc(self.store(), "t2")))
            self.assertEqual(json.loads(path.read_text())["updated_at"], "t1")
            text = path.read_text()
            self.assertIn('\n  {"date": "2026-10-30", "closing_cr": 110.0', text)   # one day per line
            again = m.load_store(path)
            self.assertEqual(sorted(again["nse"]), ["2026-10-29", "2026-10-30"])

    def test_apply_day_replaces_a_revised_file(self):
        s = self.store()
        self.assertFalse(m.apply_day(s, "nse", date(2026, 10, 30), {"sha256": "b"}, None, True))
        self.assertTrue(m.apply_day(s, "nse", date(2026, 10, 30), {"sha256": "b2", "revised": True}, None, True))
        self.assertTrue(s["nse"]["2026-10-30"]["revised"])

    def test_stocks_snapshot_largest_first(self):
        doc = m.stocks_doc({"nse": ("2025-12-29", m.parse_nse_csv(NSE_STANDARD))}, "t")
        self.assertEqual(doc["nse"]["date"], "2025-12-29")
        self.assertEqual([r[0] for r in doc["nse"]["rows"]], ["20MICRONS", "360ONE", "3MINDIA"])
        self.assertIsNone(doc["bse"])


class Supabase(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.current = []

        def rest(method, table, params=None, body=None):
            self.calls.append((method, table, params, body))
            return self.current if method == "GET" else None
        self.db = m.MtfSupabase("https://x.supabase.co", "k", write_stocks=True, rest=rest)
        p = m.parse_nse_csv(NSE_STANDARD)
        self.parsed = p
        self.rec, _ = m.nse_record(date(2025, 12, 29), p, "sha1", "mrg_trading_291225.zip", "t")

    def test_first_write_inserts_revision_1(self):
        self.assertEqual(self.db.write_day("nse", self.rec, self.parsed, "u"), "revision 1")
        methods = [(c[0], c[1]) for c in self.calls]
        self.assertEqual(methods, [("GET", "exchange_daily"), ("POST", "exchange_daily"), ("POST", "stock_daily")])
        row = self.calls[1][3][0]
        self.assertEqual((row["exchange"], row["end_outstanding_lakh"], row["revision"]), ("NSE", 1200.25, 1))
        self.assertEqual(row["source_name"], "NSE CM - Margin Trading Disclosure")
        self.assertEqual(len(self.calls[2][3]), 3)

    def test_revision_retires_the_current_rows(self):
        self.current = [{"id": 7, "revision": 1, "metadata": {"sha256": "old"}}]
        self.assertEqual(self.db.write_day("nse", self.rec, self.parsed, "u"), "revision 2")
        methods = [(c[0], c[1]) for c in self.calls]
        self.assertEqual(methods[:3], [("GET", "exchange_daily"), ("PATCH", "exchange_daily"), ("PATCH", "stock_daily")])
        self.assertEqual(self.calls[1][3], {"is_current": False})

    def test_same_file_is_skipped(self):
        self.current = [{"id": 7, "revision": 1, "metadata": {"sha256": "sha1"}}]
        self.assertEqual(self.db.write_day("nse", self.rec, self.parsed, "u"), "unchanged")
        self.assertEqual(len(self.calls), 1)


class WorkflowWiring(unittest.TestCase):
    """The daily workflow runs the pipeline after NSE and BSE, waits for it before
    deploying, and its commit message is one Vercel skips (data only)."""

    def setUp(self):
        self.wf = (ROOT / ".github" / "workflows" / "exchange-update.yml").read_text()

    def test_job_runs_after_nse_and_bse_and_deploy_waits(self):
        job = self.wf[self.wf.index("\n  mtf-update:"):self.wf.index("\n  deploy:")]
        self.assertIn("needs: [nse-update, bse-update]", job)
        self.assertIn("python scripts/mtf_pipeline.py", job)
        deploy = self.wf[self.wf.index("\n  deploy:"):self.wf.index("\n  summary:")]
        self.assertIn("mtf-update", deploy)

    def test_commit_message_is_a_skipped_bot_commit(self):
        self.assertIn('git commit -m "📊 MTF update: ', self.wf)
        self.assertIn('"📊 MTF update: "*', (ROOT / "dashboard" / "vercel-ignore-build.sh").read_text())


if __name__ == "__main__":
    unittest.main()
