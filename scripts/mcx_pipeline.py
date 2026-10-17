"""
MCX Pipeline — Daily Updater
Reads MCX daily revenue from Supabase, recomputes all aggregates,
writes mcx_dashboard_data.json + mcx_enriched_data.json for the dashboard.

Modelled history: mcx_daily_revenue rows before 2024-09-02 are a historical
backfill written by the mcx-vercel repo (source = mcx_historical_backfill,
is_actual = false): futures/options revenue scaled to reported quarters with a
derived options split, plus a flat ₹0.95 Cr/day of non-transaction revenue in
total_rev_cr. Those rows stay in the series flagged `modelled: true` (and are
counted per period as `modelled_days`) so the dashboard can keep them out of
YoY and segment-mix comparisons; total_rev is always fut + opt + cash, never
total_rev_cr, so the non-transaction amount is not counted.

Environment variables:
  MCX_SUPABASE_URL   — Supabase project URL  (defaults to MCX project)
  MCX_SUPABASE_KEY   — read key for the MCX project (required; GitHub secret)
"""

import json
import os
import sys
import urllib.request
import urllib.error
from datetime import datetime, timedelta
from pathlib import Path
from collections import OrderedDict

import trading_calendar

# Load .env for local development
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# ── Config ──────────────────────────────────────────────────────────────────
MCX_SUPABASE_URL = os.environ.get(
    "MCX_SUPABASE_URL",
    "https://avqwpebveqetwwzkmtux.supabase.co",
)
MCX_SUPABASE_KEY = os.environ.get("MCX_SUPABASE_KEY", "")

SCRIPT_DIR  = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
DATA_DIR    = PROJECT_ROOT / "data"
DASHBOARD_DIR = PROJECT_ROOT / "dashboard" / "data"

DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
        "Saturday", "Sunday"]

MODELLED_SOURCES = {"mcx_historical_backfill"}


# ═══════════════════════════════════════════════════════════════
# SECTION 1: SUPABASE FETCH
# ═══════════════════════════════════════════════════════════════

def _sb_get(path, page_size=1000, max_rows=10000):
    """Paginated GET from Supabase REST API (no SDK dependency)."""
    all_rows = []
    offset = 0
    sep = "&" if "?" in path else "?"
    while True:
        url = f"{MCX_SUPABASE_URL}/rest/v1/{path}{sep}limit={page_size}&offset={offset}"
        req = urllib.request.Request(url, headers={
            "apikey": MCX_SUPABASE_KEY,
            "Authorization": f"Bearer {MCX_SUPABASE_KEY}",
        })
        with urllib.request.urlopen(req, timeout=30) as r:
            page = json.loads(r.read().decode())
        all_rows.extend(page)
        if len(page) < page_size or len(all_rows) >= max_rows:
            break
        offset += page_size
    return all_rows[:max_rows]


def fetch_mcx_daily():
    """Fetch all rows from mcx_daily_revenue, ordered by date."""
    rows = _sb_get(
        "mcx_daily_revenue"
        "?select=trading_date,fut_rev_cr,opt_rev_cr,total_rev_cr,source,is_actual"
        "&order=trading_date.asc"
    )
    return rows


# ═══════════════════════════════════════════════════════════════
# SECTION 2: TRANSFORM
# ═══════════════════════════════════════════════════════════════

def _fy_label(dt):
    """Return 'FY YYYY' label. Indian FY: Apr-Mar."""
    if dt.month >= 4:
        return f"FY {dt.year + 1}"
    return f"FY {dt.year}"


def _fy_quarter(dt):
    """Return 'Q1 FY 2027' style label."""
    if dt.month >= 4 and dt.month <= 6:
        q, fy_year = "Q1", dt.year + 1
    elif dt.month >= 7 and dt.month <= 9:
        q, fy_year = "Q2", dt.year + 1
    elif dt.month >= 10 and dt.month <= 12:
        q, fy_year = "Q3", dt.year + 1
    else:
        q, fy_year = "Q4", dt.year
    return f"{q} FY {fy_year}"


def _fy_month(dt):
    """Return 'FY 2027 April' style label."""
    fy = _fy_label(dt)
    return f"{fy} {dt.strftime('%B')}"


def is_modelled(row):
    """True for rows the mcx-vercel repo modelled rather than measured."""
    return row.get("is_actual") is False or row.get("source") in MODELLED_SOURCES


