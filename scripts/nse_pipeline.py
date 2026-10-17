"""
NSE Cloud Pipeline — GitHub Actions Daily Updater
Fetches NSE data via curl_cffi, upserts to Supabase, recomputes all aggregates,
writes dashboard_data.json + enriched_data.json for Vercel static build.

Environment variables (set as GitHub Secrets):
  SUPABASE_URL        — e.g. https://xxxx.supabase.co
  SUPABASE_KEY        — service_role key (not anon)
"""

import json
import os
import sys
import math
from datetime import datetime, timedelta
from pathlib import Path
from collections import OrderedDict

# Load .env for local development
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# ── Config ──
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")

SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
DATA_DIR = PROJECT_ROOT / "data"
DASHBOARD_DIR = PROJECT_ROOT / "dashboard"

# ── Take Rates: today's rates from scripts/take_rates.py; the date-effective
# variant prices each day with scripts/fee_register.py ──
import fee_register
from take_rates import NSE_TR_FUT as TR_FUT, NSE_TR_OPT as TR_OPT, NSE_TR_CASH as TR_CASH


# ═══════════════════════════════════════════════════════════════
# SECTION 0: VIX DATA FETCHER (Yahoo Finance ^INDIAVIX)
# ═══════════════════════════════════════════════════════════════

def fetch_indiavix_map(start_date, end_date):
    """Fetch India VIX closing prices from Yahoo Finance.
    Returns {date_str: vix_value} for the given date range, or {} on failure.
    """
    try:
        import yfinance as yf
        end_dt = datetime.strptime(end_date, "%Y-%m-%d") + timedelta(days=2)
        ticker = yf.Ticker("^INDIAVIX")
        hist = ticker.history(start=start_date, end=end_dt.strftime("%Y-%m-%d"))
        if hist.empty:
            print("WARNING: No VIX data returned from Yahoo Finance")
            return {}
        result = {str(idx.date()): round(float(row["Close"]), 4)
                  for idx, row in hist.iterrows()}
        print(f"Fetched {len(result)} India VIX data points ({start_date} to {end_date})")
        return result
    except ImportError:
        print("WARNING: yfinance not installed — VIX data unavailable. Run: pip install yfinance")
        return {}
    except Exception as e:
        print(f"WARNING: VIX fetch failed (non-fatal): {e}")
        return {}


# ═══════════════════════════════════════════════════════════════
# SECTION 1: NSE DATA FETCHER (curl_cffi with Chrome impersonation)
# ═══════════════════════════════════════════════════════════════

def fetch_nse_data():
    """Fetch current month's F&O and Cash data from NSE APIs."""
    try:
        from curl_cffi import requests as cffi_requests
    except ImportError:
        print("ERROR: curl_cffi not installed. Run: pip install curl_cffi")
        sys.exit(1)

    session = cffi_requests.Session()

    # Warm up — get session cookies from NSE homepage
    print("Warming up NSE session...")
    resp = session.get("https://www.nseindia.com/", impersonate="chrome")
    if resp.status_code != 200:
        print(f"WARNING: Homepage returned {resp.status_code}, trying API anyway...")

    now = datetime.now()
    prev = now.replace(day=1) - timedelta(days=1)
    # Early in a month also fetch the previous one: a month-end session that
    # NSE publishes late would otherwise never be requested again.
    months = [now, prev] if now.day <= 5 else [now]

    def get_json(url, missing_ok=False):
        print(f"Fetching: {url}")
        resp = session.get(url, impersonate="chrome", timeout=30)
        if resp.status_code != 200:
            if missing_ok:
                print(f"  HTTP {resp.status_code} — month not published yet, treating as empty")
                return []
            raise RuntimeError(f"NSE returned HTTP {resp.status_code} for {url}")
        return resp.json().get("data", []) or []

    fo_data, cm_data = [], []
    for m in months:
        # The current month may not exist yet in its first days
        missing_ok = (m is now and now.day <= 5)
        fo_data += get_json("https://www.nseindia.com/api/historicalOR/fo/tbg/daily"
                            f"?month={m.strftime('%b')}&year={m.year}", missing_ok)
        cm_data += get_json("https://www.nseindia.com/api/historicalOR/cm/tbg/daily"
                            f"?month={m.strftime('%b')}&year={m.strftime('%y')}", missing_ok)
    if not fo_data and prev not in months:
        # First trading day of the month not published yet
        fo_data = get_json("https://www.nseindia.com/api/historicalOR/fo/tbg/daily"
                           f"?month={prev.strftime('%b')}&year={prev.year}")
        cm_data = get_json("https://www.nseindia.com/api/historicalOR/cm/tbg/daily"
                           f"?month={prev.strftime('%b')}&year={prev.strftime('%y')}")

    print(f"F&O records: {len(fo_data)}, Cash records: {len(cm_data)}")
    return {"data": fo_data}, {"data": cm_data}


# ═══════════════════════════════════════════════════════════════
# SECTION 2: DATA PARSING (same logic as nse_updater.py)
# ═══════════════════════════════════════════════════════════════

def date_to_fy_quarter(dt):
    m, y = dt.month, dt.year
    if m >= 4:
        fy_year = y + 1
        q = 1 if m <= 6 else (2 if m <= 9 else 3)
    else:
        fy_year = y
        q = 4
    return f"Q{q} FY {fy_year}"

def date_to_fy_month(dt):
    fy_year = dt.year + 1 if dt.month >= 4 else dt.year
    return f"FY {fy_year} {dt.strftime('%B')}"

def date_to_fy(dt):
    fy_year = dt.year + 1 if dt.month >= 4 else dt.year
    return f"FY {fy_year}"

def fo_revenue(if_turnover, sf_turnover, io_premium, so_premium, tr_fut=TR_FUT, tr_opt=TR_OPT):
    """F&O revenue fields (₹ Cr): futures on notional turnover, options on
    premium. The one formula for parsed rows and date-effective re-pricing."""
    if_rev  = if_turnover * tr_fut
    sf_rev  = sf_turnover * tr_fut
    fut_rev = if_rev + sf_rev
    io_rev  = io_premium * tr_opt
    so_rev  = so_premium * tr_opt
    opt_rev = io_rev + so_rev
    fo_rev  = fut_rev + opt_rev
    return {
        "if_rev": round(if_rev, 4),
        "sf_rev": round(sf_rev, 4),
        "fut_rev": round(fut_rev, 4),
        "io_rev": round(io_rev, 4),
        "so_rev": round(so_rev, 4),
        "opt_rev": round(opt_rev, 4),
        "fo_rev": round(fo_rev, 4),
    }

