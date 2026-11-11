"""scripts/broker_mtf_register.py (the brokers' disclosed MTF books) and
mtf_pipeline.brokers_doc, which prices each figure against the exchanges'
combined book (mtf_daily.json) for the MTF mode's Brokers tab."""

import json
import tempfile
import unittest
import unittest.mock
from datetime import date
from pathlib import Path

from helpers import DASHBOARD  # also puts scripts/ on the path
import broker_mtf_register as reg
import mtf_pipeline as m


def comb(*pairs):
    return [{"date": d, "nse_cr": v, "bse_cr": 0.0, "total_cr": v} for d, v in pairs]


def fig(broker, as_of, measure="unstated", basis="period_end", book=None, share=None, **kw):
    d = {"broker": broker, "as_of": as_of, "measure": measure, "basis": basis, "source": "Doc", "url": "https://x.in/a.pdf",
         "page": 3, "quote": "MTF book stood at …"}
    if book is not None:
        d["book_cr"] = book
    if share is not None:
        d["share_pct"] = share
    d.update(kw)
    return d


BROKERS = {
    "bank": {"name": "Bank Securities", "short": "Bank Sec", "type": "bank", "parent": "Bank",
             "primary": {"measure": "share", "basis": "period_end"},
             "sources": {"primary": "Bank presentation", "where": "x", "cadence": "quarterly", "lag_days": 20, "metric": "share"}},
    "disc": {"name": "Discount Broking", "short": "Disc", "type": "discount", "parent": None,
             "primary": {"measure": "net", "basis": "period_end"},
             "sources": {"primary": "Letter", "where": "x", "cadence": "quarterly", "lag_days": 15, "metric": "net book"}},
    "rated": {"name": "Rated Securities", "short": "Rated", "type": "full_service", "parent": None,
              "primary": {"measure": "gross", "basis": "period_end"},
              "sources": {"primary": "ICRA", "where": "x", "cadence": "irregular", "lag_days": 150, "metric": "gross"}},
}

COMBINED = comb(("2025-06-30", 80000.0), ("2025-09-30", 100000.0), ("2026-03-30", 110000.0), ("2026-06-30", 140744.0),
                ("2026-07-01", 141000.0), ("2026-07-31", 145000.0), ("2026-09-30", 158714.0))

DISCLOSURES = [
    fig("bank", "2025-09-30", "share", share=16.0),
    fig("bank", "2026-06-30", "share", share=16.5),
    fig("bank", "2026-06-30", "net", book=18538),
    fig("bank", "2026-09-30", "share", share=16.1),
    fig("disc", "2025-09-30", "net", book=1668),
    fig("disc", "2026-03-31", "net", book=2814),                 # 31 Mar 2026 was a holiday: the 30 Mar book
    fig("disc", "2026-06-30", "net", book=3775),
    fig("disc", "2026-07-31", "net", "month_avg", book=4000),
    fig("disc", "2026-09-30", "net", book=4351),
    fig("rated", "2024-12-31", "gross", book=7470),              # before the fixture's series: no share
    fig("rated", "2026-06-30", "gross", book=12799),
    fig("rated", "2026-06-30", "net", book=10081),
]