def transform_rows(raw_rows):
    """Convert Supabase rows to the same daily record format as NSE/BSE.
    MCX has Futures and Options only — cash_rev is always 0. total_rev is
    transaction revenue (fut + opt + cash); total_rev_cr is ignored because
    the modelled rows add ₹0.95 Cr/day of non-transaction revenue to it.
    """
    records = []
    non_txn = 0
    for r in raw_rows:
        try:
            dt = datetime.strptime(r["trading_date"], "%Y-%m-%d")
        except (ValueError, TypeError):
            continue
        fut_rev  = float(r.get("fut_rev_cr") or 0)
        opt_rev  = float(r.get("opt_rev_cr") or 0)
        cash_rev = 0.0
        if fut_rev + opt_rev <= 0:
            continue
        total_rev = fut_rev + opt_rev + cash_rev
        if r.get("total_rev_cr") is not None and abs(float(r["total_rev_cr"]) - total_rev) > 0.0005:
            non_txn += 1

        records.append({
            "date":        dt.strftime("%Y-%m-%d"),
            "day":         DAYS[dt.weekday()],
            "fy":          _fy_label(dt),
            "fy_quarter":  _fy_quarter(dt),
            "fy_month":    _fy_month(dt),
            "fut_rev":     round(fut_rev,   4),
            "opt_rev":     round(opt_rev,   4),
            "cash_rev":    cash_rev,
            "total_rev":   round(total_rev, 4),
            "modelled":    is_modelled(r),
        })
    if non_txn:
        print(f"  {non_txn} rows had total_rev_cr != fut + opt (non-transaction revenue, not counted)")
    return records


def modelled_history(daily):
    """Summary of the modelled rows, for the top of both JSON documents."""
    rows = [d for d in daily if d.get("modelled")]
    return {
        "days": len(rows),
        "first_date": rows[0]["date"] if rows else None,
        "last_date": rows[-1]["date"] if rows else None,
        "note": ("Historical backfill (mcx_historical_backfill, is_actual=false): futures/"
                 "options revenue scaled to reported quarters with a derived options split. "
                 "Kept in the series; exclude from YoY and segment-mix comparisons."),
    }


# ═══════════════════════════════════════════════════════════════
# SECTION 3: AGGREGATIONS  (shared with BSE pipeline structure)
# ═══════════════════════════════════════════════════════════════

def recompute_quarterly(daily):
    quarters = OrderedDict()
    for d in daily:
        q = d["fy_quarter"]
        if q not in quarters:
            quarters[q] = {"quarter": q, "opt_rev": 0.0, "fut_rev": 0.0,
                           "cash_rev": 0.0, "total_rev": 0.0, "days": 0,
                           "modelled_days": 0}
        for k in ["opt_rev", "fut_rev", "cash_rev", "total_rev"]:
            quarters[q][k] += float(d.get(k, 0) or 0)
        quarters[q]["days"] += 1
        quarters[q]["modelled_days"] += bool(d.get("modelled"))
    return [{k: round(v, 4) if isinstance(v, float) else v
             for k, v in q.items()} for q in quarters.values()]


def recompute_monthly(daily):
    months = OrderedDict()
    for d in daily:
        m = d["fy_month"]
        if m not in months:
            months[m] = {"month": m, "opt_rev": 0.0, "fut_rev": 0.0,
                         "cash_rev": 0.0, "total_rev": 0.0, "days": 0,
                         "modelled_days": 0}
        for k in ["opt_rev", "fut_rev", "cash_rev", "total_rev"]:
            months[m][k] += float(d.get(k, 0) or 0)
        months[m]["days"] += 1
        months[m]["modelled_days"] += bool(d.get("modelled"))
    return [{k: round(v, 4) if isinstance(v, float) else v
             for k, v in m.items()} for m in months.values()]


def compute_summary(daily, quarterly):
    last = daily[-1] if daily else {}
    cq   = quarterly[-1] if quarterly else {}
    return {
        "current_quarter": cq.get("quarter", ""),
        "last_date":       last.get("date", ""),
        "total_trading_days": len(daily),
    }


# ═══════════════════════════════════════════════════════════════
# SECTION 4: ENRICHED DATA
# ═══════════════════════════════════════════════════════════════

