"""
BSE Ltd Share Price Analysis
Merges historical seed CSV + daily pipeline JSON for revenue.
Fetches BSE.NS share prices from Excel seed (primary) and yfinance (extension).
Runs OLS regression on data from REGRESSION_START onwards, auto-selecting
the best MA window from a candidate list (preferred: 45-day).

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

warnings.filterwarnings("ignore")

SCRIPT_DIR      = Path(__file__).parent
REPO_ROOT       = SCRIPT_DIR.parent
SEED_FILE       = REPO_ROOT / "dashboard" / "data" / "bse_revenue_seed.csv"
REVENUE_FILE    = REPO_ROOT / "dashboard" / "data" / "bse_dashboard_data.json"
OUTPUT_FILE     = REPO_ROOT / "dashboard" / "data" / "bse_share_analysis.json"

REGRESSION_START = "2025-03-01"
MA_WINDOWS       = [20, 30, 45, 50, 60, 90]
PREFERRED_MA     = 45
FIXED_MA         = 45   # always use this window regardless of R²


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
# Dataset construction
# ---------------------------------------------------------------------------

def build_dataset(seed, pipeline):
    """
    Merge revenue from seed + pipeline, and price from seed + yfinance.

    Revenue priority : pipeline JSON > seed CSV  (for overlapping dates)
    Price priority   : seed CSV > yfinance        (yfinance fills dates beyond seed)
    """
    all_dates = sorted(set(seed) | set(pipeline))

    # Find last date that has a price in seed
    seed_dates_with_price = sorted(d for d, v in seed.items() if v.get("price") is not None)
    last_seed_price_date = seed_dates_with_price[-1] if seed_dates_with_price else None

    # Fetch yfinance only for dates after the seed's last price
    yf_prices = {}
    if last_seed_price_date:
        next_day = (
            datetime.strptime(last_seed_price_date, "%Y-%m-%d") + timedelta(days=1)
        ).strftime("%Y-%m-%d")
        try:
            yf_prices = fetch_yfinance_prices(next_day)
            if yf_prices:
                print(
                    f"yfinance: {len(yf_prices)} prices "
                    f"({min(yf_prices)} → {max(yf_prices)})"
                )
        except Exception as e:
            print(f"yfinance error: {e}")

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

    rows = []
    for d in all_dates:
        # Revenue: pipeline takes priority
        rev = pipeline.get(d)
        if rev is None:
            rev = seed.get(d, {}).get("revenue_cr")
        if rev is None:
            continue

        # Price: seed first, yfinance as extension. `or` would let a NaN
        # seed price incorrectly win over a valid yfinance one (NaN is
        # truthy in Python), so check finiteness explicitly.
        seed_price = seed.get(d, {}).get("price")
        if seed_price is not None and not np.isfinite(seed_price):
            seed_price = None
        price = seed_price if seed_price is not None else yf_prices.get(d)
        if price is None or not np.isfinite(price):
            continue

        rows.append({"date": d, "revenue_cr": rev, "price": price})

    return sorted(rows, key=lambda r: r["date"])


# ---------------------------------------------------------------------------
# Statistics
# ---------------------------------------------------------------------------

def rolling_ma(values, window):
    """Returns list of MA values; None for the first (window-1) entries."""
    result = []
    for i in range(len(values)):
        if i < window - 1:
            result.append(None)
        else:
            result.append(float(np.mean(values[i - window + 1 : i + 1])))
    return result


def run_ols(X, Y):
    slope, intercept = np.polyfit(X, Y, 1)
    pred = slope * X + intercept
    r2   = 1 - np.var(Y - pred) / np.var(Y)
    r    = np.corrcoef(X, Y)[0, 1]
    return slope, intercept, r2, r


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    now_utc = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    print(f"[{now_utc}] BSE share analysis starting…")

    seed     = load_seed(SEED_FILE)
    pipeline = load_pipeline(REVENUE_FILE)
    print(f"Seed:     {len(seed)} rows  ({min(seed)} → {max(seed)})")
    print(f"Pipeline: {len(pipeline)} rows  ({min(pipeline)} → {max(pipeline)})")

    all_rows = build_dataset(seed, pipeline)
    print(
        f"Combined: {len(all_rows)} rows  "
        f"({all_rows[0]['date']} → {all_rows[-1]['date']})"
    )

    revenues = [r["revenue_cr"] for r in all_rows]

    # ── Try every MA window, score on regression-window R² ──
    print(f"\nMA window comparison (regression from {REGRESSION_START}):")
    window_results = {}
    for window in MA_WINDOWS:
        mas = rolling_ma(revenues, window)
        # Defense in depth: a single non-finite price/MA here would otherwise
        # poison the entire np.polyfit/np.corrcoef fit (numpy propagates one
        # NaN to every output), not just that one row's prediction.
        reg = [
            {"date": r["date"], "rev_ma": mas[i], "price": r["price"], "revenue_cr": r["revenue_cr"]}
            for i, r in enumerate(all_rows)
            if r["date"] >= REGRESSION_START and mas[i] is not None and np.isfinite(r["price"])
        ]
        if len(reg) < 10:
            continue
        X = np.array([r["rev_ma"] for r in reg])
        Y = np.array([r["price"]  for r in reg])
        slope, intercept, r2, pearson_r = run_ols(X, Y)
        window_results[window] = {
            "slope": slope, "intercept": intercept,
            "r2": r2, "pearson_r": pearson_r, "n": len(reg),
        }
        marker = " ← preferred" if window == PREFERRED_MA else ""
        print(f"  MA{window:2d}: R²={r2:.4f}  r={pearson_r:.4f}  n={len(reg)}{marker}")

    # Use fixed 45-day MA
    best_window = FIXED_MA
    best        = window_results[best_window]
    print(f"\nUsing MA{best_window} (R²={best['r2']:.4f})")

    # ── Build full series with best window ──
    mas = rolling_ma(revenues, best_window)
    series = []
    for i, row in enumerate(all_rows):
        if mas[i] is None:
            continue
        pred = best["slope"] * mas[i] + best["intercept"]
        series.append({
            "date":       row["date"],
            "revenue_cr": round(row["revenue_cr"], 4),
            "rev_ma":     round(mas[i], 4),
            "price":      row["price"],
            "price_pred": round(pred, 2),
        })

    reg_series = [r for r in series if r["date"] >= REGRESSION_START]
    latest     = reg_series[-1] if reg_series else series[-1]
    error_pct  = round(
        abs(latest["price_pred"] - latest["price"]) / latest["price"] * 100, 1
    )
    fit_label  = "strong" if best["r2"] > 0.7 else "moderate" if best["r2"] > 0.4 else "weak"

    output = {
        "updated_at":       now_utc,
        "ticker":           "BSE.NS",
        "ma_window":        best_window,
        "regression_start": REGRESSION_START,
        "n_days":           len(reg_series),
        "ma_window_comparison": {
            str(w): {
                "r_squared":  round(v["r2"],       4),
                "pearson_r":  round(v["pearson_r"], 4),
                "n":          v["n"],
            }
            for w, v in window_results.items()
        },
        "regression": {
            "slope":      round(best["slope"],      4),
            "intercept":  round(best["intercept"],  2),
            "r_squared":  round(best["r2"],         4),
            "pearson_r":  round(best["pearson_r"],  4),
            "equation":   (
                f"Price = {best['slope']:.2f} × "
                f"Rev_MA{best_window} + {best['intercept']:.2f}"
            ),
            "fit": fit_label,
        },
        "latest": {
            "date":         latest["date"],
            "revenue_cr":   latest["revenue_cr"],
            "rev_ma":       latest["rev_ma"],
            "price_actual": latest["price"],
            "price_pred":   latest["price_pred"],
            "error_pct":    error_pct,
        },
        "series": series,
    }

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    # allow_nan=False: fail the run loudly if a NaN/Inf ever reaches this
    # point instead of silently writing invalid JSON (a literal `NaN` token
    # is not valid JSON — the browser's JSON.parse() throws on it, which is
    # exactly what broke the Regression/Valuation tabs last time).
    OUTPUT_FILE.write_text(json.dumps(output, indent=2, allow_nan=False))
    print(
        f"\nWrote {OUTPUT_FILE.name} "
        f"({len(series)} total rows, {len(reg_series)} in regression window)"
    )
    print(
        f"Latest ({latest['date']}): "
        f"actual ₹{latest['price']}  "
        f"pred ₹{latest['price_pred']}  "
        f"error {error_pct}%"
    )


if __name__ == "__main__":
    main()
