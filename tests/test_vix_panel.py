"""VIX panel maths (dashboard/js/21-vix.js), run in Node.

The elasticity fit ln(rev / MA45) ~ 1 + weekday dummies + β·ln(VIX / VIXMA45)
recovers a known β, the projection ADR45 × (V / VIX45)^β with today's and the
base rows folded into the level grid, the week-on-week VIX table keyed by
cpWeekStart, the live VIX ticker's reading (live, delayed, pre-open, last close, or
the daily close when the poll file has none), the live tick's in-place update of
the sensitivity table, and the live cards surviving a VIX failure."""

import datetime as dt
import math
import unittest

from helpers import NODE, js_eval

VIX_JS = ["VIX_FIT_FROM", "VIX_LEVELS", "VIX_MA", "cpWeekStart", "vixByDate", "vixFitSample", "vixOLS",
          "vixFit", "vixBase", "vixMean", "vixSensitivityRows", "vixWeeklyRows"]


def weekdays_from(start, count):
    d, out = dt.date.fromisoformat(start), []
    while len(out) < count:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += dt.timedelta(days=1)
    return out


def synthetic_rows(count=200, beta=0.7):
    """Weekdays from 2025-02-03 whose revenue obeys the model exactly, up to a small
    deterministic noise: y = β·x + 0.3·[Tue] + 0.1·[Thu] + ε, built one day at a time
    so the 45-day revenue MA each day sees is the one the model was written against."""
    dates = weekdays_from("2025-02-03", count)
    vix = [15.5 + 4.5 * math.sin(2 * math.pi * i / 40) for i in range(count)]
    rev = []
    for i, d in enumerate(dates):
        if i < 45:
            rev.append(50.0 + (i % 5))
            continue
        ma = sum(rev[i - 45:i]) / 45
        vma = sum(vix[i - 45:i]) / 45
        x = math.log(vix[i] / vma)
        wd = dt.date.fromisoformat(d).weekday()
        eps = 0.005 * (((i * 7919) % 13) - 6) / 6
        y = beta * x + (0.3 if wd == 1 else 0) + (0.1 if wd == 3 else 0) + eps
        rev.append(ma * math.exp(y))
    return [{"date": d, "total_rev": r, "vix": v} for d, r, v in zip(dates, rev, vix)]


def fit(rows):
    return js_eval(VIX_JS, "vixFit(vixFitSample(DATA.rows, vixByDate(DATA.rows)))", {"rows": rows})


PER_EX = {"nse": {"adr": 50, "beta": 0.7}, "bse": {"adr": 10, "beta": 0.7}, "mcx": {"adr": 5, "beta": 0.2}}


def sens(per_ex=PER_EX, vix45=14.5, today=None, rng=None):
    return js_eval(VIX_JS, "vixSensitivityRows(DATA.p, DATA.v45, DATA.t, DATA.r)",
                   {"p": per_ex, "v45": vix45, "t": today, "r": rng or {"min": 10, "max": 30}})


