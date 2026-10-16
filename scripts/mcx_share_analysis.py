"""
MCX Ltd Share Price Analysis
Fetches MCX.NS share prices from yfinance and merges with daily revenue from
the MCX pipeline JSON. Runs OLS regression of price ~ revenue_MA to model
the revenue-driven fair value of MCX stock.

Outputs: dashboard/data/mcx_share_analysis.json

Run:  python scripts/mcx_share_analysis.py
      (also invoked daily by GitHub Actions after mcx_pipeline.py)
"""

import json
import math
import warnings
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

warnings.filterwarnings("ignore")


class _SafeEncoder(json.JSONEncoder):
    """Convert float NaN/Inf to null so the output is valid JSON."""
    def iterencode(self, o, _one_shot=False):
        return super().iterencode(self._sanitize(o), _one_shot)

    def _sanitize(self, obj):
        if isinstance(obj, float) and (math.isnan(obj) or math.isinf(obj)):
            return None
        if isinstance(obj, dict):
            return {k: self._sanitize(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [self._sanitize(v) for v in obj]
        return obj

SCRIPT_DIR    = Path(__file__).parent
REPO_ROOT     = SCRIPT_DIR.parent
REVENUE_FILE  = REPO_ROOT / "dashboard" / "data" / "mcx_dashboard_data.json"
OUTPUT_FILE   = REPO_ROOT / "dashboard" / "data" / "mcx_share_analysis.json"

TICKER           = "MCX.NS"
REGRESSION_START = "2025-01-01"   # Best R² window (0.81); 2024 start captured pre-rerate regime
MA_WINDOWS       = [20, 30, 45, 50, 60, 90]
FIXED_MA         = 45


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_revenue(path):
    """Returns {date_str: total_rev_cr} from mcx_dashboard_data.json."""
    with open(path) as f:
        raw = json.load(f)
    daily = raw.get("daily_all") or raw.get("daily", [])
    return {
        r["date"]: r["total_rev"]
        for r in daily
        if r.get("total_rev") is not None
    }


def fetch_yfinance_prices(start_date_str):
    """Returns {date_str: close_price} from yfinance MCX.NS (NaN rows excluded)."""
    import yfinance as yf
    hist = yf.Ticker(TICKER).history(start=start_date_str)
    result = {}
    for d, c in zip(hist.index, hist["Close"]):
        price = float(c)
        if not math.isnan(price):
            result[str(d)[:10]] = round(price, 2)
    return result


# ---------------------------------------------------------------------------
# Dataset construction
# ---------------------------------------------------------------------------

def build_dataset(revenue, prices):
    """
    Join revenue and price on date. Both must be present for a row to be included.
    """
    rows = []
    for d in sorted(set(revenue) & set(prices)):
        rows.append({
            "date":       d,
            "revenue_cr": revenue[d],
            "price":      prices[d],
        })
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
    print(f"[{now_utc}] MCX share analysis starting…")

    revenue = load_revenue(REVENUE_FILE)
    print(f"Revenue: {len(revenue)} rows  ({min(revenue)} → {max(revenue)})")

    # Fetch prices from yfinance for the full revenue range
    yf_start = min(revenue)
    print(f"Fetching {TICKER} prices from {yf_start}…")
    try:
        prices = fetch_yfinance_prices(yf_start)
        print(f"yfinance: {len(prices)} prices  ({min(prices)} → {max(prices)})")
    except Exception as e:
        print(f"yfinance error: {e}")
        prices = {}

    if not prices:
        print("ERROR: No price data available — aborting")
        return

    all_rows = build_dataset(revenue, prices)
    print(f"Combined: {len(all_rows)} rows  ({all_rows[0]['date']} → {all_rows[-1]['date']})")

    revenues = [r["revenue_cr"] for r in all_rows]

    # ── Try every MA window, score on regression-window R² ──
    print(f"\nMA window comparison (regression from {REGRESSION_START}):")
    window_results = {}
    for window in MA_WINDOWS:
        mas = rolling_ma(revenues, window)
        reg = [
            {"date": r["date"], "rev_ma": mas[i], "price": r["price"], "revenue_cr": r["revenue_cr"]}
            for i, r in enumerate(all_rows)
            if r["date"] >= REGRESSION_START and mas[i] is not None
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
        marker = " ← fixed" if window == FIXED_MA else ""
        print(f"  MA{window:2d}: R²={r2:.4f}  r={pearson_r:.4f}  n={len(reg)}{marker}")

    if FIXED_MA not in window_results:
        print(f"ERROR: MA{FIXED_MA} window has insufficient data — aborting")
        return

    best        = window_results[FIXED_MA]

    if math.isnan(best["slope"]) or math.isnan(best["intercept"]):
        print(f"ERROR: OLS returned NaN (likely NaN prices in input) — aborting")
        return
    best_window = FIXED_MA
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
        "ticker":           TICKER,
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
    OUTPUT_FILE.write_text(json.dumps(output, indent=2, cls=_SafeEncoder))
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