def cash_revenue(cash_traded_value, tr_cash=TR_CASH):
    return round(cash_traded_value * tr_cash, 4)

def total_revenue(row):
    """total_rev from a row's (rounded) fo_rev and cash_rev."""
    return round(row["fo_rev"] + row["cash_rev"], 4)

def parse_fo_record(rec):
    d = rec.get("data", rec)
    date_str = d.get("date", d.get("F_TIMESTAMP", ""))
    dt = datetime.strptime(date_str, "%d-%b-%Y")

    if_turnover   = float(d.get("Index_Futures_VAL", 0))
    sf_turnover   = float(d.get("Stock_Futures_VAL", 0))
    io_notional   = float(d.get("Index_Options_VAL", 0))
    io_premium    = float(d.get("Index_Options_PREM_VAL", 0))
    so_notional   = float(d.get("Stock_Options_VAL", 0))
    so_premium    = float(d.get("Stock_Options_PREM_VAL", 0))
    io_pcr        = float(d.get("Index_Options_PUT_CALL_RATIO", 0))
    total_contracts = int(d.get("F&O_Total_QTY", 0))
    total_turnover  = float(d.get("F&O_Total_VAL", 0))

    total_premium  = io_premium + so_premium
    total_notional = io_notional + so_notional
    pn_ratio = total_premium / total_notional if total_notional > 0 else 0

    return {
        "date": dt.strftime("%Y-%m-%d"),
        "day": dt.strftime("%A"),
        "fy_quarter": date_to_fy_quarter(dt),
        "fy_month": date_to_fy_month(dt),
        "fy": date_to_fy(dt),
        "if_turnover": round(if_turnover, 2),
        "sf_turnover": round(sf_turnover, 2),
        "io_notional": round(io_notional, 2),
        "io_premium": round(io_premium, 2),
        "so_notional": round(so_notional, 2),
        "so_premium": round(so_premium, 2),
        "io_pcr": round(io_pcr, 2),
        "total_contracts": total_contracts,
        "total_turnover": round(total_turnover, 2),
        **fo_revenue(if_turnover, sf_turnover, io_premium, so_premium),
        "pn_ratio": pn_ratio,
        "vix": 0,
        "_dt": dt,
    }

def parse_cm_record(rec):
    d = rec.get("data", rec)
    date_str = d.get("F_TIMESTAMP", "")
    dt = datetime.strptime(date_str, "%d-%b-%Y")
    cash_traded_value = float(d.get("CDT_TRADES_VALUES", 0))
    return {
        "date": dt.strftime("%Y-%m-%d"),
        "cash_traded_value": round(cash_traded_value, 2),
        "cash_rev": cash_revenue(cash_traded_value),
    }


def _num(row, key):
    return float(row.get(key) or 0)


def reprice_date_effective(daily):
    """Copies of `daily` rows with every revenue field re-priced from turnover
    at the fee rules in force on each row's date (scripts/fee_register.py),
    plus fee_basis (least exact basis of the row's products) and
    fee_basis_by_product. Same formulas and rounding as parsed rows.

    A row whose rules all equal today's rates is already priced at them and
    keeps its stored figures, so both variants agree exactly from 2026-03-01
    (some stored total_rev values were rounded from unrounded components and
    would otherwise differ by ₹0.0001 Cr)."""
    today = (TR_FUT, TR_OPT, TR_CASH)
    out = []
    for d in daily:
        rates = fee_register.day_rates("NSE", d["date"])
        r = dict(d)
        if (rates["fut"][0], rates["opt"][0], rates["cash"][0]) != today:
            r.update(fo_revenue(_num(d, "if_turnover"), _num(d, "sf_turnover"),
                                _num(d, "io_premium"), _num(d, "so_premium"),
                                rates["fut"][0], rates["opt"][0]))
            r["cash_rev"] = cash_revenue(_num(d, "cash_traded_value"), rates["cash"][0])
            r["total_rev"] = total_revenue(r)
        r["fee_basis"] = fee_register.combined_basis(b for _, b in rates.values())
        r["fee_basis_by_product"] = {p: b for p, (_, b) in rates.items()}
        out.append(r)
    return out


# ═══════════════════════════════════════════════════════════════
# SECTION 3: SUPABASE OPERATIONS
# ═══════════════════════════════════════════════════════════════

def get_supabase_client():
    from supabase import create_client
    return create_client(SUPABASE_URL, SUPABASE_KEY)

def get_existing_dates(supabase):
    """Get all existing dates from nse_daily table."""
    result = supabase.table("nse_daily").select("date").execute()
    return {row["date"] for row in result.data}

def upsert_daily_records(supabase, records):
    """Upsert parsed daily records into Supabase."""
    if not records:
        return 0

    # Remove internal keys, prepare for upsert
    clean = []
    for r in records:
        row = {k: v for k, v in r.items() if k != "_dt"}
        clean.append(row)

    # Upsert in batches of 50
    inserted = 0
    for i in range(0, len(clean), 50):
        batch = clean[i:i+50]
        supabase.table("nse_daily").upsert(batch, on_conflict="date").execute()
        inserted += len(batch)

    return inserted

def fetch_all_daily(supabase):
    """Fetch all daily records from Supabase, ordered by date."""
    all_records = []
    offset = 0
    batch_size = 1000
    while True:
        result = (supabase.table("nse_daily")
                  .select("*")
                  .order("date")
                  .range(offset, offset + batch_size - 1)
                  .execute())
        if not result.data:
            break
        all_records.extend(result.data)
        if len(result.data) < batch_size:
            break
        offset += batch_size
    return all_records

def quarter_sort_key(label):
    """'Q3 FY 2026' → (2026, 3), so quarters sort chronologically. Ordering by
    the label text puts every Q1 before every Q2 regardless of year."""
    try:
        q, _, fy = str(label).split()
        return (int(fy), int(q[1:]))
    except (ValueError, AttributeError):
        return (0, 0)


