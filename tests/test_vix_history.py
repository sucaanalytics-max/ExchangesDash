"""India VIX 10-year history (scripts/india_vix_history.py) and its dashboard
panel's model (dashboard/js/25-vix-history.js, run in Node).

The window keeps closes dated after the same day ten years before the latest;
mean and σ (sample, n − 1) are over that window and z = (close − mean) ÷ σ;
a short or stale fetch never replaces the file; the committed file has the
shape the dashboard reads; and the JS model reads it back with the same z and
bands, zooming to 5 or 1 years without changing them."""

import json
import math
import statistics
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from helpers import NODE, ROOT, js_eval

import india_vix_history as vh

HIST_JS = ["fmtNum", "vixHistYearsBefore", "vixHistModel", "vixHistZ", "vixHistTickIdx"]
DATA_FILE = ROOT / "dashboard" / "data" / "india_vix_history.json"
WORKFLOW = ROOT / ".github" / "workflows" / "exchange-update.yml"


def weekday_closes(start, end, f):
    """{date: f(i)} on weekdays from start to end (date objects)."""
    out, d, i = {}, start, 0
    while d <= end:
        if d.weekday() < 5:
            out[d.isoformat()] = f(i)
            i += 1
        d += timedelta(days=1)
    return out


class Window(unittest.TestCase):
    def test_years_before_handles_leap_day(self):
        self.assertEqual(vh.years_before(date(2026, 11, 26), 10), date(2016, 11, 26))
        self.assertEqual(vh.years_before(date(2028, 2, 29), 10), date(2018, 2, 28))

    def test_trim_keeps_dates_after_the_same_day_ten_years_back(self):
        closes = {"2016-11-25": 20.0, "2016-11-26": 21.0, "2016-11-28": 22.0, "2026-11-26": 15.0}
        rows = vh.trim_window(closes, 10)
        self.assertEqual([d for d, _ in rows], ["2016-11-28", "2026-11-26"])
        self.assertEqual(vh.trim_window({}, 10), [])

    def test_clean_drops_bad_closes_and_rounds(self):
        out = vh.clean_closes([("2026-11-20", 15.123456), ("2026-11-21", float("nan")), ("2026-11-22", 0),
                               ("2026-11-23", None), ("2026-11-24", "x"), ("2026-11-25 00:00:00+05:30", 16.0)])
        self.assertEqual(out, {"2026-11-20": 15.1235, "2026-11-25": 16.0})


class Stats(unittest.TestCase):
    def test_mean_sample_sd_z_and_rank(self):
        vals = [10.0, 12.0, 14.0, 16.0, 30.0]
        rows = [(f"2026-01-0{i + 1}", v) for i, v in enumerate(vals)]
        s = vh.vix_stats(rows)
        mean, sd = statistics.mean(vals), statistics.stdev(vals)   # stdev: n − 1
        self.assertEqual(s["n"], 5)
        self.assertAlmostEqual(s["mean"], round(mean, 4))
        self.assertAlmostEqual(s["sd"], round(sd, 4))
        self.assertEqual(s["latest"]["date"], "2026-01-05")
        self.assertEqual(s["latest"]["vix"], 30.0)
        self.assertAlmostEqual(s["latest"]["z"], round((30.0 - mean) / sd, 4))
        self.assertEqual(s["latest"]["pct_below"], 0.8)

    def test_degenerate_windows(self):
        self.assertEqual(vh.vix_stats([]), {"n": 0, "mean": None, "sd": None, "latest": None})
        one = vh.vix_stats([("2026-01-01", 15.0)])
        self.assertIsNone(one["sd"])
        self.assertIsNone(one["latest"]["z"])
        flat = vh.vix_stats([("2026-01-01", 15.0), ("2026-01-02", 15.0)])
        self.assertEqual(flat["sd"], 0)
        self.assertIsNone(flat["latest"]["z"])


class Doc(unittest.TestCase):
    def rows(self):
        closes = weekday_closes(date(2016, 11, 1), date(2026, 11, 26), lambda i: 15 + 5 * math.sin(i / 30))
        return vh.trim_window(closes)

    def test_build_and_dump_round_trip(self):
        rows = self.rows()
        doc = vh.build_doc(rows)
        text = vh.dumps_doc(doc)
        self.assertEqual(json.loads(text), doc)
        self.assertEqual(doc["from"], "2016-11-28")
        self.assertEqual(doc["to"], "2026-11-26")
        self.assertEqual(doc["stats"]["n"], len(doc["daily"]))
        # one daily row per line: a day's update is a small diff
        self.assertIn('\n  ["2026-11-26",', text)

    def test_main_writes_only_good_newer_changed_data(self):
        rows = dict(self.rows())
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "vix.json"
            with mock.patch.object(vh, "fetch_closes", return_value=rows):
                vh.main(out)
            first = out.read_text()
            self.assertEqual(json.loads(first)["to"], "2026-11-26")
            # unchanged closes: file left alone
            with mock.patch.object(vh, "fetch_closes", return_value=rows), mock.patch.object(Path, "write_text") as w:
                vh.main(out)
                w.assert_not_called()
            # a short history (Yahoo served part of it) is not written
            short = dict(list(rows.items())[-100:])
            with mock.patch.object(vh, "fetch_closes", return_value=short):
                vh.main(out)
            self.assertEqual(out.read_text(), first)
            # an older latest close than the file's is not written
            older = {d: v for d, v in rows.items() if d < "2026-11-20"}
            with mock.patch.object(vh, "fetch_closes", return_value=older):
                vh.main(out)
            self.assertEqual(out.read_text(), first)
            # a failed fetch keeps the file and does not fail the job
            with mock.patch.object(vh, "fetch_closes", side_effect=RuntimeError("Yahoo down")):
                self.assertEqual(vh.main(out), 0)
            self.assertEqual(out.read_text(), first)

    def test_fetch_leaves_out_todays_unfinished_bar(self):
        # A stand-in for yfinance's frame keeps pandas out (CI does not install it):
        # iterrows() over tz-aware IST midnights, as yfinance indexes ^INDIAVIX
        ist = timezone(timedelta(hours=5, minutes=30))
        hist = mock.Mock()
        hist.iterrows.return_value = [(datetime(2026, 11, 25, tzinfo=ist), {"Close": 17.67}),
                                      (datetime(2026, 11, 26, tzinfo=ist), {"Close": 16.9})]
        fake = mock.Mock()
        fake.Ticker.return_value.history.return_value = hist
        with mock.patch.dict("sys.modules", {"yfinance": fake}):
            during = vh.fetch_closes(datetime(2026, 11, 26, 7, 0, tzinfo=timezone.utc))    # 12:30 IST
            after = vh.fetch_closes(datetime(2026, 11, 26, 11, 0, tzinfo=timezone.utc))    # 16:30 IST
        self.assertEqual(during, {"2026-11-25": 17.67})
        self.assertEqual(after, {"2026-11-25": 17.67, "2026-11-26": 16.9})


