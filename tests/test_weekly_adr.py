"""Weekly ADR maths (dashboard/js/22-weekly-adr.js), run in Node.

Monday-keyed weeks (cpWeekStart) of an exchange's daily_all: sessions, total and
average revenue, whether the week is complete or a holiday week (complete with
fewer than 5 sessions) and which weekdays it missed, the expiry pair (the week's
expiry day from computeWeekExpiryDates plus the session before it in the same
week), and the normalised 5-day week for NSE and BSE: pair revenue plus the
non-pair average for each other day. Then a cross-exchange row (NSE, BSE, MCX and
Total) under Actual or Normalised, and the week dropdown's options."""

import datetime as dt
import unittest

from helpers import NODE, js_eval

ADR_JS = ["MONTHS_SHORT", "cpWeekStart", "EXPIRY_RULES", "EXPIRY_DOW_NAMES", "expiryRuleFor", "isScheduledExpiry", "EQUITY_HOLIDAYS", "isExchangeHoliday", "expiryCanTrade",
          "computeWeekExpiryDates", "EXPIRY_DATES_CACHE", "expiryDateSet", "PRE_EXPIRY_DATES_CACHE", "preExpiryDateSet",
          "WEEKLY_ADR_EXCHANGES", "WEEKLY_NORMALISED", "weeklyAdrWeeks",
          "weeklyAdrCell", "weeklyAdrRow", "weeklyAdrOptions", "fmtTradeDate", "weeklyAdrHolidayText",
          "weeklyAdrTable", "weeklyAdrDefaultWeeks", "weeklyAdrContext"]


def rows(spec):
    """{date: revenue} -> daily_all-like rows (any order is fine)."""
    return [{"date": d, "total_rev": v} for d, v in spec.items()]


def full_week(monday, revs=(10, 10, 10, 10, 10)):
    d = dt.date.fromisoformat(monday)
    return {(d + dt.timedelta(days=i)).isoformat(): r for i, r in enumerate(revs)}


def weeks(data, exchange):
    return js_eval(ADR_JS, "weeklyAdrWeeks(DATA.rows, DATA.ex)", {"rows": data, "ex": exchange})


def week_of(data, exchange, monday):
    return next(w for w in weeks(data, exchange) if w["week"] == monday)


def weeks_ctx(data, exchange, ref_rows, now):
    """weeklyAdrWeeks with the panel's context: today's IST date at `now` and ref_rows' (NSE's) dates."""
    return js_eval(ADR_JS, "weeklyAdrWeeks(DATA.rows, DATA.ex, weeklyAdrContext(DATA.ref, Date.parse(DATA.now)))",
                   {"rows": data, "ex": exchange, "ref": ref_rows, "now": now})


# NSE week of 28 Sep 2026 with Friday 2 Oct a holiday; the data runs on into the next week.
FRI_HOLIDAY = {"2026-09-28": 50, "2026-09-29": 70, "2026-09-30": 40, "2026-10-01": 42,
               **full_week("2026-10-05", (60, 80, 40, 50, 30))}


