# Trading-logic tree: walk-forward backtest

The tree, as drawn on the desk's whiteboard: each day, for each name,
  Gate 1 · revenue turning: a short ADR window against the 45-session ADR;
  Gate 2 · price cheap: on the ratio model (price ÷ 45-session revenue MA, mean ∓ σ) and/or
           below the regression line (price on the lagged MA, ∓ its standard error);
  Gate 3 · ADR model agrees: price at or below the ADR model's base (the 45-session ADR grown
           at the QoQ rate to the next FY × sessions + other income → PAT → EPS × P/E,
           discounted, as js/14-valuation.js's valuationAdrPath / valuationAdrModel);
and the ladder on the ratio: at or below bear (−1σ) buy futures, between bear and base sell a
put, at base sell a covered call, between base and bull cut the futures, at bull (+1σ) exit or,
with revenue also below the 45-day, go short. A 30 % override lets a long through when the short
window beats the 45-day by 30 % even if price is not cheap (up to +0.5σ).

**Caveat.** Not point-in-time: every day uses today's valuation_inputs.json for Gate 3 (P/E, the next FY's other income, PAT margin, sessions and both discount rates) and for the fit's start date (regression_from, an analyst's later choice). The price and revenue fits use only sessions before each day, but these inputs were set later, so results before they were set are not a clean out-of-sample test.

## BSE

Fit from 2025-01-01; first signal 2025-03-05, first day with bands and option data 2025-06-05, last 2026-11-25; 492 days of NSE option data.

