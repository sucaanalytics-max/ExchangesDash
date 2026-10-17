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
