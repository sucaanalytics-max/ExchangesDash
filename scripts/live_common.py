"""
Shared intraday-revenue snapshot + EOD-prediction logic for NSE and BSE live pollers.

GitHub Actions' cron scheduler is documented as best-effort and, under load,
fires this repo's every-5-minute live pollers only a handful of times across
a trading day rather than every 5 minutes as scheduled — a platform
limitation, not a bug in the poller. The old design required a poll to land
in a narrow window around each hour mark (e.g. "within the first 5 minutes
of the hour") to count as that hour's checkpoint, which meant the archive
silently starved once runs stopped landing precisely on time.

This version records every successful poll's (elapsed_minutes, revenue)
point unconditionally, however sparse or irregularly-timed. The fixed
hour-mark checkpoints used for the historical "% of EOD revenue by hour N"
model are derived after the fact by linearly interpolating between whichever
two actual samples happen to bracket that checkpoint each day (with a
synthetic (0 min, ₹0) anchor at market open, since revenue is definitionally
zero then). A day is archived — and its checkpoints computed — the next time
a new day's first sample arrives, using whatever samples were collected as
long as the last one is late enough in the session to trust as an EOD proxy.

Weekday classification per exchange:
  NSE: Tuesday = expiry day. If Tuesday is a holiday, Monday becomes expiry.
       Monday (before a Tuesday expiry) = pre-expiry.
  BSE: Thursday = expiry day. If Thursday is a holiday, Wednesday becomes expiry.
       Wednesday (before a Thursday expiry) = pre-expiry.

Historical file: dashboard/data/{exchange}_hourly_history.json
  {
    "days": [
      {
        "date":        "2026-04-15",
        "weekday":     1,          // 0=Mon … 4=Fri
        "weekday_name":"Tuesday",
        "day_type":    "expiry",   // "expiry"|"pre_expiry"|"normal"
        "eod_revenue": 92.3,
        "n_samples":   4,          // how many raw polls actually landed that day
        "checkpoints": {
          "10:00": {"revenue": 28.1, "fraction": 0.305},
          ...
          "16:00": {"revenue": 92.3, "fraction": 1.0}
        }
      }
    ]
  }

Live file: dashboard/data/{exchange}_live_hourly.json
  {
    "date": "2026-08-24", "weekday": 0, "weekday_name": "Monday", "day_type": "normal",
    "samples": [
      {"captured_ist": "...", "elapsed_minutes": 225, "total_revenue": 3.67,
       "cash_revenue": 0.68, "options_revenue": 3.0, "futures_revenue": 0.0,
       "predicted_eod": 6.12, "pred_method": "historical/normal"},
      ...
    ]
  }
"""

import json
import re
from datetime import date, datetime, timedelta
from pathlib import Path

MARKET_OPEN_MIN  = 9 * 60 + 15   # 9:15 AM IST
# SEBI's Closing Auction Session (effective 2026-08-03) moved the cash segment's
# effective close from 3:30 PM to 4:00 PM: CAS runs 3:15-3:35pm, then a
# post-close session 3:50-4:00pm executes trades at the closing price
# (equity derivatives separately extended to 3:40pm). Treated as a single
# 4:00 PM EOD point here rather than modelling CAS/post-close as their own
# checkpoints.
MARKET_TOTAL_MIN = 405            # → 16:00
MIN_SAMPLES       = 3              # minimum archived days to trust historical fractions
EOD_MIN_ELAPSED   = 360            # a day's last sample must be at/after ~15:00 IST to trust as EOD

WEEKDAY_NAMES = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]

# Fixed reference checkpoints (label, minutes elapsed since market open) that
# the historical "% of EOD revenue by hour N" model is built on.
REFERENCE_CHECKPOINTS = [
    ("10:00", 45), ("11:00", 105), ("12:00", 165), ("13:00", 225),
    ("14:00", 285), ("15:00", 345), ("16:00", 405),
]

# Window in which a live poll is worth running at all (IST, Mon–Fri):
# 8:55 AM (pre-open) to 4:30 PM (after the 4:00 PM post-close session).
# The external cron that dispatches the pollers fires around the clock, so
# outside this window the pollers exit without writing anything — no commit,
# no deploy, and no weekend "day" archived into the EOD model.
SESSION_START_MIN = 8 * 60 + 55
SESSION_END_MIN   = 16 * 60 + 30

