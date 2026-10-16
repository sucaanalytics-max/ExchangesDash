# CLAUDE.md

Exchange revenue analytics for NSE, BSE and MCX: Python pipelines on GitHub Actions write JSON that a static dashboard on Vercel reads. Remediation plan and audit findings: see the "Exchange Analytics — Audit Findings and Remediation Plan" doc (phases 0–5).

## Data flow

| Writer | Schedule | Reads | Writes |
|---|---|---|---|
| `scripts/nse_pipeline.py`, `bse_pipeline.py` | `exchange-update.yml`, 00:30 / 12:30 / 15:30 UTC Mon–Fri | NSE/BSE archive APIs (curl_cffi) | Supabase `nse_daily` / `bse_daily` (+ aggregates), `dashboard/data/{nse,bse}_{dashboard,enriched}_data.json`, copies in `data/` |
| `scripts/mcx_pipeline.py` | same workflow | **separate** Supabase project `mcx_daily_revenue`, written by the `sucaanalytics-max/mcx-vercel` repo | `dashboard/data/mcx_*` |
| `scripts/*_share_analysis.py` | after each daily job | yfinance, screener.in fallback | `dashboard/data/*_share_analysis.json` (OLS price vs revenue MA) |
| `scripts/*_live_poller.py` + `live_common.py` | `*-live.yml`, dispatched every 5 min by an external cron via `dashboard/api/trigger-live-polls.js`; no-op outside Mon–Fri 08:55–16:30 IST | NSE/BSE live turnover, yfinance quote | `dashboard/data/*_live.json`, `*_live_hourly.json`, `*_hourly_history.json` (committed to `main`) |
| `scripts/excel_sync.py` | after daily jobs | Supabase | OneDrive Excel (append-only) |

Dashboard: `dashboard/index.html` + `app.js` (vanilla JS, Chart.js) + `style.css`. Serverless: `dashboard/api/live.js` (proxies live JSON from GitHub raw, so live commits need no deploy), `revenue.js` (direct NSE/BSE scrape), `trigger-live-polls.js`. Vercel project root is `dashboard/`, so its config is `dashboard/vercel.json`; its `ignoreCommand` (`vercel-ignore-build.sh`) skips builds for live-only commits.

## Business rules

- Indian FY runs Apr–Mar; labels look like `Q3 FY 2027` (Oct–Dec 2026). Sort quarters with `quarter_sort_key` (Python) / `quarterSortKey` (JS), never by label text.
- Take rates live only in `scripts/take_rates.py`; `dashboard/api/revenue.js` keeps a JS copy checked by `scripts/check_take_rates.py`.
- Live samples are keyed on the exchange's trade date, never the wall clock; EOD is 16:00 IST (SEBI closing auction).
- Expiry weekday changed over time (NSE Thu→Tue Sep 2025; BSE Fri→Tue→Thu). Code still hardcodes the current weekday — Phase 1 replaces this with a dated calendar.
- Timestamps written by pollers are UTC with a `Z` suffix.

## Working here efficiently

- Do not read `dashboard/data/*.json` or `data/*.json` whole (up to 760 KB each). Query them: `python3 -I -c "import json; d=json.load(open('dashboard/data/nse_dashboard_data.json')); print(d.keys())"`.
- `app.js` is ~6,300 lines: grep for the function, then read only that range.
- Most commits are bot data updates. For human history: `git log --invert-grep --grep='📡' --grep='📈' --grep='📊'`.
- Never edit committed live/data JSON by hand on a branch: bots rewrite those files on `main` every few minutes. Fix the generating code instead.

## Verify before pushing

- `python3 scripts/check_take_rates.py`
- `python3 -m pyflakes scripts/<changed>.py`
- `node -e "new (require('vm').Script)(require('fs').readFileSync('dashboard/app.js','utf8'))"`
- UI changes: serve `dashboard/` with `python3 -m http.server` and check in Playwright (Chromium at `/opt/pw-browsers`) at 1440 and 390 px; `/api/*` must be stubbed locally.