def fetch_pnl(supabase):
    """Fetch P&L data, oldest quarter first."""
    result = supabase.table("nse_pnl").select("*").execute()
    return sorted(result.data, key=lambda r: quarter_sort_key(r.get("quarter")))

def fetch_pnl_fy(supabase):
    result = supabase.table("nse_pnl_fy").select("*").order("fy").execute()
    return result.data

def fetch_cost_ratios(supabase):
    result = supabase.table("nse_cost_ratios").select("*").execute()
    return {row["quarter"]: {k: v for k, v in row.items() if k != "quarter"} for row in result.data}

def save_aggregates(supabase, key, data):
    """Save a computed aggregate to nse_aggregates table."""
    supabase.table("nse_aggregates").upsert({
        "key": key,
        "data": data,
        "updated_at": datetime.utcnow().isoformat()
    }, on_conflict="key").execute()

def log_pipeline_run(supabase, new_days, latest_date, status="success", details=""):
    supabase.table("nse_pipeline_runs").insert({
        "new_days_added": new_days,
        "latest_date": latest_date,
        "status": status,
        "details": details,
        "source": "github_actions"
    }).execute()


# ═══════════════════════════════════════════════════════════════
# SECTION 4: AGGREGATE COMPUTATIONS (same as nse_updater.py)
# ═══════════════════════════════════════════════════════════════

def recompute_quarterly(daily):
    quarters = OrderedDict()
    for d in daily:
        q = d["fy_quarter"]
        if q not in quarters:
            quarters[q] = {"quarter": q, "opt_rev": 0, "fut_rev": 0, "cash_rev": 0,
                           "total_rev": 0, "days": 0, "io_rev": 0, "so_rev": 0,
                           "if_rev": 0, "sf_rev": 0}
        for k in ["opt_rev","fut_rev","cash_rev","total_rev","io_rev","so_rev","if_rev","sf_rev"]:
            quarters[q][k] += float(d.get(k, 0) or 0)
        quarters[q]["days"] += 1

    return [{k: round(v, 2) if isinstance(v, float) else v
             for k, v in q.items()} for q in quarters.values()]

def recompute_monthly(daily):
    months = OrderedDict()
    for d in daily:
        m = d["fy_month"]
        if m not in months:
            months[m] = {"month": m, "opt_rev": 0, "fut_rev": 0, "cash_rev": 0,
                         "total_rev": 0, "days": 0}
        for k in ["opt_rev","fut_rev","cash_rev","total_rev"]:
            months[m][k] += float(d.get(k, 0) or 0)
        months[m]["days"] += 1

    return [{k: round(v, 2) if isinstance(v, float) else v
             for k, v in m.items()} for m in months.values()]

def week_label(d):
    """Monday of the row's week, 'YYYY-MM-DD' (the weekly aggregate's key)."""
    dt = datetime.strptime(d["date"], "%Y-%m-%d")
    return (dt - timedelta(days=dt.weekday())).strftime("%Y-%m-%d")

def recompute_weekly(daily):
    weeks = OrderedDict()
    for d in daily:
        wk = week_label(d)
        if wk not in weeks:
            weeks[wk] = {"week": wk, "opt_rev": 0, "fut_rev": 0, "cash_rev": 0,
                         "total_rev": 0, "days": 0}
        for k in ["opt_rev","fut_rev","cash_rev","total_rev"]:
            weeks[wk][k] += float(d.get(k, 0) or 0)
        weeks[wk]["days"] += 1

    return [{k: round(v, 2) if isinstance(v, float) else v
             for k, v in w.items()} for w in weeks.values()]

def recompute_dow_avg(daily):
    recent = daily[-50:] if len(daily) > 50 else daily
    days = ["Monday","Tuesday","Wednesday","Thursday","Friday"]
    dow = {}
    for day_name in days:
        day_data = [d for d in recent if d["day"] == day_name]
        if day_data:
            n = len(day_data)
            dow[day_name] = {
                "avg_total": round(sum(float(d.get("total_rev",0) or 0) for d in day_data) / n, 4),
                "avg_options": round(sum(float(d.get("opt_rev",0) or 0) for d in day_data) / n, 4),
                "avg_futures": round(sum(float(d.get("fut_rev",0) or 0) for d in day_data) / n, 4),
                "avg_cash": round(sum(float(d.get("cash_rev",0) or 0) for d in day_data) / n, 4),
                "count": n,
            }
        else:
            dow[day_name] = {"avg_total": 0, "avg_options": 0, "avg_futures": 0, "avg_cash": 0, "count": 0}
    return dow

def compute_summary(daily, quarterly):
    last = daily[-1] if daily else {}
    cq = quarterly[-1] if quarterly else {}
    last5 = daily[-5:] if len(daily) >= 5 else daily
    prev5 = daily[-10:-5] if len(daily) >= 10 else []
    l5_total = sum(float(d.get("total_rev",0) or 0) for d in last5)
    p5_total = sum(float(d.get("total_rev",0) or 0) for d in prev5)
    wow = (l5_total - p5_total) / p5_total if p5_total else 0

    return {
        "current_quarter": cq.get("quarter", ""),
        "cq_total_rev": round(float(cq.get("total_rev", 0)), 2),
        "cq_options_rev": round(float(cq.get("opt_rev", 0)), 2),
        "cq_futures_rev": round(float(cq.get("fut_rev", 0)), 2),
        "cq_cash_rev": round(float(cq.get("cash_rev", 0)), 2),
        "cq_trading_days": cq.get("days", 0),
        "last5_total": round(l5_total, 2),
        "prev5_total": round(p5_total, 2),
        "wow_change": round(wow, 4),
        "last_date": last.get("date", ""),
    }


# ═══════════════════════════════════════════════════════════════
# SECTION 5: ENRICHED DATA (segment summaries, predictor)
# ═══════════════════════════════════════════════════════════════