class CommittedFile(unittest.TestCase):
    """The file the dashboard reads has the shape vixHistModel expects."""

    def test_shape(self):
        doc = json.loads(DATA_FILE.read_text())
        self.assertEqual(doc["window_years"], 10)
        daily = doc["daily"]
        self.assertGreater(len(daily), vh.MIN_ROWS)
        dates = [d for d, _ in daily]
        self.assertEqual(dates, sorted(set(dates)))
        self.assertTrue(all(isinstance(v, (int, float)) and v > 0 for _, v in daily))
        self.assertEqual((doc["from"], doc["to"]), (dates[0], dates[-1]))
        self.assertGreater(dates[0], vh.years_before(date.fromisoformat(dates[-1]), 10).isoformat())
        self.assertEqual(doc["stats"], vh.vix_stats([tuple(r) for r in daily]))


class Workflow(unittest.TestCase):
    def test_nse_job_runs_and_commits_it(self):
        wf = WORKFLOW.read_text()
        job = wf[wf.index("  nse-update:"):wf.index("  bse-update:")]
        self.assertIn("run: python scripts/india_vix_history.py", job)
        self.assertIn("git add dashboard/data/india_vix_history.json", job)
        step = job[job.index("- name: India VIX history"):job.index("- name: Check if new data was added")]
        self.assertIn("continue-on-error: true", step)


@unittest.skipUnless(NODE, "node not installed")
class DashboardModel(unittest.TestCase):
    def doc(self):
        closes = weekday_closes(date(2016, 11, 28), date(2026, 11, 26), lambda i: 12 + (i % 17))
        return vh.build_doc(vh.trim_window(closes))

    def test_model_matches_python_stats(self):
        doc = self.doc()
        m = js_eval(HIST_JS, f"vixHistModel({json.dumps(doc)})")
        s = doc["stats"]
        self.assertEqual(len(m["rows"]), s["n"])
        self.assertEqual((m["from"], m["to"], m["n"]), (doc["from"], doc["to"], s["n"]))
        self.assertAlmostEqual(m["latest"]["z"], s["latest"]["z"], places=3)
        self.assertEqual(m["latest"]["pctBelow"], s["latest"]["pct_below"])
        self.assertAlmostEqual(m["bands"]["p2"], s["mean"] + 2 * s["sd"])
        self.assertAlmostEqual(m["bands"]["m1"], s["mean"] - s["sd"])
        r = m["rows"][10]
        self.assertAlmostEqual(r["z"], (r["vix"] - s["mean"]) / s["sd"])

    def test_zoom_keeps_ten_year_bands(self):
        doc = self.doc()
        ten, one = js_eval(HIST_JS, f"[10, 1].map(y => vixHistModel({json.dumps(doc)}, y))")
        self.assertEqual(one["rows"][0]["date"], "2025-11-27")
        self.assertEqual(one["rows"][-1]["date"], "2026-11-26")
        self.assertEqual(one["bands"], ten["bands"])
        self.assertEqual(one["latest"], ten["latest"])

    def test_unusable_files(self):
        doc = self.doc()
        bad = [None, {}, {**doc, "daily": []}, {**doc, "stats": {**doc["stats"], "sd": 0}},
               {**doc, "stats": {**doc["stats"], "mean": None}}]
        self.assertEqual(js_eval(HIST_JS, f"{json.dumps(bad)}.map(d => vixHistModel(d))"), [None] * len(bad))

    def test_ticks_at_each_year_or_month_start(self):
        dates = ["2016-11-28", "2016-12-30", "2017-01-02", "2017-01-03", "2017-02-01", "2018-01-01"]
        self.assertEqual(js_eval(HIST_JS, f"vixHistTickIdx({json.dumps(dates)}, true)"), [2, 5])
        self.assertEqual(js_eval(HIST_JS, f"vixHistTickIdx({json.dumps(dates)}, false)"), [1, 2, 4, 5])

    def test_z_label_and_leap_day(self):
        self.assertEqual(js_eval(HIST_JS, "[vixHistZ(0.0655), vixHistZ(-1.254), vixHistZ(null)]"),
                         ["+0.07σ", "−1.25σ", "—"])
        self.assertEqual(js_eval(HIST_JS, "vixHistYearsBefore('2028-02-29', 10)"), "2018-02-28")


if __name__ == "__main__":
    unittest.main()
