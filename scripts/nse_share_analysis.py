"""
NSE (National Stock Exchange of India) Share Price Analysis
NSE listed on 2026-09-24 (Yahoo ticker NSE.BO), so price history starts there.
Collects daily closes and pairs each with NSE's 45-day revenue MA up to the
previous session (see share_regression.py for the method). Until
share_regression.MIN_N price days exist this writes status="collecting" and the
dashboard shows a progress panel; after that the fit is shown, and a fair value
is published only if the slope is positive, significant and identifiable.

The revenue MA is computed over NSE's FULL revenue history (not just post-listing
days), so it's defined from the first listed day. `revenue_daily` carries the
revenue rows the dashboard needs to recompute other DMA windows / lags.

Outputs: dashboard/data/nse_share_analysis.json

Run:  python scripts/nse_share_analysis.py
      (also invoked daily by GitHub Actions after nse_pipeline.py)
"""

import json
import math
import warnings
from datetime import datetime, timezone
from pathlib import Path

import share_regression as sr

warnings.filterwarnings("ignore")

SCRIPT_DIR   = Path(__file__).parent
REPO_ROOT    = SCRIPT_DIR.parent
REVENUE_FILE = REPO_ROOT / "dashboard" / "data" / "nse_dashboard_data.json"
OUTPUT_FILE  = REPO_ROOT / "dashboard" / "data" / "nse_share_analysis.json"

TICKER        = "NSE.BO"
LISTING_DATE  = "2026-09-24"
# screener.in company page /company/544937/ — its public price-chart API needs no
# login. Used only to fill days Yahoo is missing (Yahoo's NSE.BO daily history has
# skipped days, e.g. Fri 2026-09-25) and as a fallback if Yahoo fails entirely.
SCREENER_COMPANY_ID = 1274230
MA_WINDOWS    = [20, 30, 45, 50, 60, 90]
FIXED_MA      = 45


def load_revenue(path):
    """Returns sorted [(date, total_rev)] from nse_dashboard_data.json."""
    with open(path) as f:
        raw = json.load(f)
    daily = raw.get("daily_all") or raw.get("daily", [])
    rows = [(r["date"], float(r["total_rev"])) for r in daily if r.get("total_rev") is not None]
    return sorted(rows)


def fetch_yfinance_prices(start_date_str):
    """Returns {date_str: close} from yfinance, dropping NaN closes (a bad row must
    never reach np.polyfit — one NaN turns the whole fit into NaN)."""
    import yfinance as yf
    hist = yf.Ticker(TICKER).history(start=start_date_str)
    result = {}
    for d, c in zip(hist.index, hist["Close"]):
        price = float(c)
        if math.isfinite(price):
            result[str(d)[:10]] = round(price, 2)
    return result


def fetch_screener_prices():
    """Returns {date_str: close} from screener.in's public chart API ('Price on BSE')."""
    from curl_cffi import requests as cffi_requests
    url = (f"https://www.screener.in/api/company/{SCREENER_COMPANY_ID}/chart/"
           f"?q=Price&days=400&consolidated=true")
    r = cffi_requests.get(url, impersonate="chrome", timeout=20,
                          headers={"Referer": "https://www.screener.in/company/544937/consolidated/"})
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
            if math.isfinite(price) and d >= LISTING_DATE:
                result[d] = round(price, 2)
    return result


def main():
    now_utc = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{now_utc}] NSE share analysis starting…")

    rev_rows = load_revenue(REVENUE_FILE)
    print(f"Revenue: {len(rev_rows)} rows  ({rev_rows[0][0]} → {rev_rows[-1][0]})")

    print(f"Fetching {TICKER} prices from {LISTING_DATE}…")
    try:
        prices = fetch_yfinance_prices(LISTING_DATE)
    except Exception as e:
        print(f"yfinance error: {e}")
        prices = {}
    if prices:
        print(f"yfinance: {len(prices)} prices  ({min(prices)} → {max(prices)})")

    try:
        screener = fetch_screener_prices()
    except Exception as e:
        print(f"screener error: {e}")
        screener = {}
    filled = sorted(d for d in screener if d not in prices)
    if screener:
        print(f"screener: {len(screener)} prices, filling {len(filled)} day(s) Yahoo lacks: {filled}")
    for d in filled:
        prices[d] = screener[d]
    prices = {d: p for d, p in prices.items() if d >= LISTING_DATE}
    if not prices:
        raise SystemExit("ERROR: No price data from Yahoo or screener")

    out = sr.build_output(ticker=TICKER, prices=prices, rev_rows=rev_rows,
                          reg_start=LISTING_DATE, window=FIXED_MA, ma_windows=MA_WINDOWS,
                          updated_at=now_utc)
    if out is None:
        raise SystemExit("ERROR: no price day has a revenue moving average yet")

    n = out["n_days"]
    out.update({
        "status":            "ready" if n >= sr.MIN_N else "collecting",
        "listing_date":      LISTING_DATE,
        "min_days_required": sr.MIN_N,
        "first_price":       out["series"][0]["price"],
    })

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    # allow_nan=False: fail the run loudly rather than ship invalid JSON (a bare
    # NaN token makes the browser's JSON.parse throw and blanks the whole tab).
    OUTPUT_FILE.write_text(json.dumps(out, indent=2, allow_nan=False))
    print(f"\nWrote {OUTPUT_FILE.name}: status={out['status']}, {n}/{sr.MIN_N} days")
    print(sr.describe(out))


if __name__ == "__main__":
    main()