def seg_summary(daily_data, rev_key):
    q = recompute_quarterly(daily_data)
    cq = q[-1] if q else None
    pq = q[-2] if len(q) > 1 else None
    yoy_q = None
    if cq:
        parts = cq["quarter"].split()
        target_label = f"{parts[0]} FY {int(parts[2]) - 1}"
        yoy_q = next((x for x in q if x["quarter"] == target_label), None)

    cq_avg = float(cq[rev_key]) / max(cq["days"], 1) if cq else 0
    pq_avg = float(pq[rev_key]) / max(pq["days"], 1) if pq else 0
    yoy_avg = float(yoy_q[rev_key]) / max(yoy_q["days"], 1) if yoy_q else 0

    quarterly_data = {
        "current":  {"label": cq["quarter"] if cq else "", "value": round(cq_avg, 4),
                     "qoq": round((cq_avg - pq_avg) / pq_avg, 4) if pq_avg else 0,
                     "yoy": round((cq_avg - yoy_avg) / yoy_avg, 4) if yoy_avg else 0},
        "previous": {"label": pq["quarter"] if pq else "", "value": round(pq_avg, 4)},
        "prev2":    {"label": yoy_q["quarter"] if yoy_q else "", "value": round(yoy_avg, 4)},
    }

    m = recompute_monthly(daily_data)
    cm = m[-1] if m else None
    pm = m[-2] if len(m) > 1 else None
    cm_avg = float(cm[rev_key]) / max(cm["days"], 1) if cm else 0
    pm_avg = float(pm[rev_key]) / max(pm["days"], 1) if pm else 0
    # 125 trading days (~6 months at ~21 trading days/month) of actual daily
    # rows, not an average of 6 calendar-month buckets -- avoids over/under-
    # weighting a short month (e.g. one with a cluster of holidays) the same
    # as a full one.
    last125 = daily_data[-125:] if len(daily_data) >= 125 else daily_data
    avg_6m = sum(float(x[rev_key]) for x in last125) / max(len(last125), 1)

    monthly_data = {
        "current":  {"label": cm["month"] if cm else "", "value": round(cm_avg, 4),
                     "mom": round((cm_avg - pm_avg) / pm_avg, 4) if pm_avg else 0,
                     "mo6m": round((cm_avg - avg_6m) / avg_6m, 4) if avg_6m else 0},
        "previous": {"label": pm["month"] if pm else "", "value": round(pm_avg, 4)},
        "avg_6m":   {"label": "Avg Of Last 6 Months", "value": round(avg_6m, 4)},
    }

    last5 = daily_data[-5:] if len(daily_data) >= 5 else daily_data
    prev5 = daily_data[-10:-5] if len(daily_data) >= 10 else []
    last20 = daily_data[-20:] if len(daily_data) >= 20 else daily_data
    last45 = daily_data[-45:] if len(daily_data) >= 45 else daily_data
    l5_avg = sum(float(d[rev_key]) for d in last5) / max(len(last5), 1)
    p5_avg = sum(float(d[rev_key]) for d in prev5) / max(len(prev5), 1) if prev5 else 0
    l20_avg = sum(float(d[rev_key]) for d in last20) / max(len(last20), 1)
    l45_avg = sum(float(d[rev_key]) for d in last45) / max(len(last45), 1)

    weekly_data = {
        "last5":  {"label": "Last 5 Trading Days", "value": round(l5_avg, 4),
                   "wow": round((l5_avg - p5_avg) / p5_avg, 4) if p5_avg else 0,
                   "wo10w": round((l5_avg - l45_avg) / l45_avg, 4) if l45_avg else 0},
        "prev5":  {"label": "Previous 5 Trading Days", "value": round(p5_avg, 4)},
        "last20": {"label": "Last 20 Trading Days", "value": round(l20_avg, 4)},
        "last45": {"label": "Last 45 Trading Days", "value": round(l45_avg, 4)},
    }

    pq_label = pq["quarter"] if pq else None
    cq_label = cq["quarter"] if cq else None
    yoy_label = yoy_q["quarter"] if yoy_q else None

    days_list = ["Monday","Tuesday","Wednesday","Thursday","Friday"]
    dow = {}
    prev_week = {}
    for day_name in days_list:
        recs = [d for d in daily_data if d["day"] == day_name]
        latest = float(recs[-1][rev_key]) if recs else 0
        last3 = recs[-3:] if len(recs) >= 3 else recs
        last10 = recs[-10:] if len(recs) >= 10 else recs
        avg3 = sum(float(d[rev_key]) for d in last3) / max(len(last3), 1)
        avg10 = sum(float(d[rev_key]) for d in last10) / max(len(last10), 1)

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
            "do3d": round((latest - avg3) / avg3, 4) if avg3 else 0,
            "do10d": round((latest - avg10) / avg10, 4) if avg10 else 0,
            "avg_3d": round(avg3, 4), "avg_10d": round(avg10, 4),
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
            fy_groups[f] = {"sum": 0, "count": 0}
        fy_groups[f]["sum"] += float(d.get(rev_key, 0) or 0)
        fy_groups[f]["count"] += 1
    fy_list = list(fy_groups.values())
    curr_fy_avg = fy_list[-1]["sum"] / max(fy_list[-1]["count"], 1) if fy_list else 0
    prev_fy_avg = fy_list[-2]["sum"] / max(fy_list[-2]["count"], 1) if len(fy_list) > 1 else 0
    fy_yoy = (curr_fy_avg - prev_fy_avg) / prev_fy_avg if prev_fy_avg else 0

    return {
        "quarterly": quarterly_data,
        "monthly": monthly_data,
        "weekly": weekly_data,
        "day_of_week": dow,
        "previous_week": prev_week,
        "fy": {"current": round(curr_fy_avg, 4), "previous": round(prev_fy_avg, 4), "yoy": round(fy_yoy, 4)},
    }

def _next_quarter(quarter_name):
    """Return the quarter immediately following quarter_name.
    e.g. 'Q4 FY 2026' -> 'Q1 FY 2027', 'Q2 FY 2026' -> 'Q3 FY 2026'
    """
    parts = quarter_name.split()          # ["Q4", "FY", "2026"]
    q_num   = int(parts[0][1])
    fy_year = int(parts[2])
    if q_num == 4:
        return f"Q1 FY {fy_year + 1}"
    return f"Q{q_num + 1} FY {fy_year}"


