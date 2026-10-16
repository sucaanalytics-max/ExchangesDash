"""
NSE (National Stock Exchange of India) Share Price Analysis
NSE listed on 2026-09-24 (Yahoo ticker NSE.BO), so price history starts there.
Collects daily closes and joins them to NSE's daily revenue. The regression of
price ~ 45-day revenue MA only runs once MIN_DAYS_FOR_REGRESSION trading days of
price exist; before that this writes status="collecting" with the price series
only, and the dashboard shows a progress panel instead of a fit.

The revenue MA is computed over NSE's FULL revenue history (not just post-listing
days), so it's defined from the first listed day. `revenue_prefix` carries the
pre-listing revenue rows the dashboard needs to recompute other DMA windows / lags.

Outputs: dashboard/data/nse_share_analysis.json

Run:  python scripts/nse_share_analysis.py
      (also invoked daily by GitHub Actions after nse_pipeline.py)
"""

import json
import math
import warnings
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

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

MIN_DAYS_FOR_REGRESSION = 20   # below this: collect prices only, no fit
LIMITED_DATA_BELOW      = 60   # fit runs but flagged "limited data" until here
PREFIX_ROWS             = 150  # pre-listing revenue rows shipped to the dashboard
                               # (max DMA 45 + max lag 90 - 1 = 134 needed)


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


def rolling_ma_by_date(rev_rows, window):
    """{date: MA} over the full revenue series; only dates with a full window."""
    out = {}
    vals = [v for _, v in rev_rows]
    for i in range(window - 1, len(rev_rows)):
        out[rev_rows[i][0]] = float(np.mean(vals[i - window + 1 : i + 1]))
    return out


def run_ols(X, Y):
    slope, intercept = np.polyfit(X, Y, 1)
    pred = slope * X + intercept
    r2   = 1 - np.var(Y - pred) / np.var(Y)
    r    = np.corrcoef(X, Y)[0, 1]
    return float(slope), float(intercept), float(r2), float(r)


def main():
    now_utc = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    print(f"[{now_utc}] NSE share analysis starting…")

    rev_rows = load_revenue(REVENUE_FILE)
    rev_by_date = dict(rev_rows)
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
    if not prices:
        print("ERROR: No price data from Yahoo or screener — aborting")
        return

    # Only days with BOTH a price and a revenue row are usable (revenue posts a
    # little after the close, so the newest price can be ahead of the newest revenue).
    ma45 = rolling_ma_by_date(rev_rows, FIXED_MA)
    joined = [d for d in sorted(prices) if d in rev_by_date and d in ma45 and d >= LISTING_DATE]
    n = len(joined)
    print(f"Joined price+revenue days: {n}")
    if n == 0:
        print("ERROR: no overlapping price/revenue days yet — aborting")
        return

    status = "ready" if n >= MIN_DAYS_FOR_REGRESSION else "collecting"

    window_results, best = {}, None
    if status == "ready":
        print(f"\nMA window comparison (regression from {LISTING_DATE}):")
        for window in MA_WINDOWS:
            ma = rolling_ma_by_date(rev_rows, window)
            days = [d for d in joined if d in ma]
            if len(days) < MIN_DAYS_FOR_REGRESSION:
                continue
            X = np.array([ma[d] for d in days])
            Y = np.array([prices[d] for d in days])
            slope, intercept, r2, r = run_ols(X, Y)
            if not all(math.isfinite(v) for v in (slope, intercept, r2, r)):
                print(f"  MA{window}: non-finite fit, skipped")
                continue
            window_results[window] = {"slope": slope, "intercept": intercept,
                                      "r2": r2, "pearson_r": r, "n": len(days)}
            print(f"  MA{window:2d}: R²={r2:.4f}  r={r:.4f}  n={len(days)}{' ← fixed' if window == FIXED_MA else ''}")
        best = window_results.get(FIXED_MA)
        if best is None:
            print(f"MA{FIXED_MA} fit unavailable — falling back to collecting state")
            status = "collecting"

    series = []
    for d in joined:
        row = {
            "date":       d,
            "revenue_cr": round(rev_by_date[d], 4),
            "rev_ma":     round(ma45[d], 4),
            "price":      prices[d],
            "price_pred": round(best["slope"] * ma45[d] + best["intercept"], 2) if best else None,
        }
        series.append(row)
    latest = series[-1]

    first_idx = next(i for i, (d, _) in enumerate(rev_rows) if d == joined[0])
    prefix = [{"date": d, "revenue_cr": round(v, 4)}
              for d, v in rev_rows[max(0, first_idx - PREFIX_ROWS):first_idx]]

    if best:
        error_pct = round(abs(latest["price_pred"] - latest["price"]) / latest["price"] * 100, 1)
        fit_label = "strong" if best["r2"] > 0.7 else "moderate" if best["r2"] > 0.4 else "weak"
        regression = {
            "slope":     round(best["slope"], 4),
            "intercept": round(best["intercept"], 2),
            "r_squared": round(best["r2"], 4),
            "pearson_r": round(best["pearson_r"], 4),
            "equation":  f"Price = {best['slope']:.2f} × Rev_MA{FIXED_MA} + {best['intercept']:.2f}",
            "fit":       fit_label,
        }
    else:
        error_pct, regression = None, None

    output = {
        "updated_at":       now_utc,
        "ticker":           TICKER,
        "status":           status,
        "listing_date":     LISTING_DATE,
        "min_days_required": MIN_DAYS_FOR_REGRESSION,
        "limited_data":     n < LIMITED_DATA_BELOW,
        "ma_window":        FIXED_MA,
        "regression_start": LISTING_DATE,
        "n_days":           n,
        "first_price":      series[0]["price"],
        "ma_window_comparison": {
            str(w): {"r_squared": round(v["r2"], 4), "pearson_r": round(v["pearson_r"], 4), "n": v["n"]}
            for w, v in window_results.items()
        },
        "regression": regression,
        "latest": {
            "date":         latest["date"],
            "revenue_cr":   latest["revenue_cr"],
            "rev_ma":       latest["rev_ma"],
            "price_actual": latest["price"],
            "price_pred":   latest["price_pred"],
            "error_pct":    error_pct,
        },
        "series":          series,
        "revenue_prefix":  prefix,
    }

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    # allow_nan=False: fail the run loudly rather than ship invalid JSON (a bare
    # NaN token makes the browser's JSON.parse throw and blanks the whole tab).
    OUTPUT_FILE.write_text(json.dumps(output, indent=2, allow_nan=False))
    print(f"\nWrote {OUTPUT_FILE.name}: status={status}, {n}/{MIN_DAYS_FOR_REGRESSION} days, "
          f"{len(prefix)} prefix rows")
    print(f"Latest ({latest['date']}): ₹{latest['price']}"
          + (f"  pred ₹{latest['price_pred']}  error {error_pct}%" if best else ""))


if __name__ == "__main__":
    main()