@unittest.skipUnless(NODE, "node not installed")
class VixFit(unittest.TestCase):
    def test_fit_recovers_beta(self):
        f = fit(synthetic_rows())
        self.assertLess(abs(f["beta"] - 0.7), 0.02)
        self.assertGreaterEqual(f["n"], 60)
        self.assertEqual(f["n"], 155)   # 200 days less the first 45 without a full window
        self.assertGreater(f["r2Vix"], 0)
        self.assertAlmostEqual(f["r2Vix"], f["r2"] - f["r2Dow"], places=12)

    def test_fit_short_sample_none(self):
        self.assertIsNone(fit(synthetic_rows(count=45 + 59)))
        self.assertIsNotNone(fit(synthetic_rows(count=45 + 60)))

    def test_sample_rules(self):
        rows = synthetic_rows(count=120)
        # a modelled row is dropped before the window is taken; a day without VIX
        # or with no revenue is not a sample point
        rows.insert(60, {"date": "2025-04-26", "total_rev": 1e6, "vix": 99, "modelled": True})
        rows[80]["vix"] = 0
        rows[90]["total_rev"] = 0
        s = js_eval(VIX_JS, "vixFitSample(DATA.rows, vixByDate(DATA.rows))", {"rows": rows})
        dates = [p["date"] for p in s]
        self.assertNotIn("2025-04-26", dates)
        self.assertNotIn(rows[80]["date"], dates)
        self.assertNotIn(rows[90]["date"], dates)
        self.assertEqual(len(s), 120 - 45 - 2)
        # the first point: its 45-row window is the 45 rows before it
        r = [x for x in rows if not x.get("modelled")]
        ma = sum(x["total_rev"] for x in r[:45]) / 45
        vma = sum(x["vix"] for x in r[:45]) / 45
        self.assertAlmostEqual(s[0]["y"], math.log(r[45]["total_rev"] / ma), places=12)
        self.assertAlmostEqual(s[0]["x"], math.log(r[45]["vix"] / vma), places=12)
        # `from` cuts the start, not the window
        late = js_eval(VIX_JS, "vixFitSample(DATA.rows, vixByDate(DATA.rows), '2025-05-01')", {"rows": rows})
        self.assertTrue(all(p["date"] >= "2025-05-01" for p in late))
        self.assertEqual(late[0]["y"], next(p for p in s if p["date"] >= "2025-05-01")["y"])

    def test_dow_weekend_takes_friday(self):
        s = js_eval(VIX_JS, "vixFitSample(DATA.rows, vixByDate(DATA.rows), '2025-01-01')", {"rows": [
            {"date": f"2024-11-{d:02d}", "total_rev": 10, "vix": 14} for d in range(1, 30)
        ] + [{"date": f"2024-12-{d:02d}", "total_rev": 10, "vix": 14} for d in range(1, 30)] + [
            {"date": "2025-02-01", "total_rev": 12, "vix": 15},    # Saturday (Budget day)
            {"date": "2025-02-03", "total_rev": 11, "vix": 15},    # Monday
            {"date": "2025-02-04", "total_rev": 11, "vix": 15},    # Tuesday
        ]})
        self.assertEqual([(p["date"], p["dow"]) for p in s], [("2025-02-01", 4), ("2025-02-03", 0), ("2025-02-04", 1)])

    def test_bse_takes_nse_vix_by_date(self):
        nse = synthetic_rows(count=150)
        bse = [{"date": r["date"], "total_rev": r["total_rev"] / 5} for r in nse]
        bse.append({"date": "2025-09-06", "total_rev": 9})   # no NSE VIX that day: left out
        s = js_eval(VIX_JS, "vixFitSample(DATA.bse, vixByDate(DATA.nse))", {"nse": nse, "bse": bse})
        self.assertEqual(len(s), 150 - 45)
        self.assertNotIn("2025-09-06", [p["date"] for p in s])

    def test_vix_ma_over_the_window_rows_with_vix(self):
        # MCX trades some NSE holidays: such a day sits in the 45-row windows (revenue
        # MA) and its missing VIX shrinks the VIX MA to the window's other 44 days
        nse = synthetic_rows(count=150)
        mcx = [{"date": r["date"], "total_rev": r["total_rev"] / 4} for r in nse]
        mcx.insert(100, {"date": "2025-06-21", "total_rev": 9})   # a Saturday, between rows 99 and 100
        vix = {r["date"]: r["vix"] for r in nse}
        s = {p["date"]: p for p in js_eval(VIX_JS, "vixFitSample(DATA.mcx, vixByDate(DATA.nse))",
                                           {"nse": nse, "mcx": mcx})}
        i = 120   # its window, rows 75..119, holds the Saturday
        window = mcx[i - 45:i]
        vs = [vix[r["date"]] for r in window if r["date"] in vix]
        self.assertEqual(len(vs), 44)
        p = s[mcx[i]["date"]]
        self.assertAlmostEqual(p["x"], math.log(vix[mcx[i]["date"]] / (sum(vs) / 44)), places=12)
        self.assertAlmostEqual(p["y"], math.log(mcx[i]["total_rev"] / (sum(r["total_rev"] for r in window) / 45)),
                               places=12)

    def test_ols_and_singular(self):
        b = js_eval(VIX_JS, "vixOLS([[1,0],[1,1],[1,2],[1,3]], [1,3,5,7])")
        self.assertAlmostEqual(b[0], 1, places=10)
        self.assertAlmostEqual(b[1], 2, places=10)
        self.assertIsNone(js_eval(VIX_JS, "vixOLS([[1,2],[2,4],[3,6]], [1,2,3])"))

    def test_base_and_mean(self):
        rows = [{"date": f"2026-01-{d:02d}", "total_rev": d, "vix": d if d % 2 else 0} for d in range(1, 11)]
        rows.append({"date": "2026-01-11", "total_rev": 1000, "modelled": True})
        self.assertEqual(js_eval(VIX_JS, "vixBase(DATA, 4)", rows), (7 + 8 + 9 + 10) / 4)
        self.assertEqual(js_eval(VIX_JS, "vixMean(DATA, 2)", rows), (7 + 9) / 2)
        self.assertEqual(js_eval(VIX_JS, "vixByDate(DATA)", rows[:4]), {"2026-01-01": 1, "2026-01-03": 3})
        self.assertIsNone(js_eval(VIX_JS, "vixBase([])"))
        self.assertIsNone(js_eval(VIX_JS, "vixMean([{vix: 0}])"))