# ── NSE P&L definitions ──
# Checked against every actual nse_pnl quarter: total_revenue is exactly the sum
# of the operating and non-operating revenue lines below, and total_expense is
# exactly the sum of all expense lines INCLUDING depreciation and
# sebi_settlement. The stored `ebitda` column is total_revenue − total_expense:
# after depreciation and including non-operating income, so it is not EBITDA.
# pbt = that + share_profit_associates + profit_sale_investment +
# discontinued_operations (Q3 FY 2026 is ₹126 Cr below that sum: an item no
# column captures; it is reported below as unreconciled_pbt_gap).
PNL_OPERATING_REVENUE = (
    "transaction_rev", "listing_income", "data_centre", "data_feed",
    "index_licensing", "clearing_settlement", "operating_investment", "other_operating",
)
PNL_NON_OPERATING_INCOME = ("investment_income", "other_non_operating")
# Non-recurring items inside total_expense: shown on the reported basis for
# actual quarters (and footnoted), left out of the forecast ratios.
PNL_ONE_OFF_EXPENSES = ("sebi_settlement",)
# Non-recurring items between EBITDA and PBT; forecasts never include them.
PNL_EXCEPTIONAL_ITEMS = ("profit_sale_investment", "discontinued_operations")
# A base quarter whose one-offs exceed this share of PBT is skipped for the tax
# rate: nse_pnl does not report the tax effect of a one-off (Q2 FY 2026, with the
# ₹1,297 Cr settlement and a ₹1,201 Cr investment gain, shows a 31 % rate).
ONE_OFF_TAX_MATERIALITY = 0.10
EBITDA_DEFINITION = ("Operating EBITDA = revenue from operations − operating expenses, "
                     "before depreciation, excluding other (non-operating) income.")


def _pnl_num(row, key):
    v = row.get(key)
    return float(v) if v is not None else 0.0


def _pnl_has_revenue_split(row):
    """Manual forecast rows leave the non-operating lines empty and put all
    non-transaction revenue in operating_investment, so operating revenue
    cannot be separated from other income there."""
    return all(row.get(k) is not None for k in PNL_NON_OPERATING_INCOME)


def pnl_operating_view(row):
    """Operating EBITDA for one nse_pnl row, on the reported basis (any one-off
    in that quarter included), with the one-offs listed for footnotes."""
    dep = _pnl_num(row, "depreciation")
    op_exp = _pnl_num(row, "total_expense") - dep
    one_offs = {k: round(_pnl_num(row, k), 2) for k in PNL_ONE_OFF_EXPENSES if _pnl_num(row, k)}
    reported_pre_items = _pnl_num(row, "total_revenue") - _pnl_num(row, "total_expense")
    exceptional = {k: round(_pnl_num(row, k), 2) for k in PNL_EXCEPTIONAL_ITEMS if _pnl_num(row, k)}
    gap = _pnl_num(row, "pbt") - (reported_pre_items + _pnl_num(row, "share_profit_associates")
                                  + sum(_pnl_num(row, k) for k in PNL_EXCEPTIONAL_ITEMS))
    if row.get("pbt") is not None and abs(gap) >= 0.5:
        exceptional["unreconciled_pbt_gap"] = round(gap, 2)
    view = {
        "quarter": row.get("quarter"),
        "is_predicted": bool(row.get("is_predicted")),
        "revenue_split_available": _pnl_has_revenue_split(row),
        "operating_revenue": None,
        "non_operating_income": None,
        "operating_expenses": round(op_exp, 2),
        "depreciation": round(dep, 2),
        "operating_ebitda": None,
        "operating_ebitda_margin": None,
        "one_offs": one_offs,
        "operating_ebitda_ex_one_offs": None,
        "operating_ebitda_margin_ex_one_offs": None,
        "exceptional_items": exceptional,
    }
    if view["revenue_split_available"]:
        op_rev = sum(_pnl_num(row, k) for k in PNL_OPERATING_REVENUE)
        ebitda = op_rev - op_exp
        ebitda_ex = ebitda + sum(one_offs.values())
        view.update({
            "operating_revenue": round(op_rev, 2),
            "non_operating_income": round(sum(_pnl_num(row, k) for k in PNL_NON_OPERATING_INCOME), 2),
            "operating_ebitda": round(ebitda, 2),
            "operating_ebitda_margin": round(ebitda / op_rev, 4) if op_rev else None,
            "operating_ebitda_ex_one_offs": round(ebitda_ex, 2),
            "operating_ebitda_margin_ex_one_offs": round(ebitda_ex / op_rev, 4) if op_rev else None,
        })
    return view


def nse_ratio_model(pnl_history):
    """Assumptions of the default NSE forecast (the "ratio model"): ratios from
    the last two actual nse_pnl quarters, with one-off items removed.

    Revenue lines are ratios to transaction revenue, costs ratios to operating
    revenue; associates' share is the average ₹ Cr amount; the tax rate skips a
    base quarter whose one-offs are material (falls back to both if all are)."""
    base = [r for r in (pnl_history or [])
            if not r.get("is_predicted") and _pnl_has_revenue_split(r)
            and _pnl_num(r, "transaction_rev") > 0][-2:]
    if not base:
        return None

    def mean(vals):
        vals = [v for v in vals if v is not None]
        return sum(vals) / len(vals) if vals else None

    per_q = []
    for r in base:
        v = pnl_operating_view(r)
        txn, op_rev, pbt, pat = (_pnl_num(r, "transaction_rev"), v["operating_revenue"],
                                 _pnl_num(r, "pbt"), _pnl_num(r, "pat"))
        one_off = sum(v["one_offs"].values())
        items = abs(one_off) + sum(abs(x) for x in v["exceptional_items"].values())
        per_q.append({
            "quarter": r.get("quarter"),
            "one_offs": v["one_offs"],
            "other_operating_revenue_ratio": (op_rev - txn) / txn,
            "non_operating_income_ratio": v["non_operating_income"] / txn,
            "operating_expense_ratio": (v["operating_expenses"] - one_off) / op_rev if op_rev else None,
            "depreciation_ratio": v["depreciation"] / op_rev if op_rev else None,
            "share_profit_associates": _pnl_num(r, "share_profit_associates"),
            "tax_rate": _pnl_num(r, "income_tax") / pbt if pbt > 0 else None,
            "material_one_offs": pbt <= 0 or items > ONE_OFF_TAX_MATERIALITY * pbt,
            "eps_per_pat": _pnl_num(r, "eps") / pat if pat else None,
        })

    tax_q = [q for q in per_q if not q["material_one_offs"] and q["tax_rate"] is not None] \
        or [q for q in per_q if q["tax_rate"] is not None]
    model = {k: mean(q[k] for q in per_q) for k in (
        "other_operating_revenue_ratio", "non_operating_income_ratio", "operating_expense_ratio",
        "depreciation_ratio", "share_profit_associates", "eps_per_pat")}
    model["tax_rate"] = mean(q["tax_rate"] for q in tax_q)
    if any(v is None for v in model.values()):
        return None
    return {
        "name": "ratio",
        "label": "Default forecast — ratio model",
        "ebitda_definition": EBITDA_DEFINITION,
        "base_quarters": [q["quarter"] for q in per_q],
        "one_offs_excluded": {q["quarter"]: q["one_offs"] for q in per_q if q["one_offs"]},
        "tax_rate_quarters": [q["quarter"] for q in tax_q],
        **model,
    }


