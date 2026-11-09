"""
Special trading sessions: short sessions that are not normal trading days.

Diwali Muhurat trading (about an hour, roughly ₹7 Cr of NSE revenue against
₹45–60 Cr on a normal day) and DR-site test sessions are kept out of every
average, day count and weekday statistic, and shown separately. Their revenue
is real, so the pipelines keep the rows in `special_sessions` (and in
Supabase) rather than dropping them; `split_special` is the one place the
rule is applied.

Full sessions held on a weekend (Budget day 2025-02-01 and 2026-02-01, the
2024-01-20 live session with a mid-day switch to the DR site) are normal
trading days and stay in.

When an exchange announces a new Muhurat or DR session, add it here.
"""

import json

SPECIAL_SESSIONS = [
    {"date": "2023-11-12", "type": "muhurat", "exchanges": ("nse", "bse", "mcx"),
     "note": "Diwali Muhurat trading (Samvat 2080)"},
    {"date": "2024-03-02", "type": "dr_test", "exchanges": ("nse", "bse"),
     "note": "Special live session from the DR site"},
    {"date": "2024-05-18", "type": "dr_test", "exchanges": ("nse", "bse"),
     "note": "Special live session from the DR site"},
    {"date": "2024-11-01", "type": "muhurat", "exchanges": ("nse", "bse", "mcx"),
     "note": "Diwali Muhurat trading (Samvat 2081)"},
    {"date": "2025-10-21", "type": "muhurat", "exchanges": ("nse", "bse", "mcx"),
     "note": "Diwali Muhurat trading (Samvat 2082)"},
    {"date": "2026-11-08", "type": "muhurat", "exchanges": ("nse", "bse", "mcx"),
     "note": "Diwali Muhurat trading (Samvat 2083); NSE circular FAOP71777"},
]

SESSION_LABELS = {"muhurat": "Muhurat trading", "dr_test": "DR test session"}

# Equity trading days before the NSE / BSE revenue history (which starts 2023-04-03),
# for the MTF backfill only (scripts/mtf_pipeline.py goes back to 1 Apr 2021): the
# weekdays from PRE_FY24_FIRST to PRE_FY24_LAST less these NSE / BSE equity holidays,
# plus the Diwali Muhurat sessions in that span (the exchanges publish an MTF file for
# a Muhurat day, as for 2023-11-12 and later). Checked against NSE's MTF reporting
# dates in codex_nse_mtf_daily (23 Nov 2021 – 31 Mar 2023): all 324 are trading days here.
PRE_FY24_FIRST, PRE_FY24_LAST = "2021-04-01", "2023-04-02"
PRE_FY24_HOLIDAYS = (
    "2021-04-02", "2021-04-14", "2021-04-21", "2021-05-13", "2021-07-21", "2021-08-19", "2021-09-10",
    "2021-10-15", "2021-11-04", "2021-11-05", "2021-11-19",
    "2022-01-26", "2022-03-01", "2022-03-18", "2022-04-14", "2022-04-15", "2022-05-03", "2022-08-09",
    "2022-08-15", "2022-08-31", "2022-10-05", "2022-10-24", "2022-10-26", "2022-11-08",
    "2023-01-26", "2023-03-07", "2023-03-30",
)
PRE_FY24_MUHURAT = ("2021-11-04", "2022-10-24")    # Samvat 2078, 2079 (held on a holiday)


def equity_days_pre_fy24():
    """ISO dates of the equity trading days from 1 Apr 2021 to 2 Apr 2023, oldest first."""
    from datetime import date, timedelta
    day, last = date.fromisoformat(PRE_FY24_FIRST), date.fromisoformat(PRE_FY24_LAST)
    holidays, extra = set(PRE_FY24_HOLIDAYS), set(PRE_FY24_MUHURAT)
    out = []
    while day <= last:
        iso = day.isoformat()
        if (day.weekday() < 5 and iso not in holidays) or iso in extra:
            out.append(iso)
        day += timedelta(days=1)
    return out


def special_session(exchange, date_str):
    """The SPECIAL_SESSIONS entry for `exchange` on `date_str`, or None."""
    ex = exchange.lower()
    for s in SPECIAL_SESSIONS:
        if s["date"] == date_str and ex in s["exchanges"]:
            return s
    return None


def split_special(daily, exchange):
    """(regular rows, special rows). Special rows are copies carrying
    `session` (type) and `session_note`; the input is not modified."""
    regular, special = [], []
    for row in daily:
        s = special_session(exchange, row.get("date", ""))
        if s:
            special.append(dict(row, session=s["type"], session_note=s["note"]))
        else:
            regular.append(row)
    return regular, special


def merge_special(daily, special):
    """Inverse of split_special for a pipeline that rebuilds from its own
    previous output: the special rows go back into the full daily series."""
    seen = {r["date"] for r in daily}
    back = [{k: v for k, v in r.items() if k not in ("session", "session_note")}
            for r in special or [] if r.get("date") not in seen]
    return sorted(list(daily) + back, key=lambda r: r["date"])


def changed_days(before, after):
    """Sorted dates whose published row (in `daily_all` or `special_sessions`)
    was added, changed or removed between two dashboard documents: the last
    committed one and the one a run is about to write. The NSE, BSE and MCX
    pipelines report this as their run's count of new days, which decides
    whether the share analyses and the Excel sync run (and, for MCX, whether
    the run commits). Rows are compared as JSON, exactly as they are written."""
    def rows(doc):
        doc = doc or {}
        listed = list(doc.get("daily_all") or []) + list(doc.get("special_sessions") or [])
        return {r["date"]: r for r in json.loads(json.dumps(listed))}
    old, new = rows(before), rows(after)
    return sorted(d for d in old.keys() | new.keys() if old.get(d) != new.get(d))