class Register(unittest.TestCase):
    def test_register_is_valid(self):
        self.assertEqual(reg.validate(), [])

    def test_every_broker_has_a_source_map(self):
        for bid, b in reg.BROKERS.items():
            with self.subTest(broker=bid):
                self.assertIn(b["sources"]["cadence"], reg.CADENCES)
                self.assertTrue(b["sources"]["primary"])

    def test_figures_cite_primary_documents(self):
        for d in reg.DISCLOSURES:
            with self.subTest(broker=d["broker"], as_of=d["as_of"]):
                self.assertNotIn("mtf.trading", d["url"])
                self.assertTrue(d["quote"].strip())

    def test_validate_catches_mistakes(self):
        bad = [fig("disc", "2026-06-30", "net", book=3775, share=2.0),           # both
               fig("disc", "2026-06-30", "share", book=3775),                    # share without share_pct
               fig("nobody", "2026-06-30", "net", book=1),                       # unknown broker
               fig("disc", "30-06-2026", "net", book=1, url="http://x.in"),      # date, url
               fig("disc", "2026-09-30", "net", book=1, extra=1),                # unknown field
               fig("disc", "2026-09-30", "net", book=2),                         # duplicate
               fig("bank", "2026-01-01", "share", share=10)]                     # out of order
        problems = "\n".join(reg.validate(BROKERS, bad))
        for want in ("exactly one of book_cr and share_pct", "measure 'share' needs share_pct", "unknown broker",
                     "as_of must be YYYY-MM-DD", "url must be https", "unknown fields", "duplicate figure",
                     "rows must follow BROKERS order", "rated: no figure on its primary measure"):
            self.assertIn(want, problems)
        self.assertEqual(reg.validate(BROKERS, DISCLOSURES), [])


class BrokersDoc(unittest.TestCase):
    def setUp(self):
        self.doc = m.brokers_doc(COMBINED, "2026-11-09T00:00:00Z", BROKERS, DISCLOSURES)
        self.by = {b["id"]: {(p["as_of"], p["measure"], p["basis"]): p for p in b["series"]} for b in self.doc["brokers"]}

    def test_share_published_derives_the_book(self):
        # ICICI Bank: 16.5 % at 30 Jun 2026 on a ₹1,40,744 Cr book → ≈ ₹23.2K Cr
        p = self.by["bank"][("2026-06-30", "share", "period_end")]
        self.assertTrue(p["derived"])
        self.assertAlmostEqual(p["book_cr"], 23222.8, places=1)
        self.assertEqual((p["industry_cr"], p["industry_date"]), (140744.0, "2026-06-30"))

    def test_book_gives_the_share(self):
        p = self.by["disc"][("2026-09-30", "net", "period_end")]
        self.assertAlmostEqual(p["share_pct"], 4351 / 158714 * 100, places=3)
        self.assertNotIn("derived", p)
        self.assertEqual(p["source"], "Doc")

    def test_period_end_takes_the_last_reporting_day_within_a_week(self):
        p = self.by["disc"][("2026-03-31", "net", "period_end")]
        self.assertEqual(p["industry_date"], "2026-03-30")
        early = self.by["rated"][("2024-12-31", "gross", "period_end")]
        self.assertIsNone(early["industry_cr"])
        self.assertIsNone(early["share_pct"])
        at = m.industry_lookup(COMBINED)
        self.assertEqual(at("2026-01-15", "period_end"), (None, None))       # 3 Oct gap... the 30 Sep book is too old
        self.assertEqual(at("2026-10-31", "month_avg"), (None, None))        # October is not in the series

    def test_month_average_uses_the_months_days(self):
        p = self.by["disc"][("2026-07-31", "net", "month_avg")]
        self.assertEqual(p["industry_cr"], (141000.0 + 145000.0) / 2)
        self.assertIsNone(p["industry_date"])

    def test_changes_only_on_the_same_measure_and_basis(self):
        disc = self.by["disc"]
        sep = disc[("2026-09-30", "net", "period_end")]
        self.assertEqual(sep["chg"]["from"], "2026-06-30")                   # not the July monthly average
        self.assertAlmostEqual(sep["chg"]["book_pct"], 4351 / 3775 - 1, places=4)
        self.assertAlmostEqual(sep["chg"]["share_pp"], 4351 / 158714 * 100 - 3775 / 140744 * 100, places=3)
        self.assertEqual(sep["yoy"]["from"], "2025-09-30")
        self.assertIsNone(disc[("2026-07-31", "net", "month_avg")]["chg"])
        bank = self.by["bank"]
        self.assertIsNone(bank[("2026-06-30", "net", "period_end")]["chg"])   # first net figure
        self.assertAlmostEqual(bank[("2026-09-30", "share", "period_end")]["chg"]["share_pp"], -0.4, places=6)
        self.assertIsNone(self.by["rated"][("2026-06-30", "gross", "period_end")]["yoy"])   # 18 months back

    def test_quarter_table_on_the_primary_measure(self):
        qs = self.doc["quarters"]
        self.assertEqual(len(qs), m.BROKER_QUARTERS)
        self.assertEqual(qs[-1]["end"], "2026-09-30")
        self.assertEqual(qs[-1]["label"], "Q2 FY 2027")
        jun = next(q for q in qs if q["end"] == "2026-06-30")
        self.assertEqual(set(jun["shares"]), {"bank", "disc", "rated"})
        self.assertEqual(jun["shares"]["bank"], 16.5)                         # the published share, not the net book
        self.assertAlmostEqual(jun["shares"]["rated"], 12799 / 140744 * 100, places=3)   # gross, not net
        self.assertEqual(jun["tracked_n"], 3)
        self.assertEqual(next(q for q in qs if q["end"] == "2025-12-31")["tracked_n"], 0)

    def test_doc_carries_metadata_and_is_stable(self):
        self.assertEqual([b["id"] for b in self.doc["brokers"]], list(BROKERS))
        self.assertEqual(self.doc["brokers"][0]["primary"], {"measure": "share", "basis": "period_end"})
        self.assertEqual(set(self.doc["measures"]), set(reg.MEASURES))
        again = m.brokers_doc(COMBINED, "2026-11-10T00:00:00Z", BROKERS, DISCLOSURES)
        again["updated_at"] = self.doc["updated_at"]
        self.assertEqual(again, self.doc)                                    # nothing depends on today
        json.dumps(self.doc, allow_nan=False)