def seg_summary(daily_data, rev_key):
    q = recompute_quarterly(daily_data)
    cq  = q[-1]  if q            else None
    pq  = q[-2]  if len(q) > 1  else None
    yoy_q = None
    if cq:
        parts = cq["quarter"].split()
        target_label = f"{parts[0]} FY {int(parts[2]) - 1}"
        yoy_q = next((x for x in q if x["quarter"] == target_label), None)

    cq_avg  = float(cq[rev_key])  / max(cq["days"], 1)  if cq  else 0
    pq_avg  = float(pq[rev_key])  / max(pq["days"], 1)  if pq  else 0
    yoy_avg = float(yoy_q[rev_key]) / max(yoy_q["days"], 1) if yoy_q else 0

    # modelled_days: rows in that period from the modelled backfill; a
    # comparison against a period with modelled_days > 0 is not like for like.
    quarterly_data = {
        "current":  {"label": cq["quarter"] if cq else "",
                     "value": round(cq_avg, 4),
                     "qoq": round((cq_avg - pq_avg) / pq_avg, 4) if pq_avg else 0,
                     "yoy": round((cq_avg - yoy_avg) / yoy_avg, 4) if yoy_avg else 0,
                     "modelled_days": cq["modelled_days"] if cq else 0},
        "previous": {"label": pq["quarter"] if pq else "",
                     "value": round(pq_avg, 4),
                     "modelled_days": pq["modelled_days"] if pq else 0},
        "prev2":    {"label": yoy_q["quarter"] if yoy_q else "",
                     "value": round(yoy_avg, 4),
                     "modelled_days": yoy_q["modelled_days"] if yoy_q else 0},
    }

    m = recompute_monthly(daily_data)
    cm  = m[-1] if m            else None
    pm  = m[-2] if len(m) > 1  else None
    cm_avg  = float(cm[rev_key]) / max(cm["days"], 1)  if cm  else 0
    pm_avg  = float(pm[rev_key]) / max(pm["days"], 1)  if pm  else 0
    # 125 trading days (~6 months at ~21 trading days/month) of actual daily
    # rows, not an average of 6 calendar-month buckets -- avoids over/under-
    # weighting a short month (e.g. one with a cluster of holidays) the same
    # as a full one.
    last125 = daily_data[-125:] if len(daily_data) >= 125 else daily_data
    avg_6m  = sum(float(x[rev_key]) for x in last125) / max(len(last125), 1)

    monthly_data = {
        "current":  {"label": cm["month"] if cm else "",
                     "value": round(cm_avg, 4),
                     "mom":  round((cm_avg - pm_avg) / pm_avg, 4) if pm_avg else 0,
                     "mo6m": round((cm_avg - avg_6m) / avg_6m, 4) if avg_6m else 0,
                     "modelled_days": cm["modelled_days"] if cm else 0},
        "previous": {"label": pm["month"] if pm else "",
                     "value": round(pm_avg, 4),
                     "modelled_days": pm["modelled_days"] if pm else 0},
        "avg_6m":   {"label": "Avg Of Last 6 Months",
                     "value": round(avg_6m, 4)},
    }

    last5 = daily_data[-5:]  if len(daily_data) >= 5  else daily_data
    prev5 = daily_data[-10:-5] if len(daily_data) >= 10 else []
    last20 = daily_data[-20:] if len(daily_data) >= 20 else daily_data
    last45 = daily_data[-45:] if len(daily_data) >= 45 else daily_data
    l5_avg  = sum(float(d[rev_key]) for d in last5)  / max(len(last5),  1)
    p5_avg  = sum(float(d[rev_key]) for d in prev5)  / max(len(prev5),  1) if prev5 else 0
    l20_avg = sum(float(d[rev_key]) for d in last20) / max(len(last20), 1)
    l45_avg = sum(float(d[rev_key]) for d in last45) / max(len(last45), 1)

    weekly_data = {
        "last5":  {"label": "Last 5 Trading Days", "value": round(l5_avg, 4),
                   "wow":   round((l5_avg - p5_avg)  / p5_avg,  4) if p5_avg  else 0,
                   "wo10w": round((l5_avg - l45_avg) / l45_avg, 4) if l45_avg else 0},
        "prev5":  {"label": "Previous 5 Trading Days", "value": round(p5_avg, 4)},
        "last20": {"label": "Last 20 Trading Days",    "value": round(l20_avg, 4)},
        "last45": {"label": "Last 45 Trading Days",    "value": round(l45_avg, 4)},
    }

    pq_label = pq["quarter"] if pq else None
    cq_label = cq["quarter"] if cq else None
    yoy_label = yoy_q["quarter"] if yoy_q else None

    days_list = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
    dow = {}
    prev_week = {}
    for day_name in days_list:
        recs = [d for d in daily_data if d["day"] == day_name]
        latest = float(recs[-1][rev_key]) if recs else 0
        last3  = recs[-3:]  if len(recs) >= 3  else recs
        last10 = recs[-10:] if len(recs) >= 10 else recs
        avg3   = sum(float(d[rev_key]) for d in last3)  / max(len(last3),  1)
        avg10  = sum(float(d[rev_key]) for d in last10) / max(len(last10), 1)

        pq_recs = [d for d in recs if d.get("fy_quarter") == pq_label] if pq_label else []
        pq_day_avg = sum(float(d[rev_key]) for d in pq_recs) / len(pq_recs) if pq_recs else None

        # Per-weekday quarter comparison — this weekday's average revenue within
        # the current quarter, previous quarter, and same quarter a year ago.
        cq_recs = [d for d in recs if d.get("fy_quarter") == cq_label] if cq_label else []
        cq_day_avg = sum(float(d[rev_key]) for d in cq_recs) / len(cq_recs) if cq_recs else None
        yoy_recs = [d for d in recs if d.get("fy_quarter") == yoy_label] if yoy_label else []
        yoy_day_avg = sum(float(d[rev_key]) for d in yoy_recs) / len(yoy_recs) if yoy_recs else None

        dow[day_name] = {
            "latest": round(latest, 4),
            "do3d":   round((latest - avg3)  / avg3,  4) if avg3  else 0,
            "do10d":  round((latest - avg10) / avg10, 4) if avg10 else 0,
            "avg_3d": round(avg3,  4),
            "avg_10d": round(avg10, 4),
            "prev_q_label": pq_label,
            "prev_q_avg": round(pq_day_avg, 4) if pq_day_avg is not None else None,
            "do_prev_q": round((latest - pq_day_avg) / pq_day_avg, 4) if pq_day_avg else None,
            "cur_q_label": cq_label,
            "cur_q_avg": round(cq_day_avg, 4) if cq_day_avg is not None else None,
            "yoy_q_label": yoy_label,
            "yoy_q_avg": round(yoy_day_avg, 4) if yoy_day_avg is not None else None,
            "qoq": round((cq_day_avg - pq_day_avg) / pq_day_avg, 4) if cq_day_avg is not None and pq_day_avg else None,
            "yoy": round((cq_day_avg - yoy_day_avg) / yoy_day_avg, 4) if cq_day_avg is not None and yoy_day_avg else None,
        }
        # Previous week = this weekday's own second-to-last occurrence, not a fixed
        # daily_data[-10:-5] slice — that assumes the trailing 10 rows split evenly
        # into two complete 5-day weeks, which breaks on holiday gaps or an
        # in-progress current week.
        if len(recs) >= 2:
            prev_week[day_name] = round(float(recs[-2][rev_key]), 4)

    # FY-level YoY
    fy_groups = OrderedDict()
    for d in daily_data:
        f = d["fy"]
        if f not in fy_groups:
            fy_groups[f] = {"sum": 0.0, "count": 0, "modelled": 0}
        fy_groups[f]["sum"]   += float(d.get(rev_key, 0) or 0)
        fy_groups[f]["count"] += 1
        fy_groups[f]["modelled"] += bool(d.get("modelled"))
    fy_list = list(fy_groups.values())
    curr_fy_avg = fy_list[-1]["sum"] / max(fy_list[-1]["count"], 1) if fy_list else 0
    prev_fy_avg = fy_list[-2]["sum"] / max(fy_list[-2]["count"], 1) if len(fy_list) > 1 else 0
    fy_yoy      = (curr_fy_avg - prev_fy_avg) / prev_fy_avg if prev_fy_avg else 0

    return {
        "quarterly":     quarterly_data,
        "monthly":       monthly_data,
        "weekly":        weekly_data,
        "day_of_week":   dow,
        "previous_week": prev_week,
        "fy": {
            "current":  round(curr_fy_avg, 4),
            "previous": round(prev_fy_avg, 4),
            "yoy":      round(fy_yoy,      4),
            "current_modelled_days":  fy_list[-1]["modelled"] if fy_list else 0,
            "previous_modelled_days": fy_list[-2]["modelled"] if len(fy_list) > 1 else 0,
        },
    }


