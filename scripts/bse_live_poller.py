"""
BSE Live Market Poller — GitHub Actions script
Fetches live segment turnover from BSE APIs, computes exchange revenue,
writes dashboard/data/bse_live.json and bse_live_hourly.json.

Primary endpoints (no auth needed, just Referer header):
  MTurnover/w         → segment-wise turnover (Equity, Derivatives, Debt…)
  GetSensexData/w     → live Sensex price/change
  MarketStat2/w       → equity breadth + market cap

Also fetches BSE Ltd's own stock price (ticker BSE.NS) via yfinance
fast_info — an intraday quote (~15 min delayed, not tick-real-time),
so the dashboard shows something better than yesterday's fixed close.

Revenue take rates (both-side transaction charge):
  Cash (Equity)  : 0.00375% × 2  on traded value
  Options        : 0.03250% × 2  on premium turnover  (BSE derivatives ≈ all options)
  Futures        : none          (see scripts/take_rates.py)

Run: python scripts/bse_live_poller.py
Env: SUPABASE_URL, SUPABASE_KEY  (optional)
"""

import json
import os
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

import sys
from curl_cffi import requests as cffi_requests
sys.path.insert(0, str(Path(__file__).parent))
from live_common import save_hourly_snapshot, in_market_session

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SCRIPT_DIR   = Path(__file__).parent
REPO_ROOT    = SCRIPT_DIR.parent
OUTPUT_FILE  = REPO_ROOT / "dashboard" / "data" / "bse_live.json"
HOURLY_FILE  = REPO_ROOT / "dashboard" / "data" / "bse_live_hourly.json"
HISTORY_FILE = REPO_ROOT / "dashboard" / "data" / "bse_hourly_history.json"

# ---------------------------------------------------------------------------
# Take rates (both sides)
# ---------------------------------------------------------------------------
# Single source: scripts/take_rates.py
from take_rates import BSE_TR_CASH as TR_CASH, BSE_TR_OPT as TR_OPT, BSE_TR_FUT as TR_FUT

# ---------------------------------------------------------------------------
# IST + market session
# ---------------------------------------------------------------------------
IST              = timezone(timedelta(hours=5, minutes=30))
MARKET_OPEN_MIN  = 9 * 60 + 15   # 9:15 AM
# SEBI's Closing Auction Session (effective 2026-08-03) moved the cash segment's
# effective close to 4:00 PM — see the matching comment in live_common.py.
MARKET_TOTAL_MIN = 405            # → 4:00 PM

# ---------------------------------------------------------------------------
# BSE endpoints
# ---------------------------------------------------------------------------
BASE      = "https://api.bseindia.com/BseIndiaAPI/api"
BASE_RT   = "https://api.bseindia.com/RealTimeBseIndiaAPI/api"

TURNOVER_URL = f"{BASE}/MTurnover/w"
SENSEX_URL   = f"{BASE_RT}/GetSensexData/w"
STAT_URL     = f"{BASE}/MarketStat2/w"

HEADERS = {
    "User-Agent":  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/124.0.0.0 Safari/537.36",
    "Referer":     "https://www.bseindia.com/",
    "Accept":      "application/json, text/plain, */*",
    "Origin":      "https://www.bseindia.com",
}

SESSION = cffi_requests.Session()
SESSION.headers.update(HEADERS)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _parse(val):
    """Parse a comma-formatted Indian number string to float. Returns 0.0 on '-' or empty."""
    if not val or val.strip() in ("-", ""):
        return 0.0
    try:
        return float(str(val).replace(",", ""))
    except ValueError:
        return 0.0


def _get(url):
    try:
        r = SESSION.get(url, timeout=15, impersonate="chrome")
        print(f"  {url.split('/')[-1]}: {r.status_code} {len(r.text)} bytes")
        if r.status_code == 200 and r.text.strip():
            return r.json()
    except Exception as e:
        print(f"  ERROR {url}: {e}")
    return None


# ---------------------------------------------------------------------------
# Fetch + parse segment turnover
# ---------------------------------------------------------------------------
def fetch_turnover():
    data = _get(TURNOVER_URL)
    if not data:
        return None

    rows = data.get("Data", [])

    def find(name):
        return next((r for r in rows if r.get("HeaderName", "").lower() == name.lower()), {})

    eq   = find("Equity")
    deriv = find("Derivatives")
    total = find("Total")

    eq_turnover     = _parse(eq.get("Turnover"))
    deriv_notional  = _parse(deriv.get("Turnover"))
    deriv_premium   = _parse(deriv.get("PermiumTurnover"))

    # BSE returns the literal "-" when a field hasn't posted for the session yet
    # (distinct from a genuine 0, which comes through as "0"/"0.00"). Track that
    # separately so callers don't treat a cash-only total as a complete one.
    def _is_pending(raw):
        return raw is None or str(raw).strip() in ("", "-")
    options_pending = _is_pending(deriv.get("PermiumTurnover")) and not _is_pending(eq.get("Turnover"))

    # Revenue — BSE derivatives are overwhelmingly Sensex options.
    # Derivatives.Turnover is the full notional (futures + options notional),
    # so we cannot separate futures notional cleanly. Since BSE futures volume
    # is negligible, we compute revenue on options premium only.
    cash_rev    = eq_turnover   * TR_CASH
    opt_rev     = deriv_premium * TR_OPT
    fut_rev     = 0.0   # BSE futures volume is negligible; notional not split in API
    total_rev   = cash_rev + opt_rev

    has_data = bool(eq_turnover or deriv_premium)

    ason = eq.get("Ason") or deriv.get("Ason") or ""
    trade_date = ason[:8].strip() if ason else ""   # "13/04/26"

    if has_data:
        print(
            f"  Equity ₹{eq_turnover:.0f} Cr | "
            f"Deriv notional ₹{deriv_notional:.0f} Cr | "
            f"Premium ₹{deriv_premium:.0f} Cr"
        )
        print(
            f"  Revenue → Cash ₹{cash_rev:.4f} Cr | "
            f"Opt ₹{opt_rev:.4f} Cr | "
            f"Fut ₹{fut_rev:.4f} Cr | "
            f"Total ₹{total_rev:.4f} Cr"
        )
        if options_pending:
            print("  NOTE: options premium not yet posted by BSE — total above is cash-only")
    else:
        print("  Turnover: no data")

    return {
        "trade_date":              trade_date,
        "equity_turnover":         round(eq_turnover,    2),
        "derivatives_notional":    round(deriv_notional, 2),
        "options_premium":         round(deriv_premium,  2),
        "cash_revenue":            round(cash_rev,  4),
        "options_revenue":         round(opt_rev,   4),
        "futures_revenue":         round(fut_rev,   4),
        "total_revenue":           round(total_rev, 4),
        "has_data":                has_data,
        "options_pending":         options_pending,
        "source":                  "live",
    }