@unittest.skipUnless(NODE, "node not installed")
class VixSensitivity(unittest.TestCase):
    def test_projection_maths(self):
        rows = sens(today=29)
        base = next(r for r in rows if r["vix"] == 14.5)
        self.assertEqual(base["kind"], "base")
        self.assertEqual(base["adr"]["nse"], 50)
        self.assertEqual(base["pctVsBase"], 0)
        self.assertEqual(base["total"], 65)
        self.assertEqual(base["totalPct"], 0)
        top = next(r for r in rows if r["vix"] == 29)
        self.assertEqual(top["kind"], "today")
        self.assertAlmostEqual(top["adr"]["nse"], 50 * 2 ** 0.7, delta=1e-9)
        self.assertAlmostEqual(top["adr"]["mcx"], 5 * 2 ** 0.2, delta=1e-9)
        self.assertAlmostEqual(top["pctVsBase"], 1.0, delta=1e-12)
        self.assertAlmostEqual(top["total"], 60 * 2 ** 0.7 + 5 * 2 ** 0.2, delta=1e-9)
        self.assertAlmostEqual(top["totalPct"], top["total"] / 65 - 1, delta=1e-12)
        self.assertEqual([r["vix"] for r in rows], sorted(r["vix"] for r in rows))
        self.assertEqual(len(rows), 11 + 2)
        self.assertEqual([r["kind"] for r in rows].count("level"), 11)

    def test_today_row_dedupes_level(self):
        rows = sens(today=15.03)
        at15 = [r for r in rows if 14.9 < r["vix"] < 15.1]
        self.assertEqual(len(at15), 1)
        self.assertEqual((at15[0]["vix"], at15[0]["kind"]), (15.03, "today"))
        self.assertEqual(len(rows), 11 + 1)   # 15 folded into today, base 14.5 added
        vix = [r["vix"] for r in sens(today=15.52)]
        i = vix.index(15.52)
        self.assertEqual((vix[i - 1], vix[i + 1]), (15, 16))
        self.assertEqual([r["kind"] for r in sens(today=15.52)][i], "today")
        # the base folds a level the same way
        rows = sens(vix45=13.96)
        self.assertEqual([(r["vix"], r["kind"]) for r in rows if 13.5 < r["vix"] < 14.5], [(13.96, "base")])
        # today and base on the same spot: one row, today
        rows = sens(vix45=14.5, today=14.53)
        near = [(r["vix"], r["kind"]) for r in rows if 14.2 < r["vix"] < 14.8]
        self.assertEqual(near, [(14.53, "today")])
        # no today row without today's VIX
        self.assertNotIn("today", [r["kind"] for r in sens(today=None)])

    def test_outside_range_flag(self):
        rows = {r["vix"]: r["outside"] for r in sens(rng={"min": 10, "max": 21})}
        self.assertTrue(rows[22])
        self.assertTrue(rows[25])
        self.assertFalse(rows[20])
        self.assertFalse(rows[11])
        self.assertTrue({r["vix"]: r["outside"] for r in sens(rng={"min": 11.5, "max": 30})}[11])

    def test_null_beta_excluded_from_total(self):
        per_ex = {**PER_EX, "mcx": {"adr": 5, "beta": None}}
        for r in sens(per_ex=per_ex, today=18.7):
            self.assertIsNone(r["adr"]["mcx"])
            self.assertAlmostEqual(r["total"], r["adr"]["nse"] + r["adr"]["bse"], delta=1e-9)
            self.assertAlmostEqual(r["totalPct"], r["total"] / 60 - 1, delta=1e-12)


