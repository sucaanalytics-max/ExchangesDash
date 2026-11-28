# Analyst access: data, tools, rules

This is for people who backtest and build models on the Exchanges, Brokers and MTF data. It covers where each dataset lives, how to read it so it matches the dashboard to the rupee, and the rules a backtest must follow.

## 1. Where each dataset is current

The pipelines (GitHub Actions) commit their output to this repository several times a day, and the bots update `main` every few minutes. **Use the files on `main` as the source of truth.** Supabase holds some of the same data, plus things the repo doesn't have.

| Data | Use | Updated | Don't use |
|---|---|---|---|
| NSE, BSE and MCX daily turnover, contracts and revenue; monthly / quarterly / weekly; NSE P&L | `analyst` loader (`nse_daily`, …) | after each daily run (00:30 / 12:30 / 15:30 UTC); MCX's previous session lands at 07:15 IST | |
| NSE vs MCX commodity derivatives | loader (`nse_commodity_*`) | each MCX run | |
| MTF book (NSE, BSE, combined), per stock, brokers' books | loader (`mtf_*`) | each run, plus 00:45 IST | Supabase `mtf.*`: a Sep 2026 snapshot, not granted |
| Participant-wise data (NSE, BSE, NSDL, Market Pulse) | loader (`participants_*`) | each run | |
| India VIX daily closes, last 10 years (with the window's mean, sample σ and the latest z) | loader (`india_vix_history`) | each NSE run (00:30 / 12:30 / 15:30 UTC), rewritten only when a close changes | |
| Share-price regressions | loader (`*_share_series`, `*_share_revenue`) | after each daily job | |
| 5-minute bars (21 capital-market stocks, Nifty, Bank Nifty, VIX) | loader (`intraday_5m`) | 17:17 IST, Mon–Fri | |
| NSE F&O history for BSE and MCX stock options | loader (`options:BSE`, `options:MCX`) | 19:00 IST, Mon–Fri | lands on `main` with PR #134 |
| **Brokers** (the Brokers tab: calibration, daily revenue, PAT and valuation lines, summary cells, share prices) | Supabase NSE-BSE project, `sb_*` tables | mirrored at 20:32 and 05:02 IST, Mon–Fri | |
| NSE and BSE daily rows and aggregates in SQL (same rows as the loader's `nse_daily` / `bse_daily`, at today's rates; Muhurat and DR-test days included, the loader lists them under `special_sessions`) | Supabase NSE-BSE, `nse_daily`, `bse_daily`, `nse_aggregates`, `bse_aggregates` | written by each daily run since 25 Nov 2026 (the run reads them back to build the JSON, so the two match row for row) | if they ever disagree, the loader wins |
| Broker research library, consensus | Supabase NSE-BSE, `rl_*`, `broker_*`, `argus.*` | as their jobs run | |
| MCX raw: bhavcopy per commodity, revenue as reported, margins, OI participants, iCOMDEX | Supabase OctoTusk + MCX, `mcx_*` | 05:30–07:00 IST each morning | |
| `codex_*` tables | an external job, **not reconciled** with this repo | | don't use as a source of truth |

The dashboard: https://exchangesdash.vercel.app

## 2. Setup

```bash
gh repo fork sucaanalytics-max/ExchangesDash --clone   # or: git clone https://github.com/sucaanalytics-max/ExchangesDash
cd ExchangesDash
python3 -m analyst list                                # every dataset
python3 -m analyst check                               # loads them all from GitHub at the latest commit
```

The loader uses only Python's standard library. `.to_frame()` needs `pandas`.

### Claude Code
Open the clone in Claude Code. It reads `CLAUDE.md`: the data flow, the business rules and the verification steps. It also loads the repo's skills in `.claude/skills/` (`results-day`, `broker-mtf`). `.claude/settings.json` stops Claude reading the large generated JSON whole; ask it to query them, or use the loader.

### Proposing changes
The repository is public, so you need no invite: fork it and work on a branch of your fork (you can't push to this repository itself), run the checks in `CLAUDE.md` ("Verify before pushing"), and open a PR to `main`. `checks.yml` runs the tests on it, and Jay reviews and merges. Never edit committed `dashboard/data/*.json` or `data/*` by hand: the bots rewrite them, so fix the generating script instead.

## 3. The loader

```python
import analyst

snap = analyst.snapshot()                      # latest main, pinned to ONE commit
nse  = snap.load("nse_daily")                  # Dataset
mtf  = snap.load("mtf_combined")               # same commit as nse
df   = nse.to_frame()                          # pandas; df.attrs["meta"] keeps the provenance
nse.meta    # commit, committed_at, path, rows, first_date, last_date, updated_at, caveats
nse.raw     # the whole file: fits, notes, fee rules, `unavailable` lists …

# Point in time: the data as it stood at 23:59:59 IST that day (needs a clone)
past = analyst.snapshot("2026-06-30", source="local")   # fetches origin/main first
past.load("bse_daily").meta["last_date"]

analyst.snapshot(source="local", ref="WORKTREE")         # the files on disk (your branch)
```

The command line does the same:

```bash
python3 -m analyst export mcx_daily mcx.csv
python3 -m analyst check --local --ref 2026-06-30
```

- **One snapshot, one commit.** Load every dataset that feeds one result from the same `snapshot()`. Separate `analyst.load()` calls can land on different commits a few minutes apart.
- **Point in time.** Stored history is revised:
  - BSE cash is completed late;
  - NSE republishes MTF days;
  - NSE's cash corrections;
  - MCX lands the next morning;
  - reported P&L quarters replace forecasts.
  
  A date `ref` gives you what was known then. It follows `main`'s first-parent line, so a PR branch merged later never leaks in. The GitHub source refuses date refs for that reason; use `source="local"`.
- **Nothing is filtered.** Caveat columns (`modelled`, `fee_basis`, MTF `flags`, nulls) stay in the rows, and `meta["caveats"]` says which apply. Filtering is your decision, and should be written down.
- **Rate limits.** `source="github"` resolves the commit through the GitHub API: 60 calls an hour without a token. Set `GITHUB_TOKEN` to raise it. File reads are not rate-limited.

### Datasets

Units: ₹ Cr unless stated; dates are IST trading dates (`YYYY-MM-DD`); FY is Indian (Apr–Mar, `Q3 FY 2027` = Oct–Dec 2026).

| Dataset | Rows | Key fields |
|---|---|---|
| `nse_daily` | one per trading day from 2023-04-03 | `if_` / `sf_` (index / stock futures) `turnover`, `io_` / `so_` (index / stock options) `notional`, `premium`, `*_contracts`; `*_rev` per product, `fut_rev`, `opt_rev`, `fo_rev`, `cash_traded_value`, `cash_rev`, `total_rev`; `vix`; activity counts `cash_trades`, `cash_securities`, `cash_quantity` (shares) |
| `bse_daily` | one per trading day from 2023-04-03 | `futures_turnover`, `options_notional_turnover`, `options_premium_turnover`, `total_contracts`, `fut_rev`, `opt_rev`, `cash_*`, `total_rev` |
| `mcx_daily` | one per trading day from 2022-01-03 | `fut_rev`, `opt_rev`, `total_rev` (= fut + opt), `total_contracts`, `modelled` |
| `*_special_sessions` | Muhurat / DR-test sessions | the daily fields plus `session`, `session_note` |
| `*_monthly`, `*_quarterly`, `*_weekly` | the same rows summed | `days` (sessions), revenue by segment; MCX: `modelled_days` |
| `nse_daily_eff`, `bse_daily_eff` (+ monthly / quarterly) | as `*_daily`, re-priced at the rule in force each day | `fee_basis`, `fee_basis_by_product` (`flat`, `slab_estimate`, `calibrated`, `calibrated_provisional`) |
| `nse_pnl`, `nse_pnl_fy` | NSE P&L by quarter / FY | `is_predicted` marks the forecast; reported quarters come from results filings |
| `{nse,bse,mcx}_share_series` | price vs the previous session's revenue MA | `price`, `rev_ma`, `revenue_cr`, `price_pred` (null unless the fit holds); `.raw["regression"]`, `["methodology"]` |
| `india_vix_history` | one per India VIX close over the last 10 years (about 2,450) | `date`, `vix` (index points). Yahoo's ^INDIAVIX feed, the same as `nse_daily`'s `vix`, but back 10 years rather than to Apr 2023 (`nse_daily` re-checks only its last 10 days, so an older close Yahoo later revised can differ there). The window (`from`, `to`, `n`, `mean`, sample `sd`, `latest` with `z` and `pct_below`) is in `.meta["window"]` |
| `nse_commodity_daily` (`_monthly`, `_quarterly`) | one per (day, side `nse`/`mcx`, underlying) | `fut_contracts`, `fut_notional_cr`, `opt_contracts`, `opt_notional_cr`, `opt_premium_cr`, `txn_rev_cr` (today's rates), `nse_option_expiry` (null = unknown) |
| `nse_commodity_charges` | NSE commodity charges per day | today's rates / the rule then in force; never part of NSE `total_rev` |
| `mtf_nse` | NSE MTF book per reporting date | `opening_cr`, `fresh_cr`, `liquidated_cr`, `closing_cr`, `securities`, `flags`, `revised` |
| `mtf_bse` | BSE | `amount_financed_cr` (the book), `opening_cr` … `closing_cr`, `flags` |
| `mtf_combined` | NSE closing + BSE amount financed | `nse_cr`, `bse_cr`, `total_cr` (BSE `spike` days left out) |
| `mtf_stocks_nse`, `mtf_stocks_bse` | per security, latest day | `qty_financed`, `amount_lakh` (**₹ lakh**) |
| `mtf_brokers` | brokers' disclosed figures | `as_of`, `measure`, `basis`, `book_cr`, `share_pct`, `industry_cr`, `source`, `url`, `page`, `quote` |
| `mtf_broker_live` | figures read from brokers' web pages (Groww) | `date`, `book_cr`, `quote`, `url` |
| `participants_<source>` (12) | long format: `date`, `table`, `category`, `field`, `value` | as published; units are in `field` (contracts, ₹ Cr, %) |
| `participants_daily`, `participants_monthly` | the Participants tab's views | `view`, `category`, `value`, `share_pct`, `unit` |
| `intraday_5m` | 5-minute bars | `ts` (bar start, IST), `symbol`, OHLC, `volume` |
| `options:<SYMBOL>` | NSE F&O bhavcopy rows | futures, and options of the two nearest expiries within ±25 % |
| `valuation_inputs` | `.raw` only | the shared valuation defaults |

## 4. Supabase (read-only login)

The login is `vatsal_ro`, on two projects. Jay gives you the passwords and the session-pooler host for each project (Supabase → Connect → Session pooler):

| Project | Ref | Holds |
|---|---|---|
| NSE-BSE | `vuswwmczfrlzjoxfvkzu` | `nse_daily`, `bse_daily` (+ `_aggregates`), `sb_*` (Brokers), `rl_*` / `broker_*` / `argus.*` (research library), `codex_*`, `nse_pnl`, valuation inputs |
| OctoTusk + MCX | `avqwpebveqetwwzkmtux` | `mcx_commodity_daily`, `mcx_daily_revenue`, `mcx_margin_daily`, `mcx_oi_participants`, `mcx_icomdex_daily`, prices, the MCX app's tables |

```python
import pandas as pd, sqlalchemy as sa
eng = sa.create_engine("postgresql://vatsal_ro.vuswwmczfrlzjoxfvkzu:<password>@<pooler-host>:5432/postgres")
pd.read_sql("""
    select d.* from sb_daily_revenue d
    where d.run_id = (select run_id from sb_runs
                      where broker_id = 'GROWW' and mode = 'live' and status = 'success'
                      order by finished_at desc limit 1)
    order by d.trade_date, d.segment""", eng)
```

- **Read-only.** Every transaction is read-only, queries stop at 120 s, and you get at most 5 connections. For big pulls, page by date.
- **Brokers.** The brokers team's tables keep **every run**: `sb_runs` lists them, and `sb_calibration`, `sb_daily_revenue`, `sb_summary_cells`, `sb_pat_lines` and `sb_valuation_lines` are keyed by `run_id`. **Filter on one `run_id`**: without it, rows from every run are stacked. Take each broker's latest successful `live` run (`status`, `finished_at`; brokers `ANGELONE`, `GROWW`, `MOSL`), unless you want the history of estimates. Rules for the brokers data: `docs/BROKERS_INTEGRATION.md`.
- **Not available:**
  - `mtf.*` (a Sep 2026 snapshot that nothing keeps current; use the loader's `mtf_*`);
  - `private.*`, `migration_backup.*`;
  - on OctoTusk: `push_subscriptions`, `pin_attempts`, `user_roles`.
  
  Grants are recorded in `analyst_readonly_role.sql`.

## 5. Backtest checklist

These are the rules in `CLAUDE.md` ("Business rules") that change results. Read that section once.

1. **Rates.** Every revenue figure in `*_daily` is at **today's** statutory rates, as on the dashboard. For revenue as actually charged, use `*_eff`. Slab-era periods are flat estimates there:
   - NSE to 2024-09-30;
   - BSE options 2023-11-01 to 2024-09-30.
   
   Every rate is in `scripts/fee_register.py`.
2. **MCX before 2024-09-02 is modelled** (`modelled: true`). Keep it out of YoY, segment-mix comparisons and regressions. Use `total_rev`, never `total_rev_cr`.
3. **Special sessions.** Muhurat and DR-test sessions are not in `*_daily`; keep them out of averages, day counts and weekday figures. Weekend Budget sessions are normal days. MCX's evening-only holiday sessions are normal rows but small (24 Nov 2026: ₹11.9 Cr), and they drag short ADR windows down.
4. **Expiry days.** The weekday changed:
   - NSE: Thu → Tue from 2025-09-01;
   - BSE: Fri → Tue from 2025-01-06, Tue → Thu from 2025-09-01.
   
   A holiday moves expiry to the previous trading day. Use `scripts/expiry_calendar.py` / `live_common.classify_day`; don't re-derive.
5. **Holidays and sessions.** Use `scripts/trading_calendar.py`.
6. **Quarters** sort with `quarter_sort_key`, never by label text.
7. **MTF** rows are keyed on the reporting date and published the next trading day (NSE's late at night, BSE's about two trading days after).
   - NSE revises recent days.
   - BSE's `spike` days are excluded from `combined`.
   - Level breaks are in `mtf_*.raw["notes"]`; compare across them only with care.
   - Brokers' figures compare only within the same `measure` and `basis`.
8. **Null is not zero.** A count an exchange didn't publish is `null`.
9. **No look-ahead.**
   - Fit on sessions before *t* only.
   - A revenue MA for day *t* ends on the previous revenue day.
   - Prices pair with the previous session's revenue.
   - Use a date-`ref` snapshot when revisions matter.
   
   `scripts/signal_tree_backtest.py` follows all of this and is a template.
10. **Unadjusted prices.** `intraday_5m` and `options:*` are as traded. The share-analysis series is split- and dividend-adjusted.

Ask before trusting a figure you can't trace to a file and commit. Every `Dataset.meta` names both.