@unittest.skipUnless(NODE, "node not installed")
class WeeklyAdrWeeksTest(unittest.TestCase):
    def test_newest_first_with_totals(self):
        ws = weeks(rows(FRI_HOLIDAY), "nse")
        self.assertEqual([w["week"] for w in ws], ["2026-10-05", "2026-09-28"])
        self.assertEqual(ws[0]["sessions"], 5)
        self.assertAlmostEqual(ws[0]["total"], 260)
        self.assertAlmostEqual(ws[0]["avg"], 52)
        self.assertTrue(ws[0]["complete"])
        self.assertFalse(ws[0]["holiday"])
        self.assertEqual(ws[0]["missing"], [])
        self.assertIsNone(ws[0]["norm"])  # a 5-session week is never normalised

    def test_normalise_friday_holiday(self):
        w = week_of(rows(FRI_HOLIDAY), "nse", "2026-09-28")
        self.assertTrue(w["complete"])
        self.assertTrue(w["holiday"])
        self.assertEqual(w["missing"], ["2026-10-02"])
        self.assertEqual(w["sessions"], 4)
        self.assertEqual(w["pair"], ["2026-09-28", "2026-09-29"])  # NSE Tuesday expiry + Monday
        self.assertAlmostEqual(w["avg"], 50.5)
        self.assertAlmostEqual(w["norm"]["total"], 120 + 41 * 3)
        self.assertAlmostEqual(w["norm"]["avg"], 48.6)

    def test_pair_follows_old_rule(self):
        # Thursday expiry until 2025-08-31: the pair is Wed 11 + Thu 12 Jun 2025.
        data = {"2025-06-09": 30, "2025-06-10": 30, "2025-06-11": 40, "2025-06-12": 90,
                **full_week("2025-06-16")}
        w = week_of(rows(data), "nse", "2025-06-09")
        self.assertTrue(w["holiday"])
        self.assertEqual(w["missing"], ["2025-06-13"])
        self.assertEqual(w["pair"], ["2025-06-11", "2025-06-12"])
        self.assertAlmostEqual(w["norm"]["total"], 130 + 30 * 3)

    def test_bse_pair_wed_thu(self):
        data = {"2026-11-09": 8, "2026-11-11": 30, "2026-11-12": 45, "2026-11-13": 7,
                **full_week("2026-11-16")}
        w = week_of(rows(data), "bse", "2026-11-09")
        self.assertEqual(w["pair"], ["2026-11-11", "2026-11-12"])
        self.assertEqual(w["missing"], ["2026-11-10"])
        self.assertAlmostEqual(w["norm"]["total"], 75 + 7.5 * 3)
        self.assertAlmostEqual(w["norm"]["avg"], 19.5)

    def test_missing_pre_expiry_day(self):
        # Monday missing: the pair is Tuesday alone, and the other four days are filled at the non-pair average.
        data = {"2026-11-10": 80, "2026-11-11": 50, "2026-11-12": 40, "2026-11-13": 60,
                **full_week("2026-11-16")}
        w = week_of(rows(data), "nse", "2026-11-09")
        self.assertEqual(w["pair"], ["2026-11-10"])
        self.assertEqual(w["missing"], ["2026-11-09"])
        self.assertAlmostEqual(w["norm"]["total"], 80 + 50 * 4)
        self.assertAlmostEqual(w["norm"]["avg"], 56)

    def test_holiday_on_expiry_shifts_pair(self):
        # Tuesday 10 Nov a holiday: expiry moves to Monday, which has no earlier session that week.
        data = {"2026-11-09": 98, "2026-11-11": 70, "2026-11-12": 47, "2026-11-13": 64,
                **full_week("2026-11-16")}
        w = week_of(rows(data), "nse", "2026-11-09")
        self.assertEqual(w["pair"], ["2026-11-09"])
        self.assertAlmostEqual(w["norm"]["total"], 98 + (70 + 47 + 64) / 3 * 4)

    def test_no_non_pair_session_norm_null(self):
        data = {"2026-11-09": 60, "2026-11-10": 80, **full_week("2026-11-16")}
        w = week_of(rows(data), "nse", "2026-11-09")
        self.assertTrue(w["holiday"])
        self.assertEqual(w["pair"], ["2026-11-09", "2026-11-10"])
        self.assertEqual(w["missing"], ["2026-11-11", "2026-11-12", "2026-11-13"])
        self.assertIsNone(w["norm"])

    def test_in_progress_week(self):
        data = {**full_week("2026-11-09"), "2026-11-16": 60, "2026-11-17": 80}
        ws = weeks(rows(data), "nse")
        cur = ws[0]
        self.assertEqual(cur["week"], "2026-11-16")
        self.assertEqual(cur["sessions"], 2)
        self.assertFalse(cur["complete"])
        self.assertFalse(cur["holiday"])
        self.assertEqual(cur["missing"], [])
        self.assertIsNone(cur["norm"])
        self.assertEqual(cur["pair"], ["2026-11-16", "2026-11-17"])
        self.assertTrue(ws[1]["complete"])

    def test_six_session_week_normalised(self):
        # A full weekend session (Budget-day style) is a normal day: 6 sessions, not a holiday, normalised to 5.
        data = {**full_week("2026-11-02", (60, 80, 40, 50, 30)), "2026-11-07": 20, **full_week("2026-11-09")}
        w = week_of(rows(data), "nse", "2026-11-02")
        self.assertEqual(w["sessions"], 6)
        self.assertFalse(w["holiday"])
        self.assertEqual(w["missing"], [])
        self.assertEqual(w["pair"], ["2026-11-02", "2026-11-03"])
        self.assertAlmostEqual(w["norm"]["total"], 140 + (40 + 50 + 30 + 20) / 4 * 3)
        self.assertAlmostEqual(w["norm"]["avg"], 49)

    def test_mcx_never_normalised(self):
        data = {"2026-09-28": 14, "2026-09-29": 10, "2026-09-30": 10, "2026-10-01": 11,
                **full_week("2026-10-05")}
        w = week_of(rows(data), "mcx", "2026-09-28")
        self.assertTrue(w["holiday"])
        self.assertEqual(w["missing"], ["2026-10-02"])
        self.assertEqual(w["pair"], [])
        self.assertIsNone(w["norm"])

    def test_modelled_rows_dropped(self):
        data = rows(full_week("2024-08-26")) + rows(full_week("2026-10-05"))
        for r in data[:5]:
            r["modelled"] = True
        self.assertEqual([w["week"] for w in weeks(data, "mcx")], ["2026-10-05"])

    def test_pre_expiry_holiday_leaves_expiry_alone(self):
        # BSE Thursday rule, Wednesday 18 Nov a holiday: the pair is Thursday only; Tuesday is ordinary
        data = {"2026-11-16": 8, "2026-11-17": 9, "2026-11-19": 45, "2026-11-20": 7, **full_week("2026-11-23")}
        w = week_of(rows(data), "bse", "2026-11-16")
        self.assertEqual(w["pair"], ["2026-11-19"])
        self.assertEqual(w["missing"], ["2026-11-18"])
        self.assertAlmostEqual(w["norm"]["total"], 45 + (8 + 9 + 7) / 3 * 4)
        # the old rule's "latest session before expiry" would have paired Tuesday; under the
        # Thursday rule with Thursday a holiday the expiry moves onto Wednesday: pair = Wed alone
        data = {"2026-11-16": 8, "2026-11-17": 9, "2026-11-18": 30, "2026-11-20": 7, **full_week("2026-11-23")}
        self.assertEqual(week_of(rows(data), "bse", "2026-11-16")["pair"], ["2026-11-18"])

    def test_holiday_friday_week_complete_on_saturday(self):
        # NSE week of 30 Mar 2026 with Good-Friday-style 3 Apr holiday, seen on Saturday 4 Apr (IST)
        data = rows({**full_week("2026-03-23"), "2026-03-30": 60, "2026-03-31": 80, "2026-04-01": 40, "2026-04-02": 50})
        sat = "2026-04-04T04:00:00Z"
        w = weeks_ctx(data, "nse", data, sat)[0]
        self.assertEqual(w["week"], "2026-03-30")
        self.assertTrue(w["complete"])
        self.assertTrue(w["holiday"])
        self.assertEqual(w["missing"], ["2026-04-03"])
        self.assertEqual(w["pair"], ["2026-03-30", "2026-03-31"])
        self.assertAlmostEqual(w["norm"]["total"], 140 + 45 * 3)
        # on the Friday itself (IST) it is still in progress; without ctx, as before, until Monday's data
        self.assertFalse(weeks_ctx(data, "nse", data, "2026-04-03T10:00:00Z")[0]["complete"])
        self.assertFalse(weeks(data, "nse")[0]["complete"])

    def test_bse_lagging_friday_stays_in_progress(self):
        # NSE has Friday 20 Nov; BSE's file stops at Thursday: on Saturday BSE's week is still in progress
        nse = rows({**full_week("2026-11-09"), **full_week("2026-11-16")})
        bse = rows({**full_week("2026-11-09"), "2026-11-16": 8, "2026-11-17": 9, "2026-11-18": 30, "2026-11-19": 45})
        w = weeks_ctx(bse, "bse", nse, "2026-11-21T06:00:00Z")[0]
        self.assertFalse(w["complete"])
        self.assertFalse(w["holiday"])
        self.assertIsNone(w["norm"])

    def test_holiday_on_expiry_in_latest_week(self):
        # BSE Thursday rule, Thursday 19 and Friday 20 Nov holidays, data to Wednesday, seen on Saturday:
        # complete, and the expiry is moved onto Wednesday (the pair is Wednesday alone)
        data = rows({**full_week("2026-11-09"), "2026-11-16": 8, "2026-11-17": 9, "2026-11-18": 30})
        w = weeks_ctx(data, "bse", data, "2026-11-21T06:00:00Z")[0]
        self.assertTrue(w["complete"])
        self.assertEqual(w["pair"], ["2026-11-18"])
        self.assertAlmostEqual(w["norm"]["total"], 30 + 8.5 * 4)

    def test_complete_uses_own_last_date(self):
        # BSE a day behind: its week is still in progress on Thursday.
        data = {**full_week("2026-11-09"), "2026-11-16": 8, "2026-11-17": 9, "2026-11-18": 30, "2026-11-19": 45}
        cur = weeks(rows(data), "bse")[0]
        self.assertFalse(cur["complete"])
        self.assertIsNone(cur["norm"])