# NSE expiry = Tuesday (1); BSE expiry = Thursday (3)
EXPIRY_WEEKDAY = {"nse": 1, "bse": 3}
# Pre-expiry = day before expiry
PRE_EXPIRY_WEEKDAY = {"nse": 0, "bse": 2}


# ---------------------------------------------------------------------------
# Day-type classification
# ---------------------------------------------------------------------------

def classify_day(d: date, exchange: str, market_dates: set = None) -> str:
    """
    Returns 'expiry', 'pre_expiry', or 'normal'.

    market_dates: optional set of YYYY-MM-DD strings of known trading days.
    Used to detect holiday shifts (e.g. Tuesday holiday → Monday becomes expiry).
    When not provided, uses simple weekday rules.
    """
    wd = d.weekday()   # 0=Mon … 4=Fri
    exp_wd = EXPIRY_WEEKDAY.get(exchange, -1)
    pre_wd = PRE_EXPIRY_WEEKDAY.get(exchange, -1)

    if market_dates:
        # Find the canonical expiry day of the same week
        days_to_exp = (exp_wd - wd) % 7
        canonical_expiry = d + timedelta(days=days_to_exp)
        canonical_str = canonical_expiry.strftime("%Y-%m-%d")

        # Only apply holiday-shift logic if the canonical expiry is in the past
        # (i.e. we would already have it in market_dates if it were a trading day).
        # If it's today or in the future we can't know yet → use simple weekday rule.
        max_known = max(market_dates) if market_dates else ""
        expiry_is_holiday = (canonical_str <= max_known) and (canonical_str not in market_dates)

        if expiry_is_holiday:
            # Expiry shifts to the trading day just before canonical expiry
            # that day is the new expiry
            shifted = canonical_expiry - timedelta(days=1)
            while shifted.strftime("%Y-%m-%d") not in market_dates and shifted > d:
                shifted -= timedelta(days=1)
            if d == shifted:
                return "expiry"
            # Pre-expiry = day before shifted expiry
            pre_shifted = shifted - timedelta(days=1)
            while pre_shifted.strftime("%Y-%m-%d") not in market_dates and pre_shifted > d:
                pre_shifted -= timedelta(days=1)
            if d == pre_shifted:
                return "pre_expiry"
        else:
            if wd == exp_wd:
                return "expiry"
            # Pre-expiry = closest trading day before canonical expiry
            pre = canonical_expiry - timedelta(days=1)
            while pre.weekday() > 4:   # skip weekends
                pre -= timedelta(days=1)
            if d == pre:
                return "pre_expiry"
    else:
        # Simple weekday rule (no holiday awareness)
        if wd == exp_wd:
            return "expiry"
        if wd == pre_wd:
            return "pre_expiry"

    return "normal"


# ---------------------------------------------------------------------------
# Session guard + trade-date handling
# ---------------------------------------------------------------------------

def in_market_session(now_ist: datetime) -> bool:
    """True on a weekday between SESSION_START_MIN and SESSION_END_MIN IST.
    Exchange holidays are not known here; they are caught by the trade-date
    check in save_hourly_snapshot (the exchange keeps reporting the previous
    session's date on a closed day)."""
    if now_ist.weekday() > 4:
        return False
    mins = now_ist.hour * 60 + now_ist.minute
    return SESSION_START_MIN <= mins <= SESSION_END_MIN


