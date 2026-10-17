# CLAUDE.md

Exchange revenue analytics for NSE, BSE and MCX: Python pipelines on GitHub Actions write JSON that a static dashboard on Vercel reads. Remediation plan and audit findings: see the "Exchange Analytics — Audit Findings and Remediation Plan" doc (phases 0–5).

## Data flow

| Writer | Schedule | Reads | Writes |
|---|---|---|---|
| `scripts/nse_pipeline.py`, `bse_pipeline.py` | `exchange-update.yml`, 00:30 / 12:30 / 15:30 UTC Mon–Fri | NSE/BSE archive APIs (curl_cffi) | Supabase `nse_daily` / `bse_daily` (+ aggregates), `dashboard/data/{nse,bse}_{dashboard,enriched}_data.json` (copies in `data/`) and `…_data_eff.json` |
| `scripts/mcx_pipeline.py` | same workflow | **separate** Supabase project `mcx_daily_revenue`, written by the `sucaanalytics-max/mcx-vercel` repo | `dashboard/data/mcx_*` |
| `scripts/*_share_analysis.py` | after each daily job | yfinance, screener.in fallback | `dashboard/data/*_share_analysis.json`: price vs the previous session's revenue MA, fitted by `scripts/share_regression.py` |
| `scripts/*_live_poller.py` + `live_common.py` | `*-live.yml`, dispatched every 5 min by an external cron via `dashboard/api/trigger-live-polls.js`; no-op outside Mon–Fri 08:55–16:30 IST | NSE/BSE live turnover, yfinance quote | `dashboard/data/*_live.json`, `*_live_hourly.json`, `*_hourly_history.json` (committed to `main`) |
| `scripts/excel_sync.py` | after daily jobs | Supabase | OneDrive Excel (append-only) |

Dashboard: `dashboard/index.html` + `app.js` (vanilla JS, Chart.js) + `style.css`. Serverless: `dashboard/api/live.js` (proxies live JSON from GitHub raw, so live commits need no deploy), `revenue.js` (direct NSE/BSE scrape), `trigger-live-polls.js`. Vercel project root is `dashboard/`, so its config is `dashboard/vercel.json`; its `ignoreCommand` (`vercel-ignore-build.sh`) skips builds for live-only commits.

## Business rules

- Indian FY runs Apr–Mar; labels look like `Q3 FY 2027` (Oct–Dec 2026). Sort quarters with `quarter_sort_key` (Python) / `quarterSortKey` (JS), never by label text.
- Every fee rate lives only in `scripts/fee_register.py`: effective-dated rules (₹/Cr per side; revenue = 2 × rate × turnover; futures on notional, options on premium, cash on traded value; IPFT excluded), each with a basis (`flat`, `slab_estimate`, `calibrated`, `calibrated_provisional`) and source (circular or results filing). `scripts/take_rates.py` derives today's statutory constants from it; `dashboard/api/revenue.js` keeps a JS copy checked by `scripts/check_take_rates.py`, which also validates the register. BSE cash is under-billed by the statutory 375 (special-rate scrip groups pay more), so the date-effective variant uses per-quarter rates calibrated to BSE's reported cash transaction income: when BSE reports a quarter, add its row to `BSE_CASH_CALIBRATED_QUARTERS` and recompute `BSE_CASH_PROVISIONAL_RATE`.
- NSE/BSE JSON comes in two variants. `{nse,bse}_{dashboard,enriched}_data.json` price every day at today's statutory rates (the same rows Supabase holds). `…_data_eff.json` re-price each day at the rules then in force (the default dashboard view): same schema plus `fee_basis` / `fee_basis_by_product` on each daily row and quarterly/monthly/weekly period, and top-level `fee_mode: "date_effective"` and `fee_rules`. Slab-era periods (NSE to 2024-09-30, BSE options 2023-11-01–2024-09-30) are flat estimates and must be labelled as such.
- MCX rows before 2024-09-02 are modelled (`mcx_historical_backfill`, `is_actual = false`: scaled to reported quarters, derived options split). They carry `modelled: true` (`modelled_days` per period) and must stay out of YoY, segment-mix comparisons and regressions. MCX `total_rev` is fut + opt; `total_rev_cr` is never used (it adds ₹0.95 Cr/day of non-transaction revenue to modelled rows).
- Live samples are keyed on the exchange's trade date, never the wall clock; EOD is 16:00 IST (SEBI closing auction).
- Expiry weekday changed over time (NSE Thu→Tue from 2025-09-01; BSE Fri→Tue from 2025-01-06, Tue→Thu from 2025-09-01); the monthly expiry is the month's last such weekday. The effective-dated rules live only in `scripts/expiry_calendar.py` (used by `live_common.classify_day`); `dashboard/app.js` keeps a JS copy, `EXPIRY_RULES`, checked by `scripts/check_expiry_calendar.py`. A holiday on the scheduled day moves expiry to the previous trading day (handled by the callers, from observed trading dates).
- Timestamps written by pollers are UTC with a `Z` suffix.
- Share-price regressions (`scripts/share_regression.py`; `dashboard/app.js` `computeShareModel` mirrors it for the DMA/lag toggles) pair each close with the revenue MA up to the previous session, computed over every revenue day. They report Newey-West t (bandwidth 1.3·√n), Durbin-Watson and an 80/20 chronological holdout against a "price unchanged" forecast. A fair value (`price_pred`) is published only with n ≥ 60, a positive slope with t ≥ 2 and a revenue MA that moved ≥ 10 %; otherwise it is null and the UI says why. R² is in-sample only.
- Supabase writes from this repo are off unless the repository variable `ENABLE_SUPABASE_WRITES` is `true` (Excel sync: `ENABLE_EXCEL_SYNC`). Keep both off while the old repo `Research-Tusk/nse-cloud-pipeline` still writes the same tables; `scripts/compare_parallel_run.py` checks parity.

## Working here efficiently

- Do not read `dashboard/data/*.json` or `data/*.json` whole (up to ~850 KB each). Query them: `python3 -I -c "import json; d=json.load(open('dashboard/data/nse_dashboard_data.json')); print(d.keys())"`.
- `app.js` is ~7,700 lines: grep for the function, then read only that range.
- Most commits are bot data updates. For human history: `git log --invert-grep --grep='📡' --grep='📈' --grep='📊'`.
- Never edit committed live/data JSON by hand on a branch: bots rewrite those files on `main` every few minutes. Fix the generating code instead.

## Verify before pushing

- `python3 -m unittest discover -s tests` (tiny fixtures; also checks the app.js mirrors in Node)
- `python3 scripts/check_take_rates.py`
- `python3 scripts/check_expiry_calendar.py`
- `python3 -m pyflakes scripts/<changed>.py`
- `node -e "new (require('vm').Script)(require('fs').readFileSync('dashboard/app.js','utf8'))"`
- UI changes: serve `dashboard/` with `python3 -m http.server` and check in Playwright (Chromium at `/opt/pw-browsers`) at 1440 and 390 px; `/api/*` must be stubbed locally.