class Due(unittest.TestCase):
    def test_quarterly_irregular_and_monthly(self):
        brokers = dict(BROKERS)
        brokers["mon"] = {**BROKERS["disc"], "sources": {**BROKERS["disc"]["sources"], "cadence": "monthly", "lag_days": 6}}
        figs = DISCLOSURES + [fig("mon", "2026-09-30", "net", book=1)]
        ids = lambda today: {d[0]: d for d in m.brokers_due(today, brokers, figs)}
        now = ids(date(2026, 11, 9))
        self.assertEqual(set(now), {"mon"})                                   # Oct figure was due 6 Nov
        self.assertEqual(now["mon"], ("mon", "2026-09-30", "2026-10-31", "2026-11-06"))
        self.assertNotIn("rated", ids(date(2026, 11, 27)))                    # irregular: 150 days after 30 Jun
        self.assertEqual(ids(date(2026, 11, 28))["rated"], ("rated", "2026-06-30", None, "2026-11-27"))
        late = ids(date(2027, 1, 21))
        self.assertEqual(late["bank"], ("bank", "2026-09-30", "2026-12-31", "2027-01-20"))
        self.assertEqual(late["disc"][2:], ("2026-12-31", "2027-01-15"))

    def test_mid_quarter_figure_is_due_at_its_quarter_end(self):
        figs = [fig("disc", "2026-08-26", "net", book=1)]
        due = m.brokers_due(date(2026, 10, 16), BROKERS, figs)
        self.assertEqual(due, [("disc", "2026-08-26", "2026-09-30", "2026-10-15")])


GROWW_PAGE = """<html><head><script>var cached = "MTF Net Book ₹99.99 Bn";</script></head><body>
<h2>Our Metrics as of 09 Nov 2026</h2>
<div><p>Transacting Users</p><p>24.2 Mn</p></div>
<div><p>MTF Net Book</p><p>&#8377;39.72 Bn</p></div>
<p>Disclaimer: Data for Stocks Turnover reflect the current calendar quarter. MTF Net Book, MF Assets and Stock
Assets are platform-level figures based on the latest available data. Total Transacting Users are for Groww only.</p>
</body></html>"""

FEEDS = {"disc": {"url": "https://x.in/ir", "parser": "groww_ir", "measure": "net", "source": "Disc IR page",
                  "note": "platform-level"}}