def compute_enriched(daily, quarterly):
    enriched = {
        "summary_total": seg_summary(daily, "total_rev"),
        "seg_options":   seg_summary(daily, "opt_rev"),
        "seg_futures":   seg_summary(daily, "fut_rev"),
        "seg_cash":      seg_summary(daily, "cash_rev"),  # always zero for MCX
    }

    cq = quarterly[-1] if quarterly else None
    if cq:
        days_so_far    = cq["days"]
        expected_days  = 62
        daily_avg      = float(cq["total_rev"]) / max(days_so_far, 1)
        other_income_ratio = 0.0  # MCX: minimal non-F&O income at this scale
        txn_rev_extrap = daily_avg * expected_days
        total_rev_pred = txn_rev_extrap * (1 + other_income_ratio)
        enriched["pnl_predictor"] = {
            "daily_avg_rev":                round(daily_avg,      4),
            "trading_days_so_far":          days_so_far,
            "expected_trading_days":        expected_days,
            "transaction_rev_extrapolated": round(txn_rev_extrap, 2),
            "other_income_ratio":           round(other_income_ratio, 4),
            "total_revenue_predicted":      round(total_rev_pred, 2),
        }
    else:
        enriched["pnl_predictor"] = {}

    enriched["modelled_history"] = modelled_history(daily)
    return enriched