# ---------------------------------------------------------------------------
# Fetch Sensex quote
# ---------------------------------------------------------------------------
def fetch_sensex():
    data = _get(SENSEX_URL)
    if not data or not isinstance(data, list):
        return None
    s = data[0]
    return {
        "last":           _parse(s.get("ltp")),
        "change":         _parse(s.get("chg")),
        "pct_change":     _parse(s.get("perchg")),
        "prev_close":     _parse(s.get("Prev_Close")),
        "open":           _parse(s.get("I_open")),
        "high":           _parse(s.get("High")),
        "low":            _parse(s.get("Low")),
        "datetime":       s.get("dttm", ""),
        "status":         "Open" if s.get("F") == "0" else "Closed",
    }


# ---------------------------------------------------------------------------
# Fetch market stats
# ---------------------------------------------------------------------------
def fetch_market_stat():
    data = _get(STAT_URL)
    if not data:
        return None
    t = data.get("Table", [{}])[0]
    return {
        "market_cap_cr":    t.get("Mktcap"),
        "market_cap_usd_t": t.get("MktCap_USD"),
        "turnover_cr":      t.get("TurnoverCrs"),
        "listed_companies": t.get("ListedComp"),
        "advances":         t.get("ADV"),
        "declines":         t.get("Dec"),
        "unchanged":        t.get("Unch"),
    }


# ---------------------------------------------------------------------------
# Fetch BSE Ltd's own stock price (intraday quote, ~15 min delayed)
# ---------------------------------------------------------------------------
def fetch_stock_price(ticker="BSE.NS"):
    try:
        import yfinance as yf
        fi = yf.Ticker(ticker).fast_info
        last = fi.last_price
        prev_close = fi.previous_close
        if last is None:
            return None
        return {
            "last_price":    round(float(last), 2),
            "previous_close": round(float(prev_close), 2) if prev_close else None,
            "open":          round(float(fi.open), 2) if fi.open else None,
            "day_high":      round(float(fi.day_high), 2) if fi.day_high else None,
            "day_low":       round(float(fi.day_low), 2) if fi.day_low else None,
            "pct_change":    round((last - prev_close) / prev_close * 100, 2) if prev_close else None,
        }
    except Exception as e:
        print(f"  stock price fetch error: {e}")
        return None


# save_hourly_snapshot imported from live_common (handles archiving + prediction)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    now_utc = datetime.now(timezone.utc)
    now_ist = now_utc.astimezone(IST)
    ts_iso  = now_utc.strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{ts_iso}] BSE live poller starting…")

    if not in_market_session(now_ist) and os.environ.get("FORCE_POLL") != "1":
        print(f"Outside market session ({now_ist:%a %H:%M} IST) — nothing to do")
        return

    previous = {}
    if OUTPUT_FILE.exists():
        try:
            previous = json.loads(OUTPUT_FILE.read_text())
        except Exception:
            previous = {}

    print("Sensex:")
    sensex = fetch_sensex()
    if sensex:
        arrow = "▲" if sensex["pct_change"] >= 0 else "▼"
        print(f"  Sensex {sensex['last']:.2f}  {arrow}{abs(sensex['pct_change']):.2f}%  [{sensex['status']}]")

    print("Market stats:")
    stat = fetch_market_stat()

    print("Turnover:")
    revenue = fetch_turnover()

    # A failed fetch keeps the last good value (flagged stale) rather than
    # overwriting it with null.
    if not (revenue and revenue.get("has_data")) and previous.get("revenue"):
        revenue = {**previous["revenue"],
                   "stale_since": previous["revenue"].get("stale_since") or previous.get("updated_at")}
        print(f"  Turnover unavailable — keeping last good value (stale since {revenue['stale_since']})")

    print("Hourly snapshot:")
    if revenue and not revenue.get("stale_since"):
        save_hourly_snapshot(revenue, now_ist, HOURLY_FILE, HISTORY_FILE, exchange="bse")

    print("Stock price:")
    stock_price = fetch_stock_price("BSE.NS")
    if stock_price:
        print(f"  BSE.NS {stock_price['last_price']}  ({stock_price['pct_change']}%)")

    payload = {
        "updated_at":    ts_iso,
        "sensex":        sensex,
        "market_stat":   stat,
        "revenue":       revenue,
        "stock_price":   stock_price,
    }
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(json.dumps(payload, indent=2, default=str))
    size = OUTPUT_FILE.stat().st_size
    print(f"Wrote {OUTPUT_FILE} ({size} bytes)")


if __name__ == "__main__":
    main()