class Resp:
    def __init__(self, status, text=""):
        self.status_code, self.text = status, text


class LiveFeeds(unittest.TestCase):
    def test_parse_groww_page(self):
        r = m.parse_groww_ir(GROWW_PAGE)
        self.assertEqual((r["date"], r["book_cr"]), ("2026-11-09", 3972.0))     # the visible figure, not the script's
        self.assertIn("MTF Net Book ₹39.72 Bn", r["quote"])
        self.assertIn("platform-level figures based on the latest available data.", r["quote"])

    def test_changed_page_is_not_read(self):
        self.assertIsNone(m.parse_groww_ir(GROWW_PAGE.replace("platform-level", "consolidated")))
        self.assertIsNone(m.parse_groww_ir(GROWW_PAGE.replace("Our Metrics as of", "Metrics on")))
        self.assertIsNone(m.parse_groww_ir(GROWW_PAGE.replace("&#8377;39.72 Bn", "n/a")))
        self.assertIsNone(m.parse_groww_ir(""))

    def test_fetch_failures_only_warn(self):
        feed = FEEDS["disc"]
        self.assertIsNone(m.fetch_live(feed, get=lambda url: Resp(403)))
        self.assertIsNone(m.fetch_live(feed, get=lambda url: (_ for _ in ()).throw(OSError("reset"))))
        self.assertIsNone(m.fetch_live(feed, get=lambda url: Resp(200, "<html>new layout</html>")))
        r = m.fetch_live(feed, get=lambda url: Resp(200, GROWW_PAGE))
        self.assertEqual((r["book_cr"], r["url"]), (3972.0, "https://x.in/ir"))

    def test_store_one_reading_per_weekday(self):
        rd = lambda d, v: {"date": d, "book_cr": v, "quote": "q", "url": "https://x.in/ir"}
        store = {}
        self.assertEqual(m.update_live_store(store, "disc", rd("2026-11-09", 3972), "t1"), (True, "stored"))
        self.assertEqual(m.update_live_store(store, "disc", rd("2026-11-09", 3972), "t2"), (False, "unchanged"))
        self.assertEqual(m.update_live_store(store, "disc", rd("2026-11-09", 3970), "t3"), (True, "stored"))
        self.assertEqual([(r["date"], r["book_cr"], r["fetched_at"]) for r in store["disc"]], [("2026-11-09", 3970, "t3")])
        self.assertFalse(m.update_live_store(store, "disc", rd("2026-11-14", 3990), "t4")[0])       # Saturday
        changed, why = m.update_live_store(store, "disc", rd("2026-11-10", 6000), "t5")             # +51 %: misread
        self.assertFalse(changed)
        self.assertIn("not stored", why)
        self.assertTrue(m.update_live_store(store, "disc", rd("2026-11-06", 3900), "t6")[0])        # kept in date order
        self.assertEqual([r["date"] for r in store["disc"]], ["2026-11-06", "2026-11-09"])

    def test_refresh_keeps_stored_readings_when_a_fetch_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "live.json"
            with unittest.mock.patch.object(m, "BROKER_LIVE_PATH", path):
                m.refresh_live("2026-11-09T08:00:00Z", get=lambda url: Resp(200, GROWW_PAGE), feeds=FEEDS)
                m.refresh_live("2026-11-10T08:00:00Z", get=lambda url: Resp(503), feeds=FEEDS)
            doc = json.loads(path.read_text())
            self.assertEqual([(r["date"], r["book_cr"]) for r in doc["readings"]["disc"]], [("2026-11-09", 3972.0)])

    def test_live_readings_are_their_own_series(self):
        live = {"disc": [{"date": "2026-09-30", "book_cr": 4300, "quote": "q", "url": "https://x.in/ir"},
                         {"date": "2026-10-01", "book_cr": 4400, "quote": "q", "url": "https://x.in/ir"}]}
        doc = m.brokers_doc(COMBINED, "t", BROKERS, DISCLOSURES, live=live, feeds=FEEDS)
        series = next(b for b in doc["brokers"] if b["id"] == "disc")["series"]
        lv = [p for p in series if p["basis"] == "live"]
        self.assertEqual([(p["as_of"], p["measure"], p.get("rounded")) for p in lv], [("2026-09-30", "net", True), ("2026-10-01", "net", True)])
        self.assertIsNone(lv[0]["chg"])                                          # not compared with the letter's 30 Sep
        self.assertEqual(lv[1]["chg"]["from"], "2026-09-30")
        self.assertEqual(lv[1]["industry_date"], "2026-09-30")                   # priced on or before, as a period end
        letter = next(p for p in series if p["as_of"] == "2026-09-30" and p["basis"] == "period_end")
        self.assertEqual(letter["chg"]["from"], "2026-06-30")                    # the letter series is untouched
        self.assertEqual(m.brokers_doc(COMBINED, "t", BROKERS, DISCLOSURES, live={"nobody": live["disc"]}, feeds=FEEDS),
                         m.brokers_doc(COMBINED, "t", BROKERS, DISCLOSURES, feeds=FEEDS))   # no feed, no rows

    def test_register_live_feeds(self):
        self.assertEqual(reg.validate(BROKERS, DISCLOSURES + [fig("rated", "2026-07-01", "gross", "live", book=1)])[-1],
                         "rated 2026-07-01 (12): basis 'live' is for the readings the MTF job fetches (LIVE_FEEDS), "
                         "not hand-kept rows")
        self.assertIn("LIVE_FEEDS ghost: unknown broker", reg.validate(BROKERS, DISCLOSURES, {"ghost": FEEDS["disc"]}))
        for bid, f in reg.LIVE_FEEDS.items():
            self.assertIn(f["parser"], m.LIVE_PARSERS)


