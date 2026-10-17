"""
MCX Ltd Share Price Analysis
Fetches MCX.NS share prices from yfinance (screener.in fills missing days) and
fits price ~ 45-day revenue MA (previous session) from REGRESSION_START on to
model the revenue-driven fair value of MCX stock. The method lives in
share_regression.py.

Days flagged `modelled` in the revenue file (the pre-2024-09-02 historical
backfill, see mcx_pipeline.py) never enter a regression fit: a row is left out
when any day in its revenue moving-average window is modelled. They stay in the
output series, flagged, for the chart.

Outputs: dashboard/data/mcx_share_analysis.json

Run:  python scripts/mcx_share_analysis.py
      (also invoked daily by GitHub Actions after mcx_pipeline.py)
"""

import json
import math
import warnings
from datetime import datetime, timezone
from pathlib import Path

import share_regression as sr

warnings.filterwarnings("ignore")

SCRIPT_DIR    = Path(__file__).parent
REPO_ROOT     = SCRIPT_DIR.parent
REVENUE_FILE  = REPO_ROOT / "dashboard" / "data" / "mcx_dashboard_data.json"
OUTPUT_FILE   = REPO_ROOT / "dashboard" / "data" / "mcx_share_analysis.json"

TICKER           = "MCX.NS"
REGRESSION_START = "2025-01-01"   # Best R² window (0.81); 2024 start captured pre-rerate regime
MA_WINDOWS       = [20, 30, 45, 50, 60, 90]
FIXED_MA         = 45
# screener.in company page /company/MCX/ — its public price-chart API needs no
# login. Fills days yfinance is missing, as for BSE and NSE.
SCREENER_COMPANY_ID = 2156


def load_revenue(path):
    """Returns (sorted [(date, total_rev)], {modelled date}) from
    mcx_dashboard_data.json."""
    with open(path) as f:
        raw = json.load(f)
    daily = [r for r in (raw.get("daily_all") or raw.get("daily", []))
             if r.get("total_rev") is not None]
    rows = sorted((r["date"], float(r["total_rev"])) for r in daily)
    modelled = {r["date"] for r in daily if r.get("modelled")}
    return rows, modelled


def fetch_yfinance_prices(start_date_str):
    """Returns {date_str: close_price} from yfinance MCX.NS (NaN rows excluded)."""
    import yfinance as yf
    hist = yf.Ticker(TICKER).history(start=start_date_str)
    result = {}
    for d, c in zip(hist.index, hist["Close"]):
        price = float(c)
        if math.isfinite(price):
            result[str(d)[:10]] = round(price, 2)
    return result


def fetch_screener_prices(start_date_str):
    """Returns {date_str: close} from screener.in's public chart API ('Price on NSE')."""
    from curl_cffi import requests as cffi_requests
    url = (f"https://www.screener.in/api/company/{SCREENER_COMPANY_ID}/chart/"
           f"?q=Price&days=400&consolidated=true")
    r = cffi_requests.get(url, impersonate="chrome", timeout=20,
                          headers={"Referer": "https://www.screener.in/company/MCX/consolidated/"})
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
            if math.isfinite(price) and d >= start_date_str:
                result[d] = round(price, 2)
    return result


def main():
    now_utc = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{now_utc}] MCX share analysis starting…")

    rev_rows, modelled = load_revenue(REVENUE_FILE)
    print(f"Revenue: {len(rev_rows)} rows  ({rev_rows[0][0]} → {rev_rows[-1][0]}), "
          f"{len(modelled)} modelled")

    yf_start = rev_rows[0][0]
    print(f"Fetching {TICKER} prices from {yf_start}…")
    try:
        prices = fetch_yfinance_prices(yf_start)
        print(f"yfinance: {len(prices)} prices  ({min(prices)} → {max(prices)})")
    except Exception as e:
        print(f"yfinance error: {e}")
        prices = {}
    try:
        screener = fetch_screener_prices(yf_start)
    except Exception as e:
        print(f"screener error: {e}")
        screener = {}
    filled = sorted(d for d in screener if d not in prices)
    if screener:
        print(f"screener: {len(screener)} prices, filling {len(filled)} day(s) yfinance lacks: {filled}")
    for d in filled:
        prices[d] = screener[d]
    if not prices:
        raise SystemExit("ERROR: No price data available — aborting")

    out = sr.build_output(ticker=TICKER, prices=prices, rev_rows=rev_rows,
                          reg_start=REGRESSION_START, window=FIXED_MA, ma_windows=MA_WINDOWS,
                          updated_at=now_utc, modelled=modelled)
    if out is None or out["regression"] is None:
        raise SystemExit(f"ERROR: MA{FIXED_MA} fit unavailable — aborting")

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(json.dumps(out, indent=2, allow_nan=False))
    print(f"\nWrote {OUTPUT_FILE.name} ({len(out['series'])} rows)")
    print(sr.describe(out))


if __name__ == "__main__":
    main()