def compute_predicted_quarters(pnl_predictor, pnl_history, quarterly):
    """Build the pnl_predicted_quarters dict: the default NSE forecast (ratio
    model, see nse_ratio_model) for

      - the current quarter (label "CURRENT" in the dashboard), from the
        transaction revenue extrapolated by pnl_predictor
      - the next quarter, that transaction revenue grown at the current
        quarter's YoY per-day rate

    EBITDA is operating EBITDA (EBITDA_DEFINITION); forecasts carry no one-offs.
    """
    if not pnl_predictor or not pnl_history:
        return {}
    m = nse_ratio_model(pnl_history)
    if not m:
        return {}

    def build_entry(txn_rev):
        op_rev  = txn_rev * (1 + m["other_operating_revenue_ratio"])
        non_op  = txn_rev * m["non_operating_income_ratio"]
        total   = op_rev + non_op
        op_exp  = op_rev * m["operating_expense_ratio"]
        ebitda  = op_rev - op_exp
        dep     = op_rev * m["depreciation_ratio"]
        pbt     = ebitda - dep + non_op + m["share_profit_associates"]
        tax     = pbt * m["tax_rate"]
        pat     = pbt - tax
        margin  = round(ebitda / op_rev, 4) if op_rev else 0
        return {
            "transaction_rev":         round(txn_rev, 2),
            "operating_revenue":       round(op_rev, 2),
            "non_operating_income":    round(non_op, 2),
            "total_revenue":           round(total, 2),
            "operating_expenses":      round(op_exp, 2),
            "depreciation":            round(dep, 2),
            "total_expense":           round(op_exp + dep, 2),
            "operating_ebitda":        round(ebitda, 2),
            "operating_ebitda_margin": margin,
            # Legacy keys, same operating definition.
            "ebitda":                  round(ebitda, 2),
            "ebitda_margin":           margin,
            "share_profit_associates": round(m["share_profit_associates"], 2),
            "pbt":                     round(pbt, 2),
            "income_tax":              round(tax, 2),
            "pat":                     round(pat, 2),
            "pat_margin":              round(pat / total, 4) if total else 0,
            "eps":                     round(pat * m["eps_per_pat"], 2),
            "one_offs":                {},
        }

    result = {}

    # Current quarter: from live trading data via pnl_predictor. Named from the
    # data (latest quarter with trading days), not the wall clock.
    cq_name = quarterly[-1]["quarter"] if quarterly else date_to_fy_quarter(datetime.now())
    result[cq_name] = build_entry(pnl_predictor["transaction_rev_extrapolated"])

    # Next quarter: YoY-growth projection
    nq_name = _next_quarter(cq_name)
    if len(quarterly) >= 5:
        same_q_prev = f"{cq_name.split()[0]} FY {int(cq_name.split()[2]) - 1}"
        prev_q = next((q for q in quarterly if q["quarter"] == same_q_prev), None)
        curr_q = quarterly[-1]

        def daily_avg(q):
            days = int(q.get("days") or 0)
            return float(q.get("total_rev") or 0) / days if days else 0.0

        # Compare per-day averages: the current quarter is only partly through,
        # so its running total against a full year-ago quarter is meaningless.
        if prev_q and daily_avg(prev_q) and daily_avg(curr_q):
            yoy_growth = daily_avg(curr_q) / daily_avg(prev_q) - 1
        else:
            yoy_growth = 0.10
    else:
        yoy_growth = 0.10

    result[nq_name] = build_entry(pnl_predictor["transaction_rev_extrapolated"] * (1 + yoy_growth))

    return result


def compute_enriched(daily, quarterly, pnl):
    enriched = {
        "summary_total": seg_summary(daily, "total_rev"),
        "seg_options":   seg_summary(daily, "opt_rev"),
        "seg_futures":   seg_summary(daily, "fut_rev"),
        "seg_cash":      seg_summary(daily, "cash_rev"),
    }

    model = nse_ratio_model(pnl)
    cq = quarterly[-1] if quarterly else None
    if cq and pnl:
        days_so_far = cq["days"]
        expected_days = 62
        daily_avg = float(cq["total_rev"]) / max(days_so_far, 1)
        # All non-transaction revenue (other operating revenue + non-operating
        # income) per ₹ of transaction revenue, from the ratio model.
        other_income_ratio = 0.4714
        if model:
            other_income_ratio = model["other_operating_revenue_ratio"] + model["non_operating_income_ratio"]
        txn_rev_extrap = round(daily_avg * expected_days, 2)
        total_rev_pred = txn_rev_extrap * (1 + other_income_ratio)
        enriched["pnl_predictor"] = {
            "quarter": cq["quarter"],
            "daily_avg_rev": round(daily_avg, 4),
            "trading_days_so_far": days_so_far,
            "expected_trading_days": expected_days,
            "transaction_rev_extrapolated": txn_rev_extrap,
            "other_income_ratio": round(other_income_ratio, 4),
            "total_revenue_predicted": round(total_rev_pred, 2),
        }
    else:
        enriched["pnl_predictor"] = {}

    enriched["pnl_predicted_quarters"] = compute_predicted_quarters(
        enriched.get("pnl_predictor"), pnl, quarterly
    )
    # One PAT/EPS figure: the current quarter's row of the default forecast.
    cq_pred = enriched["pnl_predicted_quarters"].get(cq["quarter"]) if cq else None
    if cq_pred:
        enriched["pnl_predictor"]["pat_predicted"] = cq_pred["pat"]
        enriched["pnl_predictor"]["eps_predicted"] = cq_pred["eps"]
    enriched["pnl_forecast_model"] = {
        k: (round(v, 6) if isinstance(v, float) else v) for k, v in model.items()
    } if model else {}
    # Operating EBITDA for every nse_pnl row (actuals on the reported basis, with
    # one-offs listed; manual forecast rows have no revenue split -> None).
    enriched["pnl_operating"] = [pnl_operating_view(r) for r in (pnl or [])]
    return enriched


