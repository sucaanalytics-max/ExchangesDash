# Exchange Analytics

Trading-revenue analytics for NSE, BSE and MCX: daily revenue and averages, P&L and PAT prediction, share-price regressions, valuation models, and a live intraday revenue tracker with an end-of-day forecast. Python jobs on GitHub Actions write JSON that a static dashboard on Vercel reads.

Repository notes for contributors (data flow, business rules, how to verify changes) are in [`CLAUDE.md`](CLAUDE.md).

## How it works

| Job | When | Source | Output |
|---|---|---|---|
| `exchange-update.yml` — NSE, BSE, MCX daily pipelines | 00:30, 12:30, 15:30 UTC, Mon–Fri | NSE/BSE archive APIs; MCX from a separate Supabase project | Supabase daily tables + `dashboard/data/*_dashboard_data.json`, `*_enriched_data.json` |
| Share analysis (same workflow) | after each daily job | yfinance, screener.in fallback | `dashboard/data/*_share_analysis.json` |
| Excel sync (same workflow) | after daily jobs, when `ENABLE_EXCEL_SYNC` is `true` | Supabase | OneDrive workbook |
| `nse-live.yml`, `bse-live.yml`, `mcx-live.yml` | every 5 min via the external cron, Mon–Fri 08:55–16:30 IST only | NSE/BSE live turnover, yfinance quotes | `dashboard/data/*_live.json`, `*_live_hourly.json`, `*_hourly_history.json` |
| `checks.yml` | every human push and pull request | — | take-rate consistency, Python compile, JS parse |

The dashboard reads live data through `/api/live`, which serves the latest committed JSON straight from GitHub, so live-only commits are not deployed (`dashboard/vercel-ignore-build.sh`). The daily bots' data commits are not deployed one by one either: the workflow pushes one empty `[deploy]` commit after the day's last run (15:30 UTC) and after each manual run, and that deploy carries all of the day's data.

## Setup

### 1. GitHub repository secrets and variables

Settings → Secrets and variables → Actions:

| Name | Kind | Used by |
|---|---|---|
| `SUPABASE_URL` | secret | NSE and BSE daily pipelines |
| `SUPABASE_SERVICE_KEY` | secret | NSE and BSE daily pipelines |
| `MCX_SUPABASE_KEY` | secret | MCX pipeline — read key for the separate MCX Supabase project |
| `MSGRAPH_TENANT_ID`, `MSGRAPH_CLIENT_ID`, `MSGRAPH_CLIENT_SECRET`, `ONEDRIVE_USER`, `EXCEL_FILE_PATH` | secrets | Excel sync |
| `ENABLE_EXCEL_SYNC` | variable (`true` / unset) | turns the Excel sync job on |

MCX reads its own Supabase project (written by the `mcx-vercel` automation); `MCX_SUPABASE_URL` overrides the default project URL.

### 2. Vercel project

1. Add New → Project → import this repository.
2. **Root Directory: `dashboard`**. Framework preset: Other. Leave build and output settings empty.
3. Environment variables:
   - `CRON_TRIGGER_SECRET` — a long random string, shared with the external cron.
   - `GITHUB_DISPATCH_PAT` — fine-grained token for this repository only, permission **Actions: read and write**.
   - `GITHUB_READ_PAT` — only needed if the repository is private (Contents: read).
4. Deploy. `dashboard/vercel.json` holds the rewrites, cache headers and ignored-build step.

### 3. External cron

GitHub's own `schedule:` trigger runs these workflows hours late, so an external cron (for example cron-job.org) calls the dashboard every 5 minutes:

```
POST https://<your-vercel-domain>/api/trigger-live-polls
Authorization: Bearer <CRON_TRIGGER_SECRET>
```

Outside Mon–Fri 08:55–16:30 IST the endpoint returns `{"skipped": true}` and dispatches nothing; `?force=1` overrides.

## Running locally

```bash
pip install -r requirements.txt
python scripts/check_take_rates.py
cd dashboard && python3 -m http.server 8000   # /api/* routes need Vercel (vercel dev)
```

Pipelines without Supabase credentials fall back to the committed JSON in `data/` and write local files only.

## Take rates

All revenue is turnover × take rate, defined once in `scripts/take_rates.py` (one-side % × 2):

| | Futures (notional) | Options (premium) | Cash (traded value) |
|---|---|---|---|
| NSE | 0.00183% × 2 | 0.03553% × 2 | 0.00307% × 2 |
| BSE | — | 0.03250% × 2 | 0.00375% × 2 |

`dashboard/api/revenue.js` carries a JS copy; `scripts/check_take_rates.py` fails CI if they differ.