def by_ex(nse, bse, mcx):
    return js_eval(ADR_JS, "({nse: weeklyAdrWeeks(DATA.n, 'nse'), bse: weeklyAdrWeeks(DATA.b, 'bse'),"
                           " mcx: weeklyAdrWeeks(DATA.m, 'mcx')})", {"n": nse, "b": bse, "m": mcx})


NSE = rows(FRI_HOLIDAY)
BSE = rows(full_week("2026-09-28", (6, 8, 30, 52, 4)))  # no week of 5 Oct: BSE is absent there
MCX = rows({**full_week("2026-09-28", (5, 5, 5, 5, 5)), **full_week("2026-10-05", (6, 6, 6, 6, 6))})


@unittest.skipUnless(NODE, "node not installed")
class WeeklyAdrRowTest(unittest.TestCase):
    def row(self, week, mode):
        return js_eval(ADR_JS, "weeklyAdrRow({nse: weeklyAdrWeeks(DATA.n, 'nse'), bse: weeklyAdrWeeks(DATA.b, 'bse'),"
                               " mcx: weeklyAdrWeeks(DATA.m, 'mcx')}, DATA.w, DATA.mode)",
                       {"n": NSE, "b": BSE, "m": MCX, "w": week, "mode": mode})

    def test_cell_modes(self):
        w = week_of(NSE, "nse", "2026-09-28")
        actual = js_eval(ADR_JS, "weeklyAdrCell(DATA.w, 'actual')", {"w": w})
        norm = js_eval(ADR_JS, "weeklyAdrCell(DATA.w, 'normalised')", {"w": w})
        self.assertEqual(actual, {"avg": 50.5, "total": 202, "sessions": 4, "normalised": False})
        self.assertAlmostEqual(norm["avg"], 48.6)
        self.assertAlmostEqual(norm["total"], 243)
        self.assertEqual(norm["sessions"], 4)
        self.assertTrue(norm["normalised"])
        full = week_of(NSE, "nse", "2026-10-05")
        self.assertFalse(js_eval(ADR_JS, "weeklyAdrCell(DATA.w, 'normalised')", {"w": full})["normalised"])
        self.assertIsNone(js_eval(ADR_JS, "weeklyAdrCell(null, 'actual')"))

    def test_row_total_and_mode(self):
        norm = self.row("2026-09-28", "normalised")
        self.assertAlmostEqual(norm["cells"]["nse"]["avg"], 48.6)
        self.assertTrue(norm["cells"]["nse"]["normalised"])
        self.assertAlmostEqual(norm["cells"]["bse"]["avg"], 20)
        self.assertAlmostEqual(norm["cells"]["mcx"]["avg"], 5)
        self.assertAlmostEqual(norm["total"]["avg"], 48.6 + 20 + 5)
        self.assertAlmostEqual(norm["total"]["total"], 243 + 100 + 25)
        self.assertEqual(norm["holiday"], {"nse": True, "bse": False, "mcx": False})
        self.assertEqual(norm["inProgress"], {"nse": False, "bse": False, "mcx": False})

        actual = self.row("2026-09-28", "actual")
        self.assertAlmostEqual(actual["cells"]["nse"]["avg"], 50.5)
        self.assertFalse(actual["cells"]["nse"]["normalised"])
        self.assertAlmostEqual(actual["total"]["avg"], 50.5 + 20 + 5)

        gap = self.row("2026-10-05", "actual")  # BSE has no such week: absent, not 0
        self.assertIsNone(gap["cells"]["bse"])
        self.assertAlmostEqual(gap["total"]["avg"], 52 + 6)
        self.assertEqual(gap["holiday"]["bse"], False)

    def test_row_with_no_data(self):
        empty = self.row("2020-01-06", "actual")
        self.assertEqual(empty["cells"], {"nse": None, "bse": None, "mcx": None})
        self.assertIsNone(empty["total"]["avg"])