def nse_week(dates, vix):
    return [{"date": d, "total_rev": 50, "vix": v} for d, v in zip(dates, vix)]


@unittest.skipUnless(NODE, "node not installed")
class VixWeekly(unittest.TestCase):
    W1 = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"]
    W2 = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"]
    W3 = ["2026-11-16", "2026-11-17"]

    def rows(self, weeks=8, extra=None):
        nse = (nse_week(self.W1, [12, 13, 14, 15, 16]) + nse_week(self.W2, [15, 15, 16, 16, 18])
               + nse_week(self.W3, [17, 15.5]) + (extra or []))
        total = {d: 60 + i for i, d in enumerate(self.W1 + self.W2 + self.W3)}
        total["2026-11-14"] = 999   # an MCX-only Saturday: not an NSE session, not in the week's ADR
        return js_eval(VIX_JS, "vixWeeklyRows(DATA.nse, DATA.total, DATA.weeks)",
                       {"nse": nse, "total": total, "weeks": weeks})

    def test_weekly_rows(self):
        rows = self.rows()
        self.assertEqual([r["week"] for r in rows], ["2026-11-16", "2026-11-09", "2026-11-02"])
        self.assertEqual([r["label"] for r in rows], ["16–17 Nov", "9–13 Nov", "2–6 Nov"])
        self.assertEqual([r["sessions"] for r in rows], [2, 5, 5])
        self.assertEqual([r["avgVix"] for r in rows], [16.25, 16, 14])
        self.assertEqual([r["closeVix"] for r in rows], [15.5, 18, 16])
        self.assertEqual([r["inProgress"] for r in rows], [True, False, False])
        self.assertAlmostEqual(rows[1]["chgPts"], 2, places=12)
        self.assertAlmostEqual(rows[1]["chgPct"], 16 / 14 - 1, places=12)
        self.assertAlmostEqual(rows[0]["chgPts"], 0.25, places=12)
        self.assertEqual(rows[2]["totalAdr"], 62)        # 60..64
        self.assertEqual(rows[1]["totalAdr"], 67)        # 65..69, not the Saturday's 999
        self.assertEqual(rows[0]["totalAdr"], 70.5)

    def test_week_end_vix_is_the_last_session(self):
        # the week's last session has no VIX yet: blank, not an earlier day's close
        rows = self.rows(extra=[{"date": "2026-11-18", "total_rev": 50, "vix": 0}])
        self.assertEqual(rows[0]["sessions"], 3)
        self.assertIsNone(rows[0]["closeVix"])
        self.assertEqual(rows[0]["avgVix"], 16.25)   # the average still uses the days that have VIX
        self.assertAlmostEqual(rows[1]["totalPct"], 67 / 62 - 1, places=12)
        self.assertIsNone(rows[2]["chgPts"])
        self.assertIsNone(rows[2]["chgPct"])
        self.assertIsNone(rows[2]["totalPct"])

    def test_weeks_limit_keeps_change_vs_older_week(self):
        # the oldest row shown still compares with the week before it when the data has one
        rows = self.rows(weeks=2)
        self.assertEqual([r["week"] for r in rows], ["2026-11-16", "2026-11-09"])
        self.assertAlmostEqual(rows[1]["chgPts"], 2, places=12)
        self.assertAlmostEqual(rows[1]["chgPct"], 16 / 14 - 1, places=12)
        self.assertAlmostEqual(rows[1]["totalPct"], 67 / 62 - 1, places=12)

    def test_eight_of_nine_weeks(self):
        dates = weekdays_from("2026-09-14", 45)   # nine full weeks, 14 Sep – 13 Nov
        nse = [{"date": d, "total_rev": 50, "vix": 12 + i // 5} for i, d in enumerate(dates)]
        total = {d: 100 + i // 5 for i, d in enumerate(dates)}
        rows = js_eval(VIX_JS, "vixWeeklyRows(DATA.nse, DATA.total)", {"nse": nse, "total": total})
        self.assertEqual(len(rows), 8)
        self.assertEqual(rows[-1]["week"], "2026-09-21")
        self.assertAlmostEqual(rows[-1]["chgPts"], 1, places=12)
        self.assertAlmostEqual(rows[-1]["chgPct"], 13 / 12 - 1, places=12)
        self.assertAlmostEqual(rows[-1]["totalPct"], 101 / 100 - 1, places=12)
        # exactly eight weeks of data: nothing older, so the oldest row's changes are null
        rows = js_eval(VIX_JS, "vixWeeklyRows(DATA.nse, DATA.total)", {"nse": nse[5:], "total": total})
        self.assertEqual((len(rows), rows[-1]["week"]), (8, "2026-09-21"))
        self.assertIsNone(rows[-1]["chgPts"])
        self.assertIsNone(rows[-1]["chgPct"])
        self.assertIsNone(rows[-1]["totalPct"])

    def test_week_through_friday_is_not_in_progress(self):
        extra = nse_week(["2026-11-18", "2026-11-19", "2026-11-20"], [15, 15, 15])
        self.assertFalse(self.rows(extra=extra)[0]["inProgress"])

    def test_label_across_months(self):
        rows = js_eval(VIX_JS, "vixWeeklyRows(DATA, {})",
                       nse_week(["2026-09-28", "2026-09-29", "2026-10-01", "2026-10-02"], [14, 14, 14, 14]))
        self.assertEqual(rows[0]["label"], "28 Sep – 2 Oct")
        self.assertIsNone(rows[0]["totalAdr"])
        self.assertFalse(rows[0]["inProgress"])


TICKER_JS = ["LIVE_STALE_MINUTES", "vixTickerModel"]


def ticker(live, rows, now=None):
    expr = "vixTickerModel(DATA.live, DATA.rows" + (", Date.parse(DATA.now))" if now else ")")
    return js_eval(TICKER_JS, expr, {"live": live, "rows": rows, "now": now})


LIVE_VIX = {"last": 15.52, "previous_close": 14.9, "change": 0.62, "pct_change": 4.16,
            "as_of": "2026-11-19T06:00:00Z", "source": "nse"}


@unittest.skipUnless(NODE, "node not installed")
class VixTicker(unittest.TestCase):
    def test_ticker_falls_back_to_daily(self):
        m = ticker(None, [{"date": "2026-11-17", "vix": 15.52}, {"date": "2026-11-18", "vix": 0}])
        self.assertEqual((m["kind"], m["last"], m["when"]), ("close", 15.52, "2026-11-17"))
        self.assertIsNone(m["change"])   # no earlier close to compare with
        m = ticker({"last": None}, [{"date": "2026-11-16", "vix": 14}, {"date": "2026-11-17", "vix": 15.4}])
        self.assertEqual((m["kind"], m["last"], m["when"]), ("close", 15.4, "2026-11-17"))
        self.assertAlmostEqual(m["change"], 1.4, places=9)
        self.assertAlmostEqual(m["pctChange"], 10, places=9)   # percent, like the poller's pct_change
        self.assertIsNone(ticker(None, [{"date": "2026-11-17", "vix": 0}]))

    def test_ticker_stale(self):
        m = ticker({**LIVE_VIX, "stale_since": "2026-11-19T06:10:00Z"}, [], now="2026-11-19T06:12:00Z")
        self.assertEqual((m["kind"], m["last"], m["change"], m["pctChange"]), ("stale", 15.52, 0.62, 4.16))
        self.assertEqual(m["when"], "2026-11-19T06:00:00Z")
        # outside market hours or on a later day the held value is an earlier session's
        # last reading, as the live cards treat their polls: a close, not a delay
        flagged = {**LIVE_VIX, "stale_since": "2026-11-19T06:10:00Z"}
        self.assertEqual(ticker(flagged, [], now="2026-11-19T11:00:00Z")["kind"], "close")   # 16:30 IST
        self.assertEqual(ticker(flagged, [], now="2026-11-21T06:00:00Z")["kind"], "close")   # Saturday
        self.assertEqual(ticker(flagged, [], now="2026-11-20T06:00:00Z")["kind"], "close")   # next session, no read yet

    def test_ticker_live_and_close(self):
        # 11:30 IST on a Thursday, polled 2 min ago: live
        self.assertEqual(ticker(LIVE_VIX, [], now="2026-11-19T06:02:00Z")["kind"], "live")
        # in market hours but the last read is 40 min old: delayed
        self.assertEqual(ticker(LIVE_VIX, [], now="2026-11-19T06:40:00Z")["kind"], "stale")
        # after the 16:00 IST close: the last close
        self.assertEqual(ticker({**LIVE_VIX, "as_of": "2026-11-19T10:55:00Z"}, [], now="2026-11-19T12:00:00Z")["kind"], "close")
        # next morning before the first poll: yesterday's reading is a close, not a delay
        self.assertEqual(ticker({**LIVE_VIX, "as_of": "2026-11-18T10:55:00Z"}, [], now="2026-11-19T04:00:00Z")["kind"], "close")
        # an official daily close newer than the live reading wins
        m = ticker({**LIVE_VIX, "as_of": "2026-11-17T10:55:00Z"},
                   [{"date": "2026-11-17", "vix": 15}, {"date": "2026-11-18", "vix": 16.1}], now="2026-11-19T04:00:00Z")
        self.assertEqual((m["kind"], m["last"], m["when"]), ("close", 16.1, "2026-11-18"))

    def test_ticker_daily_close_wins_after_session(self):
        # last poll at 14:00 IST on 19 Nov; the evening pipeline has added 19 Nov's close
        poll = {**LIVE_VIX, "as_of": "2026-11-19T08:30:00Z"}
        daily = [{"date": "2026-11-18", "vix": 15.0}, {"date": "2026-11-19", "vix": 16.2}]
        m = ticker(poll, daily, now="2026-11-19T15:00:00Z")    # 20:30 IST
        self.assertEqual((m["kind"], m["last"], m["when"], m["source"]), ("close", 16.2, "2026-11-19", "daily"))
        self.assertAlmostEqual(m["change"], 1.2, places=9)
        # during the session the poll still wins over a same-date daily row
        self.assertEqual(ticker({**poll, "as_of": "2026-11-19T08:58:00Z"}, daily, now="2026-11-19T09:00:00Z")["kind"], "live")
        # after the close with no daily row for that date yet, the poll is the last close
        m = ticker(poll, daily[:1], now="2026-11-19T15:00:00Z")
        self.assertEqual((m["kind"], m["last"], m["source"]), ("close", 15.52, "nse"))

    def test_ticker_preopen(self):
        # 09:00 IST on a Thursday, read at 08:58 IST (the poller starts at 08:55): pre-open, not "last close"
        pre = {**LIVE_VIX, "as_of": "2026-11-19T03:28:00Z"}
        self.assertEqual(ticker(pre, [], now="2026-11-19T03:30:00Z")["kind"], "preopen")
        # once trading starts at 09:15 the same read is judged like any other: delayed when old ...
        self.assertEqual(ticker(pre, [], now="2026-11-19T03:50:00Z")["kind"], "stale")
        # ... live when fresh
        self.assertEqual(ticker({**LIVE_VIX, "as_of": "2026-11-19T03:46:00Z"}, [], now="2026-11-19T03:50:00Z")["kind"], "live")
        # yesterday's reading at 09:00 IST is still the last close; so is a Saturday-morning read
        self.assertEqual(ticker({**LIVE_VIX, "as_of": "2026-11-18T10:55:00Z"}, [], now="2026-11-19T03:30:00Z")["kind"], "close")
        self.assertEqual(ticker({**LIVE_VIX, "as_of": "2026-11-21T03:28:00Z"}, [], now="2026-11-21T03:30:00Z")["kind"], "close")

    def test_ticker_preopen_label(self):
        html = js_eval(TICKER_JS + ["vixIstParts", "vixTickerHTML", "escHtml", "fmtNum"],
                       "(globalThis.fmtTradeDate = iso => iso, vixTickerHTML(vixTickerModel(DATA.live, [], Date.parse(DATA.now))))",
                       {"live": {**LIVE_VIX, "as_of": "2026-11-19T03:28:00Z"}, "now": "2026-11-19T03:30:00Z"})
        self.assertIn("Pre-open 08:58", html)
        self.assertNotIn("Last close", html)


# The live cards' cycle with the VIX feature failing: the NSE/BSE cards are still
# drawn and the banner still refreshed (renderLiveCards / buildLiveCards).
LIVE_CARDS_HARNESS = r"""(() => {
  const el = { innerHTML: '' }, warned = [];
  let banner = 0;
  globalThis.document = { getElementById: () => el };
  globalThis.console = { ...console, warn: (msg) => warned.push(msg) };
  globalThis.liveCardFor = ex => ex;
  globalThis.liveCardHTML = ex => `<card ${ex}>`;
  globalThis.vixTickerNow = () => { if (DATA.throwNow) throw new Error('no VIX'); return {}; };
  globalThis.vixTickerHTML = () => { if (DATA.throwHtml) throw new Error('bad VIX'); return '<vix>'; };
  globalThis.vixPanelSyncToday = () => { if (DATA.throwSync) throw new Error('bad panel'); };
  globalThis.updateLatestRevBanner = () => { banner++; };
  LIVE_CARD_CACHE.nse = { tried: true };
  buildLiveCards();
  return { html: el.innerHTML, banner, warned };
})()"""


@unittest.skipUnless(NODE, "node not installed")
class LiveCardsSurviveVix(unittest.TestCase):
    def run_cards(self, **throws):
        return js_eval(["LIVE_CARD_EXCHANGES", "LIVE_CARD_CACHE", "renderLiveCards", "buildLiveCards"],
                       LIVE_CARDS_HARNESS, throws)

    def test_cards_and_banner_with_vix_working(self):
        out = self.run_cards()
        self.assertEqual((out["html"], out["banner"], out["warned"]), ("<card nse><card bse><vix>", 1, []))

    def test_cards_and_banner_when_vix_throws(self):
        for throws in ({"throwNow": True}, {"throwHtml": True}, {"throwSync": True},
                       {"throwHtml": True, "throwSync": True}):
            with self.subTest(**throws):
                out = self.run_cards(**throws)
                self.assertTrue(out["html"].startswith("<card nse><card bse>"))
                self.assertEqual(out["html"].endswith("<vix>"), not (throws.get("throwNow") or throws.get("throwHtml")))
                self.assertEqual(out["banner"], 1)
                self.assertEqual(len(out["warned"]), len(throws))


# A live tick (vixPanelSyncToday) rewrites only the sensitivity table's rows and
# footnote in place; the panel itself (open explainer, scroll positions, the
# week-on-week table) is not redrawn. Without the table it falls back to a redraw.
SYNC_HARNESS = r"""(() => {
  let redraws = 0;
  const tbody = { innerHTML: 'old rows' }, foot = { innerHTML: 'old foot' };
  const panel = { querySelector: sel => (sel === 'tbody' ? (DATA.noTable ? null : tbody) : sel === ':scope > .rx-foot' ? foot : null) };
  const el = { firstChild: {}, querySelector: sel => (sel === '#vixSensPanel' ? panel : null),
               set innerHTML(v) { redraws++; }, get innerHTML() { return ''; } };
  globalThis.document = { getElementById: () => el };
  globalThis.fmtTradeDate = iso => iso;
  globalThis.renderVixPanel = () => { redraws++; };
  const model = { perEx: { nse: { adr: 50, beta: 0.7, fit: {} }, bse: { adr: 10, beta: 0.7, fit: {} }, mcx: { adr: 5, beta: 0.2, fit: {} } },
                  vix45: 14.5, range: { min: 10, max: 30 } };
  globalThis.VIX_PANEL = { model, today: '14|live|' };
  const ticks = [];
  for (const last of [14, 15.2, 15.2]) {
    globalThis.vixTickerNow = () => ({ kind: 'live', last, source: 'nse', when: '2026-11-19T06:00:00Z' });
    vixPanelSyncToday();
    ticks.push({ rows: tbody.innerHTML, foot: foot.innerHTML, redraws, today: VIX_PANEL.today });
  }
  return ticks;
})()"""

SYNC_JS = ["VIX_LEVELS", "VIX_EXCHANGES", "vixSensitivityRows", "vixSensitivityBodyHTML", "vixSensitivityFoot",
           "vixTodayKey", "vixPanelSyncToday", "fmtNum", "escHtml", "rxSignedPct"]


@unittest.skipUnless(NODE, "node not installed")
class VixPanelLiveTick(unittest.TestCase):
    def test_tick_updates_rows_in_place(self):
        same, changed, again = js_eval(SYNC_JS, SYNC_HARNESS, {})
        self.assertEqual((same["rows"], same["redraws"]), ("old rows", 0))     # same reading: nothing touched
        self.assertIn("15.20", changed["rows"])
        self.assertIn("vix-today", changed["rows"])
        self.assertIn("live reading, 15.20", changed["foot"])
        self.assertEqual(changed["redraws"], 0)                                  # panel not redrawn
        self.assertEqual(changed["today"], "15.2|live|")
        self.assertEqual((again["rows"], again["redraws"]), (changed["rows"], 0))

    def test_tick_without_table_redraws(self):
        ticks = js_eval(SYNC_JS, SYNC_HARNESS, {"noTable": True})
        self.assertEqual([t["redraws"] for t in ticks], [0, 1, 2])


if __name__ == "__main__":
    unittest.main()


@unittest.skipUnless(NODE, "node not installed")
class VixFeeBasisLabel(unittest.TestCase):
    def test_cross_exchange_label_names_mcx_source_values(self):
        names = ["FEE_BASIS_SHORT", "hasFeeVariant", "feeBasisOf", "feeUnitLabelFor"]
        self.assertEqual(js_eval(names, "feeUnitLabelFor(['nse', 'bse', 'mcx'])"),
                         "NSE/BSE at today's rates · MCX source values")
        self.assertEqual(js_eval(names, "feeUnitLabelFor(['nse', 'bse'])"), "at today's rates")
