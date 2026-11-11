# Brokers in ExchangesDash

How the Brokers views from `abiyani-tools/brokersdashboard` reach the dashboard, and the rules a
Brokers pull request follows. Read the repository's `CLAUDE.md` too.

## How changes flow

1. Fork `sucaanalytics-max/ExchangesDash`, branch from `main`, and open a pull request against
   `main`. Use one PR per change, and keep it small enough to review.
2. CI runs `checks.yml` (unit tests, the dashboard JS load check, take-rate and expiry checks).
   Vercel previews of fork PRs wait for the owner to authorise them in Vercel.
3. The owner reviews and merges. Nothing reaches the live dashboard before that. A merge deploys
   on Vercel by itself, because human commits build; only the bots' data commits are skipped.
4. Never edit `dashboard/data/*.json` or `data/*.json`: the bots rewrite them on `main` every few
   minutes.

The engine, its Supabase project (`everjfpbnlbcpuarnhob`) and its daily job stay in
`abiyani-tools/brokersdashboard`. ExchangesDash only shows the results and copies the tables
(see "Data" below).

## The Exchanges | Brokers switch

The sidebar has an **Exchanges | Brokers | MTF** switch (MTF is the exchanges' margin trading books,
`js/40-mtf.js`, registered the same way with `registerModeView('mtf', …)`; it does not affect broker
views). In Brokers mode, a pill of brokers replaces the
NSE/BSE/MCX pill, and the exchange-only header parts are hidden: the revenue banner, the Fees
toggle, the Report/Mobile buttons and the phone "At a glance" view. The Brokers button stays hidden
until at least one broker view registers.

A broker view is a classic script that registers itself when it loads:

```js
// dashboard/js/30-brokers.js
registerBrokerView({
  id: 'angel',                          // [a-z0-9-]+, unique
  label: 'Angel One',                   // pill button, header badge, sidebar logo
  tabs: [                               // sidebar tabs; icon is a NAV_ICONS key (revenue, prediction, temporal, share, advanced)
    { id: 'summary', label: 'Summary', icon: 'revenue' },
    { id: 'pat', label: 'PAT Predictor', icon: 'prediction' },
  ],
  titles: { summary: 'Angel One: Revenue Summary' },   // optional; default "<label>: <tab label>"
  load: async owns => { /* fetch('/api/brokers?...'); once owns() is false, touch nothing */ },
  build: () => { brokerSection('angel', 'summary').innerHTML = '…'; },
  onShow: tab => { /* optional: tab 'summary' or 'pat' is now visible; resize or redraw its charts */ },
  meta: () => ({ quarter: 'Q3 FY 2027', updated: '30 Oct 2026' }),   // optional: header text
});
```

The shell lives in `dashboard/js/00-core.js` ("BROKERS MODE"). It handles the rest:
- It creates one `<section class="tab-content">` per tab, `brokerSection(id, tab)` returns it, and
  the view needs no markup in `index.html`.
- It shows the loading overlay while `load()` runs. If `load()` or `build()` throws, it shows
  Retry and "Back to …". A switch made while a view is still loading wins: `owns()` turns false.
- Charts put in the shared `charts` object (key them `brk-<id>-…`) are destroyed when the viewer
  switches away, and resized when a tab is shown.

## Rules for a Brokers PR

- **Files:** new code goes in new files, named so they load after the exchange tabs and before
  `99-init.js`: `dashboard/js/30-brokers.js`, `31-brokers-price.js`, … `33-brokers-pat.js`, `34-brokers-valuation.js`. Each needs its
  `<script src="./js/NN-….js"></script>` tag in `index.html`, in name order. Styles go in a
  separate CSS file linked from `index.html`. No changes to `00-core.js`/`01-data.js` should be
  needed; if one is, explain it in the PR.
- **Classic scripts, one global scope:** no modules, no build step, no Next.js. Two files may not
  declare the same top-level name, so prefix yours (`brk…`, `BRK_…`). Top-level code may only use
  what earlier files declare. `tests/test_dashboard_js.py` checks all of this.
- **Data access:** read through a serverless proxy, `dashboard/api/brokers.js`, with the
  publishable key from the Vercel environment variable `BROKERS_SUPABASE_KEY`. Never put a key in
  the browser code. Set `Cache-Control` (`s-maxage`) **identically** in the function and in
  `dashboard/vercel.json`, and never add cache-busting query parameters to `/api/*` URLs.
- **Numbers:** the front end shows what the engine published (`sb_summary_cells`,
  `sb_daily_revenue`, `sb_calibration`). It never re-computes ADR. One exception: when the reader
  edits the PAT Predictor's inputs (QoQ ADR growth, P/E, discount rates), `patRecompute` in
  `33-brokers-pat.js` re-runs the engine's PAT recompute (a port of its `src/engine/pat_kit.py`)
  from the kit rows the engine publishes in `sb_pat_lines`, and the Valuation tab re-weights its ADR
  method with it; at the defaults it must reproduce the published lines (checked on load), and
  `tests/test_broker_pat.py` runs it on the engine's vectors (`tests/fixtures/pat_vectors_*.json`). The summary view also returns each
  panel's last data day (`through`); the run bar shows MTF's, and a panel whose data ends before the
  run's as-of date is flagged (the engine has published runs whose MTF stopped days early). Use the Indian FY (Apr–Mar),
  ₹ Cr, and `quarterSortKey` to sort quarters.