@unittest.skipUnless(NODE, "node not installed")
class WeeklyAdrOptionsTest(unittest.TestCase):
    def options(self, nse, bse, mcx):
        return js_eval(ADR_JS, "weeklyAdrOptions({nse: weeklyAdrWeeks(DATA.n, 'nse'), bse: weeklyAdrWeeks(DATA.b, 'bse'),"
                               " mcx: weeklyAdrWeeks(DATA.m, 'mcx')})", {"n": nse, "b": bse, "m": mcx})

    def test_options_labels(self):
        opts = self.options(NSE, BSE, MCX)
        self.assertEqual(opts, [
            {"week": "2026-10-05", "label": "5–9 Oct 2026 · 5 sessions", "flag": None},
            {"week": "2026-09-28", "label": "28 Sep – 2 Oct 2026 · 4 sessions", "flag": "holiday"},
        ])

    def test_options_union_and_fallback_sessions(self):
        # A week only MCX traded (NSE and BSE closed) takes MCX's count; the year-crossing label names both years.
        mcx = rows({**full_week("2026-12-28", (5, 5, 5, 5)), **full_week("2027-01-04")})
        nse = rows(full_week("2027-01-04"))
        opts = self.options(nse, [], mcx)
        self.assertEqual([o["week"] for o in opts], ["2027-01-04", "2026-12-28"])
        self.assertEqual(opts[1]["label"], "28 Dec 2026 – 1 Jan 2027 · 4 sessions")
        self.assertEqual(opts[1]["flag"], "holiday")
        self.assertEqual(opts[0]["flag"], None)

    def test_single_session_label(self):
        opts = self.options(rows({**full_week("2026-11-09"), "2026-11-16": 60}), [], [])
        self.assertEqual(opts[0]["label"], "16–20 Nov 2026 · 1 session")