# ═══════════════════════════════════════════════════════════════
# SECTION 6: BUILD dashboard_data.json (for static Vercel deploy)
# ═══════════════════════════════════════════════════════════════

def build_dashboard_json(daily_all, quarterly, monthly, weekly, dow_avg, summary,
                         pnl, pnl_fy, cost_ratios, take_rates, vix_data):
    """Build the exact same structure as the current dashboard_data.json."""
    # daily = last 120 records (for charts), daily_all = everything
    daily_recent = daily_all[-120:] if len(daily_all) > 120 else daily_all

    return {
        "daily": daily_recent,
        "daily_all": daily_all,
        "monthly": monthly,
        "quarterly": quarterly,
        "weekly": weekly[-15:] if len(weekly) > 15 else weekly,
        "dow_avg": dow_avg,
        "pnl": pnl,
        "pnl_fy": pnl_fy,
        "cost_ratios": cost_ratios,
        "take_rates": take_rates,
        "vix": vix_data,
        "summary": summary,
    }


def build_outputs(all_daily, pnl, pnl_fy, cost_ratios):
    """Every aggregate and both JSON documents from the daily rows. Pure: the
    same code path builds the at-today's-rates and the date-effective files."""
    quarterly = recompute_quarterly(all_daily)
    monthly   = recompute_monthly(all_daily)
    weekly    = recompute_weekly(all_daily)
    dow_avg   = recompute_dow_avg(all_daily)
    summary_obj = compute_summary(all_daily, quarterly)

    # VIX data (from daily records)
    vix_data = [{"date": d["date"], "price": float(d.get("vix", 0) or 0)}
                for d in all_daily[-120:] if float(d.get("vix", 0) or 0) > 0]

    take_rates = {"futures": TR_FUT, "options": TR_OPT, "cash": TR_CASH}

    enriched = compute_enriched(all_daily, quarterly, pnl)

    dashboard_json = build_dashboard_json(
        all_daily, quarterly, monthly, weekly, dow_avg, summary_obj,
        pnl, pnl_fy, cost_ratios, take_rates, vix_data
    )
    return {"quarterly": quarterly, "monthly": monthly, "weekly": weekly,
            "dow_avg": dow_avg, "summary": summary_obj, "enriched": enriched,
            "dashboard": dashboard_json}


# Forward-looking enriched blocks. Future quarters are priced at today's fees
# in both variants, so they must grow from activity measured at today's rates:
# growth measured on date-effective history would include one-off fee changes
# (e.g. the March 2026 increase) and inflate the forecast.
FORECAST_KEYS = ("pnl_predictor", "pnl_predicted_quarters", "pnl_forecast_model")


def build_date_effective_outputs(all_daily, pnl, pnl_fy, cost_ratios, forecast_from=None):
    """build_outputs on rows re-priced at the fee rules in force on each date.
    Adds fee_basis to every daily row and aggregate period, and fee_mode /
    fee_rules at the top of both documents. take_rates stays today's rates.
    forecast_from: the at-today's-rates enriched document; its FORECAST_KEYS
    replace the date-effective ones so both variants show the same forecast."""
    eff_daily = reprice_date_effective(all_daily)
    out = build_outputs(eff_daily, pnl, pnl_fy, cost_ratios)
    if forecast_from is not None:
        for k in FORECAST_KEYS:
            if k in forecast_from:
                out["enriched"][k] = forecast_from[k]
    fee_register.annotate_periods(out["quarterly"], "quarter", eff_daily, lambda d: d["fy_quarter"])
    fee_register.annotate_periods(out["monthly"], "month", eff_daily, lambda d: d["fy_month"])
    fee_register.annotate_periods(out["weekly"], "week", eff_daily, week_label)
    meta = {
        "fee_mode": "date_effective",
        "fee_rules": fee_register.rules_for(
            "NSE", eff_daily[0]["date"] if eff_daily else None,
            eff_daily[-1]["date"] if eff_daily else None),
    }
    out["dashboard"].update(meta)
    out["enriched"].update(meta)
    return out


# ═══════════════════════════════════════════════════════════════
# SECTION 7: WRITE DASHBOARD DATA FILES
# (Unified dashboard uses fetch() from dashboard/data/*.json)
# ═══════════════════════════════════════════════════════════════

def write_dashboard_data(dashboard_data, enriched_data, suffix="", out_dir=None):
    """Write NSE data files to dashboard/data/ for Vercel serving.
    suffix "_eff" writes the date-effective variant."""
    dash_data_dir = Path(out_dir) if out_dir else DASHBOARD_DIR / "data"
    dash_data_dir.mkdir(parents=True, exist_ok=True)

    nse_dash_path = dash_data_dir / f"nse_dashboard_data{suffix}.json"
    nse_enrich_path = dash_data_dir / f"nse_enriched_data{suffix}.json"

    with open(nse_dash_path, "w") as f:
        json.dump(dashboard_data, f, separators=(',', ':'))
    with open(nse_enrich_path, "w") as f:
        json.dump(enriched_data, f, separators=(',', ':'))

    print(f"Wrote {nse_dash_path}")
    print(f"Wrote {nse_enrich_path}")
    return True


# ═══════════════════════════════════════════════════════════════
# SECTION 8: MAIN PIPELINE
# ═══════════════════════════════════════════════════════════════

