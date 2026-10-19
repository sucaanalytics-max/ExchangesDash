"""
Share price ~ revenue moving-average regression, shared by the NSE, BSE and MCX
share-analysis scripts (each keeps only its own price fetching).

Method (remediation plan, Phase 5):
- The revenue moving average is computed over the exchange's FULL daily revenue
  series (every day the exchange traded), never only the days that also have a
  share price.
- Revenue is lagged by one session: a day's revenue is published after the
  close, so the close on date d is paired with the MA ending on the last
  revenue day strictly before d. `extra_lag` shifts it further back (in revenue
  trading days) for the lead/lag toggles.
- Price levels on revenue levels have strongly autocorrelated residuals
  (Durbin-Watson far below 2), so plain OLS standard errors overstate
  precision. The slope's standard error is Newey-West (Bartlett kernel,
  bandwidth 1.3·√n).
- Out-of-sample check: fit on the first 80 % of the regression window
  (chronological, no shuffling), predict the last 20 % from its revenue MA and
  compare with a naive forecast that holds the last training-period price.
  R² is in-sample fit only.
- A fair value is "supported" only when n >= MIN_N, the slope is positive and
  significant on Newey-West errors, and the revenue MA moved enough over the
  window to identify a slope.

dashboard/js/13-regression.js (computeShareModel) mirrors this maths for the DMA/lag
toggles; tests/test_share_regression.py checks the two agree.
"""

import bisect
import json
import math

import numpy as np

MIN_N          = 60     # observations before a fair value is published
MIN_T_STAT     = 2.0    # Newey-West t-stat of the slope
MIN_SPREAD     = 0.10   # (max - min) / mean of the revenue MA over the window
HOLDOUT_SHARE  = 0.20   # last 20 % of the window is the out-of-sample test
MIN_HOLDOUT    = 10


def revenue_ma(rev_rows, window):
    """rev_rows: sorted [(date, revenue)]. Returns [ma or None] aligned to rows,
    over consecutive revenue days (no gaps for days without a share price)."""
    out, s = [], 0.0
    vals = [v for _, v in rev_rows]
    for i, v in enumerate(vals):
        s += v
        if i >= window:
            s -= vals[i - window]
        out.append(s / window if i >= window - 1 else None)
    return out


def lagged_ma_for(price_dates, rev_rows, window, extra_lag=0):
    """{price_date: (ma, ma_date)} using the MA that ends on the last revenue
    day strictly before each price date, shifted back `extra_lag` revenue days.
    Price dates with no such MA are left out."""
    rev_dates = [d for d, _ in rev_rows]
    mas = revenue_ma(rev_rows, window)
    out = {}
    for d in price_dates:
        idx = bisect.bisect_left(rev_dates, d) - 1 - extra_lag
        if idx < 0 or mas[idx] is None:
            continue
        out[d] = (mas[idx], rev_dates[idx])
    return out


def nw_lags(n):
    """Newey-West bandwidth 1.3·√n (Lazarus, Lewis, Stock & Watson 2018). The
    textbook 4·(n/100)^(2/9) gives about 5 lags here, far too few for residuals
    this persistent: it roughly doubles the slope's t-stat."""
    return int(math.floor(1.3 * math.sqrt(n)))


def ols_stats(X, Y):
    """OLS of Y on X with intercept. Returns a dict with slope, intercept, r2,
    pearson_r, Newey-West slope SE / t, Durbin-Watson and residuals."""
    X = np.asarray(X, dtype=float)
    Y = np.asarray(Y, dtype=float)
    n = len(X)
    xm, ym = X.mean(), Y.mean()
    sxx = float(((X - xm) ** 2).sum())
    slope = float(((X - xm) * (Y - ym)).sum() / sxx)
    intercept = float(ym - slope * xm)
    resid = Y - (slope * X + intercept)
    ss_res = float((resid ** 2).sum())
    ss_tot = float(((Y - ym) ** 2).sum())
    r2 = 1 - ss_res / ss_tot
    r = float(np.corrcoef(X, Y)[0, 1])

    # Newey-West variance of the slope: Var = S / sxx² with
    # S = Σ_l w_l Σ_t u_t u_{t-l} (x_t - x̄)(x_{t-l} - x̄), w_l = 1 - l/(L+1).
    L = nw_lags(n)
    g = (X - xm) * resid
    S = float((g * g).sum())
    for lag in range(1, L + 1):
        w = 1 - lag / (L + 1)
        S += 2 * w * float((g[lag:] * g[:-lag]).sum())
    se_nw = math.sqrt(max(S, 0.0)) / sxx
    dw = float((np.diff(resid) ** 2).sum() / ss_res) if ss_res > 0 else None
    return {
        "slope": slope, "intercept": intercept, "r2": r2, "pearson_r": r,
        "slope_se_nw": se_nw, "t_nw": slope / se_nw if se_nw > 0 else None,
        "nw_lags": L, "durbin_watson": dw, "n": n,
    }