def normalize_trade_date(raw):
    """Exchange trade date → 'YYYY-MM-DD', or None if unparseable.
    Handles NSE '2026-10-16…', BSE '16/10/26', and '16-Oct-2026' forms."""
    if not raw:
        return None
    s = str(raw).strip()
    if re.match(r"^\d{4}-\d{2}-\d{2}", s):
        return s[:10]
    token = s.split(" ")[0]
    for fmt in ("%d/%m/%y", "%d/%m/%Y", "%d-%b-%Y", "%d-%b-%y"):
        try:
            return datetime.strptime(token, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


# ---------------------------------------------------------------------------
# Core helpers
# ---------------------------------------------------------------------------

def _trading_dates_for(history_file: Path):
    """Dates present in the exchange's daily EOD data ({ex}_dashboard_data.json
    beside the history file), or None if unavailable. Used as the calendar of
    sessions that actually happened."""
    ex = history_file.name.split("_")[0]
    daily_file = history_file.parent / f"{ex}_dashboard_data.json"
    try:
        rows = json.loads(daily_file.read_text()).get("daily_all") or []
        return {r["date"] for r in rows if r.get("date")}
    except Exception:
        return None


def _clean_days(days: list, trading_dates: set = None) -> list:
    """Drop archived 'days' that were not real trading sessions.

    Before the session guard existed the pollers ran 24/7, so weekends and
    exchange holidays were archived as flat days that just repeat the
    previous session's closing revenue (fraction 1.0 at every checkpoint),
    dragging every historical curve up and the live EOD forecast down.
    Weekend dates and exact repeats of the previous kept day's EOD revenue
    are discarded. Weekend special sessions (Muhurat, Budget day) are dropped
    too — their intraday shape is not representative of a normal session.
    When the exchange's daily data is available, a day up to its latest date
    must also appear in it (catches holidays with a differing stale value)."""
    last_known = max(trading_dates) if trading_dates else ""
    kept = []
    for d in sorted(days, key=lambda x: x.get("date", "")):
        try:
            if date.fromisoformat(d["date"]).weekday() > 4:
                continue
        except (KeyError, ValueError, TypeError):
            continue
        if trading_dates and d["date"] <= last_known and d["date"] not in trading_dates:
            continue
        if kept and d.get("eod_revenue") == kept[-1].get("eod_revenue"):
            continue
        kept.append(d)
    return kept


def _load_history(history_file: Path):
    if not history_file.exists():
        return {"days": []}
    try:
        data = json.loads(history_file.read_text())
    except Exception:
        return {"days": []}
    try:
        data["days"] = _clean_days(data.get("days", []), _trading_dates_for(history_file))
    except Exception as e:
        # Never let a cleaning bug wipe the history: use it uncleaned.
        print(f"  History: cleaning failed ({e}) — using days as stored")
    return data


def _interp(points, target):
    """points: sorted [(x, y), ...] with no duplicate x. Linearly interpolates
    y at `target`. Returns None if target falls outside the observed range —
    callers that need a value regardless (live prediction) clamp explicitly."""
    if not points:
        return None
    if target < points[0][0] or target > points[-1][0]:
        return None
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        if x0 <= target <= x1:
            return y0 if x1 == x0 else y0 + (target - x0) / (x1 - x0) * (y1 - y0)
    return points[-1][1]


# ---------------------------------------------------------------------------
# Historical fraction model
# ---------------------------------------------------------------------------

def _avg_checkpoint_fractions(days: list) -> dict:
    """Average each checkpoint's fraction across days that have it."""
    from collections import defaultdict
    acc = defaultdict(list)
    for day in days:
        for label, cp in day.get("checkpoints", {}).items():
            frac = cp.get("fraction") if isinstance(cp, dict) else None
            if frac is not None:
                acc[label].append(frac)
    return {lbl: round(sum(v) / len(v), 4) for lbl, v in acc.items() if v}


def _best_fraction_curve(history_file: Path, today_day_type: str, today_weekday: int):
    """
    Returns (fractions_dict, method_label) using the best available sample set.

    Priority:
      1. Same day_type + same weekday (most specific)
      2. Same day_type (e.g. all expiry days regardless of weekday)
      3. All days overall
      4. (None, "none") → caller falls back to linear extrapolation
    """
    data = _load_history(history_file)
    intraday_labels = {lbl for lbl, mins in REFERENCE_CHECKPOINTS if mins != MARKET_TOTAL_MIN}
    # Only days with a measured intraday shape count towards MIN_SAMPLES — a
    # single-sample day contributes nothing but its EOD fraction of 1.0.
    all_days = [d for d in data.get("days", [])
                if d.get("eod_revenue", 0) > 0
                and any((d.get("checkpoints", {}).get(l) or {}).get("fraction") is not None
                        for l in intraday_labels)]

    def try_set(days, method):
        if len(days) < MIN_SAMPLES:
            return None, None
        fracs = _avg_checkpoint_fractions(days)
        return (fracs, method) if fracs else (None, None)

    specific = [d for d in all_days
                if d.get("day_type") == today_day_type and d.get("weekday") == today_weekday]
    f, m = try_set(specific, f"historical/{today_day_type}/wd{today_weekday}")
    if f:
        return f, m

    typed = [d for d in all_days if d.get("day_type") == today_day_type]
    f, m = try_set(typed, f"historical/{today_day_type}")
    if f:
        return f, m

    f, m = try_set(all_days, "historical/overall")
    if f:
        return f, m

    return None, "none"


# ---------------------------------------------------------------------------
# Public: predict EOD from wherever we are right now
# ---------------------------------------------------------------------------

def predict_eod_live(elapsed_now, revenue_now, history_file: Path,
                      today_day_type: str = "normal", today_weekday: int = 0):
    if not revenue_now or revenue_now <= 0 or elapsed_now is None or elapsed_now <= 0:
        return None, "none"

    curve, method = _best_fraction_curve(history_file, today_day_type, today_weekday)
    if curve:
        points = sorted(
            [(0, 0.0)] + [(mins, curve[label]) for label, mins in REFERENCE_CHECKPOINTS
                          if label in curve and mins != MARKET_TOTAL_MIN]
            + [(MARKET_TOTAL_MIN, 1.0)]  # EOD is definitionally fraction 1.0 — force a reliable right edge
        )
        frac = _interp(points, elapsed_now)
        if frac is None:
            # Before the first anchor or after the last — clamp to the nearest edge.
            frac = points[0][1] if elapsed_now < points[0][0] else points[-1][1]
        if frac and frac > 0:
            return round(revenue_now / frac, 2), method

    return round(revenue_now * MARKET_TOTAL_MIN / elapsed_now, 2), "linear"


# ---------------------------------------------------------------------------
# Public: archive a completed day
# ---------------------------------------------------------------------------

def archive_completed_day(day_record: dict, history_file: Path, exchange: str = "nse"):
    """day_record: the {date, weekday, day_type, samples: [...]} object for a
    day that has just been superseded by a new day's first sample."""
    samples = day_record.get("samples") or []
    if not samples:
        return

    date_str = day_record.get("date")
    last_elapsed = max(s["elapsed_minutes"] for s in samples)
    if last_elapsed < EOD_MIN_ELAPSED:
        print(f"  History: {date_str} last sample only reached +{last_elapsed}min "
              f"(< +{EOD_MIN_ELAPSED}min) — not confident enough to use as EOD, skipping")
        return

    history = _load_history(history_file)
    days = history.get("days", [])
    if any(d.get("date") == date_str for d in days):
        print(f"  History: {date_str} already archived — skipping")
        return

    ordered = sorted(samples, key=lambda s: s["elapsed_minutes"])
    eod_revenue = ordered[-1]["total_revenue"]
    if not eod_revenue or eod_revenue <= 0:
        return

    # A day with only one real (EOD-ish) sample has no genuine intraday shape —
    # interpolating earlier checkpoints from a straight line between market
    # open and that single point would be a pure guess, not a measurement.
    # Only trust non-EOD checkpoints when there's at least one other real
    # sample to bracket them against.
    has_intraday_signal = len(ordered) >= 2
    # Pre-open samples (negative elapsed) carry no intraday shape and would
    # leave the points list unsorted around the (0, 0) open anchor.
    points = [(0, 0.0)] + [(s["elapsed_minutes"], s["total_revenue"])
                           for s in ordered if s["elapsed_minutes"] > 0]

    checkpoints = {}
    for label, mins in REFERENCE_CHECKPOINTS:
        if mins == MARKET_TOTAL_MIN:
            rev = eod_revenue
        elif has_intraday_signal:
            rev = _interp(points, mins)
        else:
            rev = None
        checkpoints[label] = {
            "revenue":  round(rev, 4) if rev is not None else None,
            "fraction": round(rev / eod_revenue, 4) if rev is not None else None,
        }

    market_dates = {d["date"] for d in days}
    market_dates.add(date_str)
    day_date = date.fromisoformat(date_str)
    weekday  = day_date.weekday()
    day_type = classify_day(day_date, exchange, market_dates)

    days.append({
        "date":         date_str,
        "weekday":      weekday,
        "weekday_name": WEEKDAY_NAMES[weekday],
        "day_type":     day_type,
        "eod_revenue":  eod_revenue,
        "n_samples":    len(samples),
        "checkpoints":  checkpoints,
    })
    history["days"] = sorted(days, key=lambda d: d["date"])[-60:]

    history_file.parent.mkdir(parents=True, exist_ok=True)
    history_file.write_text(json.dumps(history, indent=2))
    n = len(history["days"])
    print(f"  History: archived {date_str} [{WEEKDAY_NAMES[weekday]}/{day_type}] "
          f"EOD ₹{eod_revenue} Cr from {len(samples)} sample(s) — {n} days total")


# ---------------------------------------------------------------------------
# Public: record this poll's snapshot
# ---------------------------------------------------------------------------

def save_hourly_snapshot(revenue, now_ist, hourly_file: Path, history_file: Path,
                         exchange: str = "nse"):
    if not revenue or not revenue.get("has_data"):
        return

    today_str  = now_ist.strftime("%Y-%m-%d")

    # Key samples on the exchange's own trade date, never the wall clock: on a
    # holiday, and before the open, the API still reports the previous
    # session's totals under the previous session's date.
    trade_date = normalize_trade_date(revenue.get("trade_date"))
    if trade_date != today_str:
        print(f"  Hourly snapshot skipped: exchange trade date {revenue.get('trade_date')!r} "
              f"is not today ({today_str}) — market not trading yet or closed")
        return
    if (now_ist.hour * 60 + now_ist.minute) < MARKET_OPEN_MIN:
        print("  Hourly snapshot skipped: before 9:15 AM open")
        return
    today_date = now_ist.date()
    weekday    = today_date.weekday()

    hist_data    = _load_history(history_file)
    market_dates = {d["date"] for d in hist_data.get("days", [])}
    market_dates.add(today_str)
    day_type = classify_day(today_date, exchange, market_dates)

    existing = {}
    if hourly_file.exists():
        try:
            existing = json.loads(hourly_file.read_text())
        except Exception:
            existing = {}

    if existing.get("date") and existing["date"] != today_str:
        # A new day's first sample has arrived — archive the previous day
        # (whatever samples it managed to collect) before starting fresh.
        archive_completed_day(existing, history_file, exchange)
        existing = {}

    if not existing:
        existing = {"date": today_str, "weekday": weekday,
                    "weekday_name": WEEKDAY_NAMES[weekday], "day_type": day_type,
                    "samples": []}

    elapsed   = (now_ist.hour * 60 + now_ist.minute) - MARKET_OPEN_MIN
    total_rev = round(float(revenue.get("total_revenue") or 0), 2)

    pred, method = predict_eod_live(elapsed, total_rev, history_file, day_type, weekday)

    samples = existing.get("samples", [])
    samples.append({
        "captured_ist":    now_ist.strftime("%Y-%m-%dT%H:%M:%S"),
        "elapsed_minutes": elapsed,
        "total_revenue":   total_rev,
        "cash_revenue":    round(float(revenue.get("cash_revenue")    or 0), 2),
        "options_revenue": round(float(revenue.get("options_revenue")  or 0), 2),
        "futures_revenue": round(float(revenue.get("futures_revenue")  or 0), 2),
        "predicted_eod":   pred,
        "pred_method":     method,
    })
    samples.sort(key=lambda s: s["elapsed_minutes"])
    existing["samples"] = samples

    hourly_file.parent.mkdir(parents=True, exist_ok=True)
    hourly_file.write_text(json.dumps(existing, indent=2))
    print(f"  [{WEEKDAY_NAMES[weekday]}/{day_type}] +{elapsed}min — "
          f"₹{total_rev} Cr, pred EOD ₹{pred} Cr [{method}]")