class BrokersOnly(unittest.TestCase):
    def test_rebuilds_from_the_committed_daily_file_without_network(self):
        with tempfile.TemporaryDirectory() as tmp:
            daily, out = Path(tmp) / "mtf_daily.json", Path(tmp) / "mtf_brokers.json"
            daily.write_text(json.dumps({"combined": COMBINED}))
            with unittest.mock.patch.object(m, "OUT_PATH", daily), unittest.mock.patch.object(m, "BROKERS_PATH", out), \
                    unittest.mock.patch.object(m, "BROKER_LIVE_PATH", Path(tmp) / "none.json"), \
                    unittest.mock.patch.object(m, "fetch_live", side_effect=AssertionError("fetched")), \
                    unittest.mock.patch.object(m, "report_brokers_due"), \
                    unittest.mock.patch("sys.argv", ["mtf_pipeline.py", "--brokers-only"]), \
                    unittest.mock.patch.dict("sys.modules", {"nse_pipeline": None, "bse_pipeline": None}):
                self.assertEqual(m.main(), 0)
            doc = json.loads(out.read_text())
            self.assertEqual([b["id"] for b in doc["brokers"]], list(reg.BROKERS))
            self.assertEqual(doc["quarters"][-1]["end"], "2026-09-30")


class CommittedFile(unittest.TestCase):
    def test_committed_file_matches_the_register(self):
        path = DASHBOARD / "data" / "mtf_brokers.json"
        if not path.exists():
            self.skipTest("no committed mtf_brokers.json")
        doc = json.loads(path.read_text())
        self.assertEqual([b["id"] for b in doc["brokers"]], list(reg.BROKERS))
        live_path = DASHBOARD / "data" / "mtf_broker_live.json"
        live = json.loads(live_path.read_text()).get("readings", {}) if live_path.exists() else {}
        n = sum(len(b["series"]) for b in doc["brokers"])
        n_live = sum(len(v) for k, v in live.items() if k in reg.LIVE_FEEDS)
        self.assertEqual(n, len(reg.DISCLOSURES) + n_live, "rebuild it: python3 scripts/mtf_pipeline.py --brokers-only")


if __name__ == "__main__":
    unittest.main()