def holdout_test(X, Y):
    """Chronological train/test split. Fit on the first (1 - HOLDOUT_SHARE),
    predict the rest; baseline holds the last training price flat."""
    n = len(X)
    n_test = max(MIN_HOLDOUT, int(round(n * HOLDOUT_SHARE)))
    n_train = n - n_test
    if n_train < 20:
        return None
    X = np.asarray(X, dtype=float)
    Y = np.asarray(Y, dtype=float)
    fit = ols_stats(X[:n_train], Y[:n_train])
    pred = fit["slope"] * X[n_train:] + fit["intercept"]
    actual = Y[n_train:]
    naive = np.full_like(actual, Y[n_train - 1])
    mape = float(np.mean(np.abs(pred - actual) / actual) * 100)
    mape_naive = float(np.mean(np.abs(naive - actual) / actual) * 100)
    return {
        "n_train": n_train, "n_test": n_test,
        "mape": mape, "mape_naive": mape_naive,
        "beats_naive": mape < mape_naive,
    }


def gate(stats, X):
    """Reasons a fair value is not supported ([] = supported)."""
    reasons = []
    if stats["n"] < MIN_N:
        reasons.append(f"only {stats['n']} observations (needs {MIN_N})")
    if stats["slope"] <= 0:
        reasons.append("slope is not positive")
    elif stats["t_nw"] is None or stats["t_nw"] < MIN_T_STAT:
        t = stats["t_nw"]
        reasons.append(f"slope not significant (Newey-West t = {t:.2f}, needs {MIN_T_STAT:.0f})"
                       if t is not None else "slope not significant")
    xm = float(np.mean(X))
    spread = (float(np.max(X)) - float(np.min(X))) / xm if xm else 0.0
    if spread < MIN_SPREAD:
        reasons.append(f"revenue MA moved only {spread * 100:.0f}% over the window "
                       f"(needs {MIN_SPREAD * 100:.0f}%)")
    return reasons


def fit_model(price_by_date, rev_rows, window, reg_start, extra_lag=0, exclude=None):
    """Fit price ~ lagged revenue MA on price dates >= reg_start.

    price_by_date: {date: close}; rev_rows: sorted [(date, revenue)];
    exclude: optional callable(price_date, ma_date) -> True to leave a row out
    of the fit (MCX modelled history). Returns None when fewer than 10 rows."""
    lag = lagged_ma_for(sorted(price_by_date), rev_rows, window, extra_lag)
    candidates = [d for d in sorted(lag)
                  if d >= reg_start and math.isfinite(price_by_date[d])]
    rows = [(d, lag[d][0], price_by_date[d]) for d in candidates
            if not (exclude and exclude(d, lag[d][1]))]
    if len(rows) < 10:
        return None
    X = [r[1] for r in rows]
    Y = [r[2] for r in rows]
    stats = ols_stats(X, Y)
    stats["holdout"] = holdout_test(X, Y)
    stats["gate_reasons"] = gate(stats, X)
    stats["supported"] = not stats["gate_reasons"]
    stats["dates"] = [r[0] for r in rows]
    stats["excluded"] = len(candidates) - len(rows)
    return stats


def methodology_json(stats):
    """The `methodology` block written to *_share_analysis.json."""
    h = stats.get("holdout")
    return {
        "revenue_lag_days": 1,
        "ma_basis": "all revenue trading days",
        "slope_se_newey_west": round(stats["slope_se_nw"], 4),
        "t_stat_newey_west": round(stats["t_nw"], 2) if stats["t_nw"] is not None else None,
        "newey_west_lags": stats["nw_lags"],
        "durbin_watson": round(stats["durbin_watson"], 3) if stats["durbin_watson"] is not None else None,
        "holdout": {
            "n_train": h["n_train"], "n_test": h["n_test"],
            "mape_pct": round(h["mape"], 2), "naive_mape_pct": round(h["mape_naive"], 2),
            "beats_naive": h["beats_naive"],
        } if h else None,
        "fair_value_supported": stats["supported"],
        "gate_reasons": stats["gate_reasons"],
        "thresholds": {"min_n": MIN_N, "min_t_stat": MIN_T_STAT,
                       "min_ma_spread": MIN_SPREAD, "holdout_share": HOLDOUT_SHARE},
    }