@unittest.skipUnless(NODE, "node not installed")
class WeeklyAdrTableTest(unittest.TestCase):
    """The panel's rows: the other mode's figure as a secondary line, holiday days, % vs row 1."""

    def table(self, weeks_, mode):
        return js_eval(ADR_JS, "weeklyAdrTable({nse: weeklyAdrWeeks(DATA.n, 'nse'), bse: weeklyAdrWeeks(DATA.b, 'bse'),"
                               " mcx: weeklyAdrWeeks(DATA.m, 'mcx')}, DATA.w, DATA.mode)",
                       {"n": NSE, "b": BSE, "m": MCX, "w": weeks_, "mode": mode})

    def test_holiday_text(self):
        self.assertEqual(js_eval(ADR_JS, "weeklyAdrHolidayText(['2026-10-02'])"), "holiday: Fri 2 Oct")
        self.assertEqual(js_eval(ADR_JS, "weeklyAdrHolidayText(['2026-10-01', '2026-10-02'])"),
                         "holiday: Thu 1 Oct, Fri 2 Oct")
        self.assertEqual(js_eval(ADR_JS, "weeklyAdrHolidayText(['2026-11-10'])"), "holiday: Tue 10 Nov")

    def test_actual(self):
        ref, hol = self.table(["2026-10-05", "2026-09-28"], "actual")
        self.assertFalse(ref["holiday"])
        self.assertIsNone(ref["cells"]["bse"])
        self.assertIsNone(ref["cells"]["nse"]["alt"])
        self.assertIsNone(ref["cells"]["nse"]["pct"])  # row 1 has no change
        self.assertIsNone(ref["total"]["pct"])
        self.assertIsNone(ref["total"]["alt"])
        self.assertTrue(hol["holiday"])
        nse = hol["cells"]["nse"]
        self.assertAlmostEqual(nse["avg"], 50.5)
        self.assertAlmostEqual(nse["alt"], 48.6)  # the "normalised" line
        self.assertEqual(nse["missing"], ["2026-10-02"])
        self.assertFalse(nse["inProgress"])
        self.assertAlmostEqual(nse["pct"], (52 - 50.5) / 50.5)
        self.assertIsNone(hol["cells"]["bse"]["pct"])  # BSE has no week in row 1
        self.assertIsNone(hol["cells"]["mcx"]["alt"])  # MCX is never normalised
        self.assertAlmostEqual(hol["cells"]["mcx"]["pct"], 0.2)
        self.assertAlmostEqual(hol["total"]["avg"], 75.5)
        self.assertAlmostEqual(hol["total"]["alt"], 73.6)
        self.assertEqual(ref["total"]["excl"], ["bse"])  # row 1's Total is NSE + MCX only
        self.assertEqual(hol["total"]["excl"], [])
        self.assertIsNone(hol["total"]["pct"])  # different exchanges: no Total % change

    def test_total_pct_same_exchanges(self):
        bse = rows({**full_week("2026-09-28", (6, 8, 30, 52, 4)), **full_week("2026-10-05", (5, 5, 5, 5, 5))})
        for mode, nse_avg in (("actual", 50.5), ("normalised", 48.6)):
            ref, hol = js_eval(ADR_JS, "weeklyAdrTable({nse: weeklyAdrWeeks(DATA.n, 'nse'), bse: weeklyAdrWeeks(DATA.b, 'bse'),"
                                       " mcx: weeklyAdrWeeks(DATA.m, 'mcx')}, ['2026-10-05', '2026-09-28'], DATA.mode)",
                               {"n": NSE, "b": bse, "m": MCX, "mode": mode})
            self.assertEqual(ref["total"]["excl"], [])
            self.assertAlmostEqual(ref["total"]["avg"], 52 + 5 + 6)
            self.assertAlmostEqual(hol["total"]["pct"], (63 - (nse_avg + 25)) / (nse_avg + 25))

    def test_total_pct_both_missing_same_exchange(self):
        ref, other = self.table(["2026-10-05", "2026-10-05"], "actual")
        self.assertEqual(other["total"]["excl"], ["bse"])
        self.assertAlmostEqual(other["total"]["pct"], 0)

    def test_normalised(self):
        _, hol = self.table(["2026-10-05", "2026-09-28"], "normalised")
        nse = hol["cells"]["nse"]
        self.assertTrue(nse["normalised"])
        self.assertAlmostEqual(nse["avg"], 48.6)
        self.assertAlmostEqual(nse["alt"], 50.5)  # the "actual" line
        self.assertAlmostEqual(nse["pct"], (52 - 48.6) / 48.6)
        self.assertAlmostEqual(hol["total"]["avg"], 73.6)
        self.assertAlmostEqual(hol["total"]["alt"], 75.5)
        self.assertIsNone(hol["total"]["pct"])  # row 1 has no BSE

    def test_holiday_in_row_one(self):
        ref, other = self.table(["2026-09-28", "2026-10-05"], "normalised")
        self.assertAlmostEqual(other["cells"]["nse"]["pct"], (48.6 - 52) / 52)
        self.assertIsNone(ref["cells"]["nse"]["pct"])

    def test_in_progress_pct_blank(self):
        # row 1 in progress: rows 2-3 show no % (cells or Total); a row in progress: its % is blank too
        nse = rows({**full_week("2026-11-02"), **full_week("2026-11-09"), "2026-11-16": 60, "2026-11-17": 80})
        mcx = rows({**full_week("2026-11-02"), **full_week("2026-11-09"), **full_week("2026-11-16")})
        expr = ("weeklyAdrTable({nse: weeklyAdrWeeks(DATA.n, 'nse'), bse: [], mcx: weeklyAdrWeeks(DATA.m, 'mcx')},"
                " DATA.w, 'actual')")
        cur, prev = js_eval(ADR_JS, expr, {"n": nse, "m": mcx, "w": ["2026-11-16", "2026-11-09"]})
        self.assertIsNone(prev["cells"]["nse"]["pct"])
        self.assertIsNotNone(prev["cells"]["mcx"]["pct"])   # MCX's week of 16 Nov is complete
        self.assertIsNone(prev["total"]["pct"])
        ref, wip = js_eval(ADR_JS, expr, {"n": nse, "m": mcx, "w": ["2026-11-09", "2026-11-16"]})
        self.assertIsNone(wip["cells"]["nse"]["pct"])
        self.assertIsNone(wip["total"]["pct"])
        ref, old = js_eval(ADR_JS, expr, {"n": nse, "m": mcx, "w": ["2026-11-09", "2026-11-02"]})
        self.assertAlmostEqual(old["cells"]["nse"]["pct"], 0)
        self.assertAlmostEqual(old["total"]["pct"], 0)

    def test_default_weeks_latest_complete(self):
        nse = rows({**full_week("2026-10-26"), **full_week("2026-11-02"), **full_week("2026-11-09"),
                    "2026-11-16": 60, "2026-11-17": 80})
        mcx = rows({**full_week("2026-11-09"), **full_week("2026-11-16")})
        expr = ("(b => weeklyAdrDefaultWeeks(b, weeklyAdrOptions(b)))({nse: weeklyAdrWeeks(DATA.n, 'nse'), bse: [],"
                " mcx: weeklyAdrWeeks(DATA.m, 'mcx')})")
        self.assertEqual(js_eval(ADR_JS, expr, {"n": nse, "m": mcx}), ["2026-11-09", "2026-11-02", "2026-10-26"])
        # keyed on NSE's weeks: a newer week only MCX has (NSE's file not in yet) is not row 1
        nse2 = rows({**full_week("2026-11-02"), **full_week("2026-11-09")})
        self.assertEqual(js_eval(ADR_JS, expr, {"n": nse2, "m": mcx}), ["2026-11-09", "2026-11-02", "2026-11-02"])
        # too few weeks: the oldest repeats
        self.assertEqual(js_eval(ADR_JS, expr, {"n": rows(full_week("2026-11-09")), "m": []}),
                         ["2026-11-09", "2026-11-09", "2026-11-09"])

    def test_in_progress_cell(self):
        nse = rows({**full_week("2026-11-09"), "2026-11-16": 60, "2026-11-17": 80})
        cur, prev = js_eval(ADR_JS, "weeklyAdrTable({nse: weeklyAdrWeeks(DATA.n, 'nse'), bse: [], mcx: []},"
                                    " ['2026-11-16', '2026-11-09'], 'actual')", {"n": nse})
        self.assertTrue(cur["cells"]["nse"]["inProgress"])
        self.assertEqual(cur["cells"]["nse"]["sessions"], 2)
        self.assertEqual(cur["cells"]["nse"]["missing"], [])
        self.assertFalse(cur["holiday"])
        self.assertIsNone(prev["cells"]["nse"]["pct"])   # against an in-progress row 1: blank



@unittest.skipUnless(NODE, "node not installed")
class WeeklyAdrLoader(unittest.TestCase):
    def test_uses_shared_loader_not_view_built_from(self):
        src = js_eval(["buildWeeklyAdrPanel"], "buildWeeklyAdrPanel.toString()")
        self.assertIn("loadCrossExchangeRows", src)
        self.assertIn("registerCrossPanel", src)
        self.assertNotIn("VIEW_BUILT_FROM", src)
        self.assertNotIn("ensureFreshMarketData", src)


if __name__ == "__main__":
    unittest.main()