Elasticity of price to the 45-session ADR: log–log slope 0.672 (ratio model assumes 1; the linear regression implies 0.732 at today's MA).

| Config | Trades | Episodes | Win % | Mean % | Sum % | Worst % | Train n / sum % | Test n / sum % |
|---|---|---|---|---|---|---|---|---|
| 10d-T10-and-not_falling | 5 | 5 | 80.0 | 23.3 | 116.49 | -4.13 | 4 / 102.58 | 1 / 13.91 |
| 10d-T10-ratio-not_falling | 7 | 7 | 57.1 | 15.03 | 105.22 | -4.13 | 4 / 102.58 | 3 / 2.65 |
| 10d-T10-or-not_falling | 7 | 7 | 57.1 | 15.03 | 105.22 | -4.13 | 4 / 102.58 | 3 / 2.65 |
| 2w-T10-and-not_falling | 6 | 5 | 66.7 | 17.01 | 102.05 | -4.13 | 4 / 97.39 | 2 / 4.66 |
| 2w-T10-ratio-not_falling | 7 | 7 | 57.1 | 14.07 | 98.46 | -4.13 | 4 / 97.39 | 3 / 1.07 |
| 2w-T10-or-not_falling | 7 | 7 | 57.1 | 14.07 | 98.46 | -4.13 | 4 / 97.39 | 3 / 1.07 |
| 10d-T10-and-rising | 5 | 5 | 80.0 | 18.95 | 94.76 | -4.13 | 4 / 80.85 | 1 / 13.91 |
| 10d-T20-and-not_falling | 6 | 6 | 83.3 | 14.17 | 85.04 | -4.13 | 5 / 71.12 | 1 / 13.91 |
| 10d-T10-ratio-rising | 5 | 5 | 80.0 | 16.95 | 84.75 | -4.13 | 4 / 80.85 | 1 / 3.91 |
| 10d-T10-or-rising | 5 | 5 | 80.0 | 16.95 | 84.75 | -4.13 | 4 / 80.85 | 1 / 3.91 |
| 10d-T20-ratio-not_falling | 7 | 7 | 71.4 | 10.72 | 75.03 | -4.13 | 5 / 71.12 | 2 / 3.91 |
| 10d-T20-or-not_falling | 7 | 7 | 71.4 | 10.72 | 75.03 | -4.13 | 5 / 71.12 | 2 / 3.91 |
| 2w-T20-and-not_falling | 7 | 6 | 71.4 | 10.08 | 70.59 | -4.13 | 5 / 65.93 | 2 / 4.66 |
| 2w-T20-ratio-not_falling | 7 | 7 | 71.4 | 9.98 | 69.84 | -4.13 | 5 / 65.93 | 2 / 3.91 |
| 2w-T20-or-not_falling | 7 | 7 | 71.4 | 9.98 | 69.84 | -4.13 | 5 / 65.93 | 2 / 3.91 |
| 2w-T10-and-rising | 6 | 5 | 83.3 | 11.0 | 66.01 | -4.13 | 5 / 61.35 | 1 / 4.66 |
| 2w-T10-ratio-rising | 6 | 5 | 83.3 | 10.88 | 65.26 | -4.13 | 5 / 61.35 | 1 / 3.91 |
| 2w-T10-or-rising | 6 | 5 | 83.3 | 10.88 | 65.26 | -4.13 | 5 / 61.35 | 1 / 3.91 |
| 10d-T20-and-rising | 6 | 6 | 83.3 | 8.86 | 53.18 | -5.5 | 5 / 39.27 | 1 / 13.91 |
| 10d-T20-ratio-rising | 6 | 6 | 83.3 | 7.2 | 43.18 | -5.5 | 5 / 39.27 | 1 / 3.91 |
| 10d-T20-or-rising | 6 | 6 | 83.3 | 7.2 | 43.18 | -5.5 | 5 / 39.27 | 1 / 3.91 |
| 2w-T20-ratio-rising | 7 | 7 | 85.7 | 6.07 | 42.46 | -4.13 | 6 / 38.55 | 1 / 3.91 |
| 2w-T20-or-rising | 7 | 7 | 85.7 | 6.07 | 42.46 | -4.13 | 6 / 38.55 | 1 / 3.91 |
| 2w-T20-and-rising | 7 | 7 | 85.7 | 6.06 | 42.45 | -4.13 | 6 / 38.55 | 1 / 3.9 |

Today (2026-11-25): price 3775.2, 45-day ADR 21.41, 10-session 20.8, 2 whole weeks 22.04; ratio [3749, 4440, 5131], regression [3476, 3806, 4135], ADR model [3433, 3862, 4291] → ladder **bear-base**.

All three gates pass today in 12 of 24 configs: 10d-T10-ratio-not_falling, 10d-T10-and-not_falling, 10d-T10-or-not_falling, 10d-T20-ratio-not_falling, 10d-T20-and-not_falling, 10d-T20-or-not_falling, 2w-T10-ratio-not_falling, 2w-T10-and-not_falling, 2w-T10-or-not_falling, 2w-T20-ratio-not_falling, 2w-T20-and-not_falling, 2w-T20-or-not_falling.

## MCX

Fit from 2024-11-01; first signal 2025-01-07, first day with bands and option data 2025-04-03, last 2026-11-25; 657 days of NSE option data.

Elasticity of price to the 45-session ADR: log–log slope 0.833 (ratio model assumes 1; the linear regression implies 0.882 at today's MA).

| Config | Trades | Episodes | Win % | Mean % | Sum % | Worst % | Train n / sum % | Test n / sum % |
|---|---|---|---|---|---|---|---|---|
| 2w-T10-ratio-not_falling | 10 | 6 | 90.0 | 13.97 | 139.71 | 0.0 | 6 / 134.34 | 4 / 5.37 |
| 2w-T10-or-not_falling | 10 | 6 | 90.0 | 13.97 | 139.71 | 0.0 | 6 / 134.34 | 4 / 5.37 |
| 10d-T20-ratio-rising | 9 | 5 | 77.8 | 15.02 | 135.18 | -1.88 | 8 / 134.25 | 1 / 0.92 |
| 10d-T20-or-rising | 9 | 5 | 77.8 | 15.02 | 135.18 | -1.88 | 8 / 134.25 | 1 / 0.92 |
| 2w-T10-and-not_falling | 6 | 4 | 100.0 | 22.39 | 134.34 | 1.54 | 6 / 134.34 | 0 / 0 |
| 10d-T20-and-rising | 8 | 4 | 75.0 | 16.78 | 134.25 | -1.88 | 8 / 134.25 | 0 / 0 |
| 10d-T10-ratio-rising | 9 | 6 | 88.9 | 13.81 | 124.26 | 0.0 | 6 / 122.22 | 3 / 2.04 |
| 10d-T10-or-rising | 9 | 6 | 88.9 | 13.81 | 124.26 | 0.0 | 6 / 122.22 | 3 / 2.04 |
| 10d-T10-and-rising | 6 | 4 | 100.0 | 20.37 | 122.22 | 1.54 | 6 / 122.22 | 0 / 0 |
| 2w-T20-and-not_falling | 7 | 4 | 85.7 | 16.11 | 112.74 | -1.88 | 7 / 112.74 | 0 / 0 |
| 10d-T20-ratio-not_falling | 12 | 6 | 83.3 | 8.93 | 107.11 | -0.19 | 8 / 101.74 | 4 / 5.37 |
| 10d-T20-or-not_falling | 12 | 6 | 83.3 | 8.93 | 107.11 | -0.19 | 8 / 101.74 | 4 / 5.37 |
| 2w-T20-ratio-not_falling | 11 | 6 | 90.9 | 9.56 | 105.11 | 0.0 | 7 / 99.75 | 4 / 5.37 |
| 2w-T20-or-not_falling | 11 | 6 | 90.9 | 9.56 | 105.11 | 0.0 | 7 / 99.75 | 4 / 5.37 |
| 10d-T20-and-not_falling | 7 | 4 | 85.7 | 14.26 | 99.81 | -0.19 | 7 / 99.81 | 0 / 0 |
| 10d-T10-ratio-not_falling | 11 | 6 | 90.9 | 8.98 | 98.76 | 0.0 | 7 / 93.4 | 4 / 5.37 |
| 10d-T10-or-not_falling | 11 | 6 | 90.9 | 8.98 | 98.76 | 0.0 | 7 / 93.4 | 4 / 5.37 |
| 2w-T10-ratio-rising | 7 | 6 | 85.7 | 13.62 | 95.31 | 0.0 | 5 / 94.38 | 2 / 0.92 |
| 2w-T10-or-rising | 7 | 6 | 85.7 | 13.62 | 95.31 | 0.0 | 5 / 94.38 | 2 / 0.92 |
| 2w-T10-and-rising | 5 | 4 | 100.0 | 18.88 | 94.38 | 1.54 | 5 / 94.38 | 0 / 0 |
| 2w-T20-ratio-rising | 5 | 4 | 100.0 | 18.88 | 94.38 | 1.54 | 5 / 94.38 | 0 / 0 |
| 2w-T20-and-rising | 5 | 4 | 100.0 | 18.88 | 94.38 | 1.54 | 5 / 94.38 | 0 / 0 |
| 2w-T20-or-rising | 5 | 4 | 100.0 | 18.88 | 94.38 | 1.54 | 5 / 94.38 | 0 / 0 |
| 10d-T10-and-not_falling | 6 | 4 | 100.0 | 15.24 | 91.46 | 1.54 | 6 / 91.46 | 0 / 0 |

Today (2026-11-25): price 3565.0, 45-day ADR 13.76, 10-session 16.74, 2 whole weeks 15.51; ratio [3148, 3706, 4265], regression [2984, 3331, 3678], ADR model [3628, 4070, 4513] → ladder **bear-base**.

All three gates pass today in 14 of 24 configs: 10d-T10-ratio-rising, 10d-T10-ratio-not_falling, 10d-T10-or-rising, 10d-T10-or-not_falling, 10d-T20-ratio-rising, 10d-T20-ratio-not_falling, 10d-T20-or-rising, 10d-T20-or-not_falling, 2w-T10-ratio-rising, 2w-T10-ratio-not_falling, 2w-T10-or-rising, 2w-T10-or-not_falling, 2w-T20-ratio-not_falling, 2w-T20-or-not_falling.

## Replay cases

### BSE from 1 Oct 2026: the tree should catch the run

- `10d-T10-and-not_falling`: futures long 2026-10-22 at 3265.0 → 2026-11-23 (open at end) 13.913 %
- `10d-T10-and-rising`: futures long 2026-10-22 at 3265.0 → 2026-11-23 (open at end) 13.913 %
- `10d-T10-or-not_falling`: put sold 2026-10-22 at 3265.0 → 2026-11-23 (expiry) 3.908 %
- `10d-T10-or-rising`: put sold 2026-10-22 at 3265.0 → 2026-11-23 (expiry) 3.908 %
- `10d-T10-ratio-not_falling`: put sold 2026-10-22 at 3265.0 → 2026-11-23 (expiry) 3.908 %
- `10d-T10-ratio-rising`: put sold 2026-10-22 at 3265.0 → 2026-11-23 (expiry) 3.908 %
- `10d-T20-and-not_falling`: futures long 2026-10-22 at 3265.0 → 2026-11-23 (open at end) 13.913 %
- `10d-T20-and-rising`: futures long 2026-10-22 at 3265.0 → 2026-11-23 (open at end) 13.913 %
- `10d-T20-or-not_falling`: put sold 2026-10-22 at 3265.0 → 2026-11-23 (expiry) 3.908 %
- `10d-T20-or-rising`: put sold 2026-10-22 at 3265.0 → 2026-11-23 (expiry) 3.908 %
- `10d-T20-ratio-not_falling`: put sold 2026-10-22 at 3265.0 → 2026-11-23 (expiry) 3.908 %
- `10d-T20-ratio-rising`: put sold 2026-10-22 at 3265.0 → 2026-11-23 (expiry) 3.908 %
- `2w-T10-and-not_falling`: put sold 2026-10-23 at 3230.8 → 2026-11-23 (expiry) 4.66 %
- `2w-T10-and-rising`: put sold 2026-10-23 at 3230.8 → 2026-11-23 (expiry) 4.66 %
- `2w-T10-or-not_falling`: put sold 2026-10-22 at 3265.0 → 2026-11-23 (expiry) 3.908 %
- `2w-T10-or-rising`: put sold 2026-10-22 at 3265.0 → 2026-11-23 (expiry) 3.908 %
- `2w-T10-ratio-not_falling`: put sold 2026-10-22 at 3265.0 → 2026-11-23 (expiry) 3.908 %
- `2w-T10-ratio-rising`: put sold 2026-10-22 at 3265.0 → 2026-11-23 (expiry) 3.908 %
- `2w-T20-and-not_falling`: put sold 2026-10-23 at 3230.8 → 2026-11-23 (expiry) 4.66 %
- `2w-T20-and-rising`: put sold 2026-10-26 at 3359.0 → 2026-11-23 (expiry) 3.903 %
- `2w-T20-or-not_falling`: put sold 2026-10-22 at 3265.0 → 2026-11-23 (expiry) 3.908 %
- `2w-T20-or-rising`: put sold 2026-10-22 at 3265.0 → 2026-11-23 (expiry) 3.908 %
- `2w-T20-ratio-not_falling`: put sold 2026-10-22 at 3265.0 → 2026-11-23 (expiry) 3.908 %
- `2w-T20-ratio-rising`: put sold 2026-10-22 at 3265.0 → 2026-11-23 (expiry) 3.908 %

### MCX puts sold near 3,700 in mid-Nov: the tree should avoid them

No config traded in this window.


### MCX at 3,700–3,800: the tree should be at base–bull (cut futures, sell calls)

- `10d-T10-or-not_falling`: put sold 2026-11-23 at 3581.6 → 2026-11-23 (open at end) 0.0 %
- `10d-T10-or-rising`: put sold 2026-11-23 at 3581.6 → 2026-11-23 (open at end) 0.0 %
- `10d-T10-ratio-not_falling`: put sold 2026-11-23 at 3581.6 → 2026-11-23 (open at end) 0.0 %
- `10d-T10-ratio-rising`: put sold 2026-11-23 at 3581.6 → 2026-11-23 (open at end) 0.0 %
- `10d-T20-or-not_falling`: put sold 2026-11-23 at 3581.6 → 2026-11-23 (open at end) 0.0 %
- `10d-T20-ratio-not_falling`: put sold 2026-11-23 at 3581.6 → 2026-11-23 (open at end) 0.0 %
- `2w-T10-or-not_falling`: put sold 2026-11-23 at 3581.6 → 2026-11-23 (open at end) 0.0 %
- `2w-T10-or-rising`: put sold 2026-11-23 at 3581.6 → 2026-11-23 (open at end) 0.0 %
- `2w-T10-ratio-not_falling`: put sold 2026-11-23 at 3581.6 → 2026-11-23 (open at end) 0.0 %
- `2w-T10-ratio-rising`: put sold 2026-11-23 at 3581.6 → 2026-11-23 (open at end) 0.0 %
- `2w-T20-or-not_falling`: put sold 2026-11-23 at 3581.6 → 2026-11-23 (open at end) 0.0 %
- `2w-T20-ratio-not_falling`: put sold 2026-11-23 at 3581.6 → 2026-11-23 (open at end) 0.0 %