- **Checks before opening the PR:**
  - `python3 -m unittest discover -s tests`
  - `for f in dashboard/js/*.js; do node -e "new (require('vm').Script)(require('fs').readFileSync('$f','utf8'))" || echo "$f"; done`
  - a look at the page at 1440 px and 390 px (serve `dashboard/` with `python3 -m http.server`;
    `/api/*` needs stubbing locally).
- **Schema changes:** tell the owner before changing an `sb_*` table's columns or adding a table.
  The copy in our lake (below) needs the same change.

## Data: MTF

Exchange-wide margin trading (MTF) books are published daily, without a key, at
`https://raw.githubusercontent.com/sucaanalytics-max/ExchangesDash/main/dashboard/data/mtf_daily.json`:
`nse` (opening, fresh, liquidated, closing book per reporting date), `bse` (amount financed) and
`combined` (their sum, on dates both published), in ₹ Cr. `mtf_stocks_latest.json` has the latest day
per security. Rows are keyed on the reporting date; each exchange publishes a day the next trading
day, so the latest date trails the exchange data by one session.

`nse_mtf_daily.json`, beside it, is NSE's closing book alone in the shape the engine's
`src/live/refresh_market.py` already reads for `mtf_industry/book_cr`: `{"daily": [{"date", "book_cr"}]}`.
It is the same figure as `codex_public_nse_mtf_daily.closing_outstanding_cr` (it matches the engine's four
check values), needs no key, and has every NSE reporting date the pipeline holds (back to April 2021 once the backfill has run). Until
it existed the engine's industry book stopped at 19 Oct 2026 (the view answered 401 to its key), so
Angel One's and Motilal Oswal's MTF, and with them Consolidated ADR and the Price tab's latest close,
stopped there too. If the engine reads the view again: new-style keys (`sb_publishable_…`) go in the
`apikey` header only; sent as `Authorization: Bearer`, a key that is not a JWT is refused.

## Data: one lake

The dashboard reads the broker results from the brokers-dashboard project through
`/api/brokers`. Separately, `scripts/brokers_mirror.py` (workflow `brokers-mirror.yml`, weekdays
at 15:02 and 23:32 UTC, started by Vercel Cron; the engine's job is due at 14:17 UTC but runs on
GitHub's schedule, which is often hours late) copies the `sb_*` tables that the publishable key
can read into the ExchangesDash Supabase project (NSE-BSE), with the same names and columns.
`brokers_mirror_schema.sql` defines the copies. Their schema endpoint refuses the publishable key,
so `--emit-ddl` cannot generate that file; it comes from the brokers team's catalog (#36, 3 Nov
2026: 8 tables; `sb_pat_lines`, the PAT model's output, from their 5 Nov 2026 migration, created there on
6 Nov and here on 7 Nov; `sb_valuation_lines`, the valuation's output, defined on #75, created there on 9 Nov
and here on 10 Nov). Create a new table's copy
only once the table exists on their side: the mirror copies every `sb_*` table that exists here, and one
their side lacks fails every run. The copies keep their columns, types and primary keys, but not their foreign keys
or CHECK constraints, because the mirror loads tables in name order.

- Each run copies only what changed. A table whose primary key includes `run_id` (`sb_calibration`,
  `sb_daily_revenue`, `sb_summary_cells`, `sb_pat_lines`, `sb_valuation_lines`)
  reads only the runs our `sb_runs` lacks or holds in a different state (one that has finished since),
  plus each broker and mode's latest successful run on either side, and upserts only rows that differ
  from the copy. This relies on how the engine writes: `src/live/publish.py` inserts a run's
  calibration, daily and summary rows before marking it `success` and never touches them after, while
  `run_pat.py` upserts `sb_pat_lines` / `sb_valuation_lines` into the latest successful live run after
  it has finished, and again on a later day while no newer run exists. If the engine ever rewrites an
  older run, or deletes rows inside a run, tell the ExchangesDash owner: the copy would need a full
  resync. A run deleted from `sb_runs` there is deleted from every copy here (at most 20 % of the runs
  at once).
- `sb_runs` is copied whole, after the run-keyed tables, and records which runs are copied: when one
  run-keyed table fails, new runs stay out of it and are read again on the next run. `sb_brokers`,
  `sb_calendar`, `sb_broker_daily` and `sb_share_prices` are copied whole each run.
- A full resync (`brokers-mirror.yml` run by hand with mode `full`, or `brokers_mirror.py --full`)
  re-reads and re-upserts every row of every table.
- A column change on the brokers side makes that table's copy stop with an error until the copy's
  definition is updated.
- While their schema endpoint is closed, a new table on their side is not detected. The brokers
  team announces new tables on the PR, and the copy's definition is added to
  `brokers_mirror_schema.sql`.