def build_output(*, ticker, prices, rev_rows, reg_start, window, ma_windows,
                 updated_at, modelled=None, prefix_rows=150):
    """Fit the published model and assemble *_share_analysis.json.

    prices: {date: close}; rev_rows: sorted [(date, revenue)] (full history);
    modelled: optional set of revenue dates that must stay out of any fit (a
    row is excluded when any day in its MA window is modelled).
    Returns None when the published window cannot be fitted at all."""
    rev_dates = [d for d, _ in rev_rows]
    rev_by_date = dict(rev_rows)
    modelled = modelled or set()

    def make_exclude(w):
        if not modelled:
            return None
        flags = [d in modelled for d in rev_dates]
        tainted, run = set(), 0
        for i, d in enumerate(rev_dates):
            run += flags[i]
            if i >= w:
                run -= flags[i - w]
            if run:
                tainted.add(d)
        return lambda _pd, ma_date: ma_date in tainted

    comparison = {}
    for w in ma_windows:
        s = fit_model(prices, rev_rows, w, reg_start, exclude=make_exclude(w))
        if s:
            comparison[str(w)] = {"r_squared": round(s["r2"], 4),
                                  "pearson_r": round(s["pearson_r"], 4), "n": s["n"]}

    stats = fit_model(prices, rev_rows, window, reg_start, exclude=make_exclude(window))
    lagged = lagged_ma_for(sorted(prices), rev_rows, window)
    series = []
    for d in sorted(lagged):
        ma, ma_date = lagged[d]
        row = {
            "date":       d,
            "revenue_cr": round(rev_by_date[d], 4) if d in rev_by_date else None,
            "rev_ma":     round(ma, 4),
            "price":      prices[d],
            "price_pred": (round(stats["slope"] * ma + stats["intercept"], 2)
                           if stats and stats["supported"] else None),
        }
        if modelled:
            row["modelled"] = d in modelled
        series.append(row)
    if not series:
        return None

    first_ma_idx = bisect.bisect_left(rev_dates, lagged[series[0]["date"]][1])
    revenue_daily = [dict({"date": d, "revenue_cr": round(v, 4)},
                          **({"modelled": True} if d in modelled else {}))
                     for d, v in rev_rows[max(0, first_ma_idx - prefix_rows):]]

    in_fit = set(stats["dates"]) if stats else set()
    fit_rows = [r for r in series if r["date"] in in_fit]
    latest = series[-1]
    n = len(fit_rows)
    out = {
        "updated_at":        updated_at,
        "ticker":            ticker,
        "ma_window":         window,
        "regression_start":  reg_start,
        "n_days":            n,
        "ma_window_comparison": comparison,
        "regression":        None,
        "methodology":       methodology_json(stats) if stats else None,
        "latest": {
            "date":         latest["date"],
            "revenue_cr":   latest["revenue_cr"],
            "rev_ma":       latest["rev_ma"],
            "price_actual": latest["price"],
            "price_pred":   latest["price_pred"],
            "error_pct":    (round(abs(latest["price_pred"] - latest["price"]) / latest["price"] * 100, 1)
                             if latest["price_pred"] is not None else None),
        },
        "series":            series,
        "revenue_daily":     revenue_daily,
    }
    if modelled:
        out["modelled_excluded"] = stats["excluded"] if stats else None
    if stats:
        out["regression"] = {
            "slope":     round(stats["slope"], 4),
            "intercept": round(stats["intercept"], 2),
            "r_squared": round(stats["r2"], 4),
            "pearson_r": round(stats["pearson_r"], 4),
            "equation":  (f"Price = {stats['slope']:.2f} × Rev_MA{window}[t-1] "
                          f"+ {stats['intercept']:.2f}"),
            "fit":       "strong" if stats["r2"] > 0.7 else "moderate" if stats["r2"] > 0.4 else "weak",
        }
    return out


def describe(out):
    """One-line run summary for the job log."""
    m, lat = out.get("methodology"), out["latest"]
    if not m:
        return f"no fit; latest {lat['date']} ₹{lat['price_actual']}"
    h = m["holdout"] or {}
    return (f"n={out['n_days']} R²={out['regression']['r_squared']} "
            f"NW t={m['t_stat_newey_west']} DW={m['durbin_watson']} "
            f"holdout MAPE {h.get('mape_pct')}% vs naive {h.get('naive_mape_pct')}% · "
            f"fair value {'supported' if m['fair_value_supported'] else 'withheld: ' + '; '.join(m['gate_reasons'])} · "
            f"latest {lat['date']} ₹{lat['price_actual']} pred {lat['price_pred']}")


def write_if_changed(path, out):
    """Write `out` to `path` as JSON unless the file already holds the same
    analysis, ignoring `updated_at`. A rerun on unchanged prices then leaves the
    file alone and the workflow commits nothing. Returns True when it wrote.
    allow_nan=False: fail the run loudly rather than ship invalid JSON (a bare
    NaN token makes the browser's JSON.parse throw and blanks the whole tab)."""
    text = json.dumps(out, indent=2, allow_nan=False)
    try:
        old = json.loads(path.read_text())
    except (OSError, ValueError):
        old = None
    if isinstance(old, dict):
        new = json.loads(text)
        old.pop("updated_at", None)
        new.pop("updated_at", None)
        if old == new:
            return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return True
