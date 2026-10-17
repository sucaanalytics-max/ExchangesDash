"""
Effective-dated expiry calendar for NSE and BSE index options — the single
source of truth for which weekday is the weekly expiry (and whose last
occurrence in a calendar month is the monthly expiry) on any given date.

dashboard/app.js keeps a JS copy (const EXPIRY_RULES) for the Revenue Summary
expiry tables; scripts/check_expiry_calendar.py fails CI if the two drift.

Each rule: exchange, effective_from / effective_to (inclusive 'YYYY-MM-DD',
None = open-ended), weekday (English name), source. NSE is the Nifty weekly;
BSE is the Sensex weekly. Boundaries sit on week edges (from = Monday,
to = Sunday) so every Mon–Sun week has exactly one scheduled expiry day;
the check script enforces that, and contiguity, per exchange.

Holidays are not modelled here: when a scheduled day is not a trading day,
expiry moves to the previous trading day. That shift needs the list of
sessions that actually happened, so it stays with the callers
(live_common.classify_day, computeMonthExpiryDates/computeWeekExpiryDates).
"""

from datetime import date, timedelta

WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

EXPIRY_RULES = [
    {"exchange": "nse", "effective_from": None, "effective_to": "2025-08-31", "weekday": "Thursday",
     "source": "Nifty weekly on Thursday, monthly on the month's last Thursday. Last Thursday "
               "expiry 2025-08-28 (weekly options-revenue peaks fall on Thursday through it)."},
    {"exchange": "nse", "effective_from": "2025-09-01", "effective_to": None, "weekday": "Tuesday",
     "source": "NSE circular FAOP68589: index derivatives expiry Thursday -> Tuesday from "
               "2025-09-01. First Tuesday expiry 2025-09-02."},
    {"exchange": "bse", "effective_from": None, "effective_to": "2025-01-05", "weekday": "Friday",
     "source": "Sensex weekly on Friday, monthly on the month's last Friday (Sensex options "
               "relaunched May 2023; turnover ~0 before). Last Friday expiry 2025-01-03."},
    {"exchange": "bse", "effective_from": "2025-01-06", "effective_to": "2025-08-31", "weekday": "Tuesday",
     "source": "BSE circular: Sensex expiry Friday -> Tuesday from January 2025. First Tuesday "
               "expiry 2025-01-07, last 2025-08-26 (weekly options-revenue peaks)."},
    {"exchange": "bse", "effective_from": "2025-09-01", "effective_to": None, "weekday": "Thursday",
     "source": "BSE circular: Sensex expiry Tuesday -> Thursday from 2025-09-01, alongside "
               "NSE's move to Tuesday. First Thursday expiry 2025-09-04."},
]


def _iso(d) -> str:
    return d if isinstance(d, str) else d.strftime("%Y-%m-%d")


def expiry_rule(exchange: str, d):
    """The rule in force for `exchange` on date `d` (date or 'YYYY-MM-DD'), or None."""
    s = _iso(d)
    for r in EXPIRY_RULES:
        if (r["exchange"] == exchange
                and (r["effective_from"] is None or s >= r["effective_from"])
                and (r["effective_to"] is None or s <= r["effective_to"])):
            return r
    return None


def expiry_weekday(exchange: str, d):
    """Expiry weekday in force on `d` as date.weekday() (0=Mon … 6=Sun), or None
    if no rule covers the exchange (e.g. 'mcx')."""
    r = expiry_rule(exchange, d)
    return WEEKDAY_NAMES.index(r["weekday"]) if r else None


def is_scheduled_expiry(exchange: str, d: date) -> bool:
    """True when `d` falls on the expiry weekday in force on `d` itself
    (before any holiday shift)."""
    return d.weekday() == expiry_weekday(exchange, d)


def next_scheduled_expiry(exchange: str, d: date):
    """First scheduled expiry on or after `d`, or None. A rule change is
    handled by asking each candidate day which rule is in force on that day."""
    for k in range(14):
        c = d + timedelta(days=k)
        if is_scheduled_expiry(exchange, c):
            return c
    return None