def main():
    print("=" * 60)
    print("NSE Cloud Pipeline — Daily Update")
    print(f"Run time: {datetime.utcnow().isoformat()}Z")
    print("=" * 60)

    # Step 1: Fetch from NSE
    fo_json, cm_json = fetch_nse_data()

    fo_records = fo_json.get("data", [])
    cm_records = cm_json.get("data", [])

    if not fo_records:
        print("No F&O data returned from NSE. Exiting.")
        return

    # Step 2: Parse records
    cm_by_date = {}
    for rec in cm_records:
        parsed = parse_cm_record(rec)
        cm_by_date[parsed["date"]] = parsed

    new_parsed = []
    for rec in fo_records:
        parsed = parse_fo_record(rec)
        date_key = parsed["date"]
        cm = cm_by_date.get(date_key)
        if not cm:
            # Storing the day with cash = 0 would freeze it: existing dates are
            # never re-fetched. Hold it back until NSE publishes the cash figure.
            print(f"WARNING: {date_key} has F&O but no cash data yet — holding back until it is published")
            continue
        parsed["cash_traded_value"] = cm.get("cash_traded_value", 0)
        parsed["cash_rev"] = cm.get("cash_rev", 0)
        parsed["total_rev"] = round(parsed["fo_rev"] + parsed["cash_rev"], 4)
        del parsed["_dt"]
        new_parsed.append(parsed)

    print(f"Parsed {len(new_parsed)} records from NSE")

    # Step 3: Supabase operations
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("WARNING: Supabase credentials not set. Writing local files only.")
        supabase = None
    else:
        supabase = get_supabase_client()
        existing_dates = get_existing_dates(supabase)
        to_insert = [r for r in new_parsed if r["date"] not in existing_dates]
        print(f"Existing dates in DB: {len(existing_dates)}, New records to insert: {len(to_insert)}")

        if to_insert:
            upsert_daily_records(supabase, to_insert)
            print(f"Upserted {len(to_insert)} new daily records to Supabase")
        else:
            print("No new records to insert into Supabase")

    # Step 4: Fetch full dataset and recompute
    if supabase:
        all_daily = fetch_all_daily(supabase)
        pnl = fetch_pnl(supabase)
        pnl_fy = fetch_pnl_fy(supabase)
        cost_ratios = fetch_cost_ratios(supabase)
    else:
        # Fallback: read from existing data file
        existing_path = DATA_DIR / "dashboard_data.json"
        if existing_path.exists():
            with open(existing_path) as f:
                existing = json.load(f)
            all_daily = existing.get("daily_all", [])
            pnl = sorted(existing.get("pnl", []), key=lambda r: quarter_sort_key(r.get("quarter")))
            pnl_fy = existing.get("pnl_fy", [])
            cost_ratios = existing.get("cost_ratios", {})
            # Merge new records
            existing_dates_local = {d["date"] for d in all_daily}
            new_local = [r for r in new_parsed if r["date"] not in existing_dates_local]
            all_daily = sorted(all_daily + new_local, key=lambda x: x["date"])
        else:
            all_daily = sorted(new_parsed, key=lambda x: x["date"])
            pnl, pnl_fy, cost_ratios = [], [], {}

    print(f"Total daily records: {len(all_daily)}")

    # Apply VIX to any records that are missing it (vix == 0)
    missing_vix = [d for d in all_daily if not float(d.get("vix", 0) or 0)]
    if missing_vix:
        vix_start = missing_vix[0]["date"]
        vix_end   = missing_vix[-1]["date"]
        print(f"Fetching VIX for {len(missing_vix)} records missing it ({vix_start} to {vix_end})")
        vix_map = fetch_indiavix_map(vix_start, vix_end)
        if vix_map:
            for rec in all_daily:
                if not float(rec.get("vix", 0) or 0):
                    rec["vix"] = vix_map.get(rec["date"], 0)
            filled = sum(1 for r in all_daily if float(r.get("vix", 0) or 0) > 0)
            print(f"VIX applied: {filled}/{len(all_daily)} records now have VIX data")
    else:
        print("All records already have VIX data")

    # Steps 5-6: Recompute aggregates and enriched data (at today's rates)
    out = build_outputs(all_daily, pnl, pnl_fy, cost_ratios)
    quarterly, monthly, weekly = out["quarterly"], out["monthly"], out["weekly"]
    dow_avg, summary_obj, enriched = out["dow_avg"], out["summary"], out["enriched"]

    # Step 7: Save aggregates to Supabase
    if supabase:
        save_aggregates(supabase, "quarterly", quarterly)
        save_aggregates(supabase, "monthly", monthly)
        save_aggregates(supabase, "weekly", weekly)
        save_aggregates(supabase, "dow_avg", dow_avg)
        save_aggregates(supabase, "summary", summary_obj)
        save_aggregates(supabase, "enriched", enriched)
        new_count = len(to_insert) if 'to_insert' in dir() else 0
        log_pipeline_run(supabase, new_count, summary_obj.get("last_date", ""),
                         details=f"Total records: {len(all_daily)}")
        print("Saved aggregates to Supabase")

    # Step 8: Write local JSON files (for git commit → Vercel deploy)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    dashboard_json = out["dashboard"]

    with open(DATA_DIR / "dashboard_data.json", "w") as f:
        json.dump(dashboard_json, f, separators=(',', ':'))
    with open(DATA_DIR / "enriched_data.json", "w") as f:
        json.dump(enriched, f, separators=(',', ':'))

    print(f"Wrote {DATA_DIR / 'dashboard_data.json'}")
    print(f"Wrote {DATA_DIR / 'enriched_data.json'}")

    # Step 9: Write data files to dashboard/data/ (for unified dashboard fetch())
    write_dashboard_data(dashboard_json, enriched)

    # Step 10: Date-effective variant (each day at the fee rules then in force).
    # JSON only; Supabase keeps the at-today's-rates rows and aggregates.
    eff = build_date_effective_outputs(all_daily, pnl, pnl_fy, cost_ratios, forecast_from=enriched)
    write_dashboard_data(eff["dashboard"], eff["enriched"], suffix="_eff")

    # Summary
    print("\n" + "=" * 60)
    print(f"Pipeline complete.")
    print(f"  Latest date: {summary_obj.get('last_date', 'N/A')}")
    print(f"  Total daily records: {len(all_daily)}")
    print(f"  Current quarter: {summary_obj.get('current_quarter', 'N/A')}")
    new_count_final = len(to_insert) if supabase and 'to_insert' in dir() else len(new_parsed)
    print(f"  New days this run: {new_count_final}")
    print("=" * 60)

    # Return count for GitHub Actions to decide if commit is needed
    return new_count_final


if __name__ == "__main__":
    count = main()
    # Write count to a file so GitHub Actions can read it
    count_file = PROJECT_ROOT / ".new_days_count"
    count_file.write_text(str(count or 0))
