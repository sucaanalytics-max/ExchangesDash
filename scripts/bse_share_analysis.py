"""
BSE Ltd Share Price Analysis
Merges historical seed CSV + daily pipeline JSON for revenue.
Fetches BSE.NS share prices from Excel seed (primary) and yfinance (extension).
Fits price ~ 45-day revenue MA (previous session) from REGRESSION_START on;
the method lives in share_regression.py.

Outputs: dashboard/data/bse_share_analysis.json

Run:  python scripts/bse_share_analysis.py
      (also invoked daily by GitHub Actions after bse_pipeline.py)
"""

import csv
import json
import warnings
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

import share_regression as sr

warnings.filterwarnings("ignore")

SCRIPT_DIR      = Path(__file__).parent
REPO_ROOT       = SCRIPT_DIR.parent
SEED_FILE       = REPO_ROOT / "dashboard" / "data" / "bse_revenue_seed.csv"
REVENUE_FILE    = REPO_ROOT / "dashboard" / "data" / "bse_dashboard_data.json"
OUTPUT_FILE     = REPO_ROOT / "dashboard" / "data" / "bse_share_analysis.json"

REGRESSION_START = "2025-03-01"
MA_WINDOWS       = [20, 30, 45, 50, 60, 90]
FIXED_MA         = 45


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_seed(path):
    """Returns {date_str: {revenue_cr, price}} from the committed CSV seed."""
    data = {}
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            d = row.get("date", "").strip()
            if not d:
                continue
            try:
                rev = float(row["revenue_cr"])
            except (KeyError, ValueError, TypeError):
                continue
            price = None
            try:
                price = float(row["price"]) if row.get("price") else None
            except (ValueError, TypeError):
                pass
            data[d] = {"revenue_cr": rev, "price": price}
    return data


def load_pipeline(path):
    """Returns {date_str: total_rev} from bse_dashboard_data.json."""
    with open(path) as f:
        raw = json.load(f)
    daily = raw.get("daily_all") or raw.get("daily", [])
    return {
        r["date"]: r["total_rev"]
        for r in daily
        if r.get("total_rev") is not None
    }


def fetch_yfinance_prices(start_date_str):
    """Returns {date_str: close_price} from yfinance BSE.NS.

    yfinance can return a NaN Close for the most recent day (e.g. fetched
    mid-session before the close posts) — drop those rather than let a
    single bad value poison the whole regression downstream.
    """
    import yfinance as yf
    hist = yf.Ticker("BSE.NS").history(start=start_date_str)
    return {
        str(d)[:10]: round(float(c), 2)
        for d, c in zip(hist.index, hist["Close"])
        if np.isfinite(c)
    }


# screener.in company page /company/BSE/ (BSE Ltd) — its public price-chart API
# needs no login. Used to fill days yfinance is missing (yfinance's BSE.NS daily
# history has skipped individual days before, e.g. when the job runs before
# Yahoo has posted that day's close) — same fallback already used for NSE.
SCREENER_COMPANY_ID = 1273635


def fetch_screener_prices(start_date_str):
    """Returns {date_str: close} from screener.in's public chart API ('Price on NSE')."""
    from curl_cffi import requests as cffi_requests
    url = (f"https://www.screener.in/api/company/{SCREENER_COMPANY_ID}/chart/"
           f"?q=Price&days=400&consolidated=true")
    r = cffi_requests.get(url, impersonate="chrome", timeout=20,
                          headers={"Referer": "https://www.screener.in/company/BSE/consolidated/"})
    r.raise_for_status()
    result = {}
    for ds in r.json().get("datasets", []):
        if ds.get("metric") != "Price":
            continue
        for d, v in ds.get("values", []):
            try:
                price = float(v)
            except (TypeError, ValueError):
                continue
            if np.isfinite(price) and d >= start_date_str:
                result[d] = round(price, 2)
    return result


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def collect_prices(seed):
    """{date: close}: seed CSV first, then yfinance after the seed's last price,
    with screener.in filling days yfinance lacks."""
    prices = {d: v["price"] for d, v in seed.items()
              if v.get("price") is not None and np.isfinite(v["price"])}
    if not prices:
        return prices
    next_day = (datetime.strptime(max(prices), "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
    try:
        yf_prices = fetch_yfinance_prices(next_day)
        if yf_prices:
            print(f"yfinance: {len(yf_prices)} prices ({min(yf_prices)} → {max(yf_prices)})")
    except Exception as e:
        print(f"yfinance error: {e}")
        yf_prices = {}
    try:
        screener = fetch_screener_prices(next_day)
    except Exception as e:
        print(f"screener error: {e}")
        screener = {}
    filled = sorted(d for d in screener if d not in yf_prices)
    if screener:
        print(f"screener: {len(screener)} prices, filling {len(filled)} day(s) yfinance lacks: {filled}")
    for d in filled:
        yf_prices[d] = screener[d]
    for d, p in yf_prices.items():
        prices.setdefault(d, p)
    return prices


def main():
    now_utc = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{now_utc}] BSE share analysis starting…")

    seed     = load_seed(SEED_FILE)
    pipeline = load_pipeline(REVENUE_FILE)
    print(f"Seed:     {len(seed)} rows  ({min(seed)} → {max(seed)})")
    print(f"Pipeline: {len(pipeline)} rows  ({min(pipeline)} → {max(pipeline)})")

    # Revenue: pipeline > seed for overlapping dates.
    revenue = {d: v["revenue_cr"] for d, v in seed.items() if v.get("revenue_cr") is not None}
    revenue.update(pipeline)
    rev_rows = sorted(revenue.items())

    prices = collect_prices(seed)
    if not prices:
        raise SystemExit("ERROR: No price data — aborting")

    out = sr.build_output(ticker="BSE.NS", prices=prices, rev_rows=rev_rows,
                          reg_start=REGRESSION_START, window=FIXED_MA, ma_windows=MA_WINDOWS,
                          updated_at=now_utc)
    if out is None or out["regression"] is None:
        raise SystemExit(f"ERROR: MA{FIXED_MA} fit unavailable — aborting")

    wrote = sr.write_if_changed(OUTPUT_FILE, out)
    print(f"\n{'Wrote' if wrote else 'Unchanged:'} {OUTPUT_FILE.name} ({len(out['series'])} rows)")
    print(sr.describe(out))


if __name__ == "__main__":
    main()