# ═══════════════════════════════════════════════════════════════
# SECTION 5: WRITE JSON FILES
# ═══════════════════════════════════════════════════════════════

def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    print(f"  Wrote {path} ({path.stat().st_size // 1024} KB)")


# ═══════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════

def main():
    print("=" * 60)
    print("MCX Pipeline")
    print("=" * 60)

    if not MCX_SUPABASE_KEY:
        print("ERROR: MCX_SUPABASE_KEY is not set (GitHub secret).")
        sys.exit(1)

    # Read existing latest date before overwriting
    existing_latest = None
    existing_json = DASHBOARD_DIR / "mcx_dashboard_data.json"
    if existing_json.exists():
        try:
            with open(existing_json) as f:
                existing_latest = json.load(f).get("summary", {}).get("last_date")
        except Exception:
            pass

    print("Fetching MCX daily revenue from Supabase…")
    try:
        raw = fetch_mcx_daily()
    except Exception as e:
        print(f"ERROR fetching MCX data: {e}")
        sys.exit(1)
    print(f"  Fetched {len(raw)} raw rows")

    daily = transform_rows(raw)
    if not daily:
        print("ERROR: No valid MCX daily records after transform")
        sys.exit(1)
    # Muhurat sessions stay out of every aggregate (scripts/trading_calendar.py)
    daily, special = trading_calendar.split_special(daily, "mcx")
    if special:
        print(f"  Special sessions kept out of aggregates: {[r['date'] for r in special]}")

    quarterly = recompute_quarterly(daily)
    monthly   = recompute_monthly(daily)
    summary   = compute_summary(daily, quarterly)
    enriched  = compute_enriched(daily, quarterly)

    new_latest = summary["last_date"]
    print(f"  Latest date: {new_latest}")
    print(f"  Total daily records: {len(daily)}")
    print(f"  Current quarter: {summary['current_quarter']}")

    # Count new days added vs previous run
    new_count = 0
    if existing_latest and new_latest > existing_latest:
        # Approximate count by date comparison
        new_count = sum(1 for d in daily if d["date"] > existing_latest)
    elif not existing_latest:
        new_count = len(daily)
    print(f"  New days this run: {new_count}")

    # dashboard_data.json
    dashboard_data = {
        "daily":     daily,
        "daily_all": daily,
        "monthly":   monthly,
        "quarterly": quarterly,
        "summary":   summary,
        "modelled_history": modelled_history(daily),
        "special_sessions": special,
    }

    for out_dir in [DATA_DIR, DASHBOARD_DIR]:
        write_json(out_dir / "mcx_dashboard_data.json", dashboard_data)
        write_json(out_dir / "mcx_enriched_data.json",  enriched)

    print("=" * 60)
    print("MCX pipeline complete.")
    print("=" * 60)

    return new_count


if __name__ == "__main__":
    count = main()
    count_file = PROJECT_ROOT / ".new_mcx_days_count"
    count_file.write_text(str(count or 0))
