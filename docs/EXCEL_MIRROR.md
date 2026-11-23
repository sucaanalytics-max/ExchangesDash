# Excel mirror

`scripts/excel_mirror.py` writes the web dashboard's valuation inputs, its valuation results and its data into four workbooks in the **OneDrive of the "Tusk Invest" account**, so the workbooks become outputs of the dashboard:

| Target key | Workbook | What is written |
|---|---|---|
| `nse_vf`, `bse_vf`, `mcx_vf` | the house vF valuation files (`20250809_NSE vF.xlsx`, `20260718_BSE VF.xlsx`, `20250827_MCX vF.xlsx`) | the P/E and discount input cells on `Tusk - Summary` (label-checked first), and a `Web Dashboard` sheet of inputs and results. Model sheets are never touched. |
| `dashboard` | the Exchanges Dashboard workbook (`20261027_Exchanges_Dashboard.xlsx`) | plain-value `WD_*` feed sheets. Its analysis sheets are repointed once to read from them. |

It runs:

- **daily at 01:00 IST** (19:30 UTC). Vercel Cron dispatches `.github/workflows/excel-mirror.yml` through `dashboard/api/trigger-scheduled.js`. The workflow's own `schedule:` is GitHub's late fallback. Its `gate` job skips that late run when a scheduled run already finished (success or partial) in the last 20 hours, so there is one daily run. Dispatched runs are never gated.
- **on demand**, from the **Refresh Excel now** button in the Excel sync panel at the foot of the Valuation Model tab (`dashboard/js/23-excel-sync.js`). The button is shown only to a team member signed in for the shared inputs. It calls `POST /api/excel-refresh` (`dashboard/api/excel-refresh.js`), which records a queued run and dispatches the workflow with that run's id.

Each run, scheduled or manual, writes the latest **saved** shared inputs. Saving an input on the dashboard does not write to Excel by itself.

## How a run works

1. **Inputs.** The shared overrides are read from Supabase `valuation_inputs`, the same rows `/api/valuation-inputs` serves. If Supabase does not answer, the run fails and nothing is written: it never falls back to the defaults silently.
2. **Results.** `scripts/valuation_outputs.py` computes each exchange's Valuation Model with the dashboard's own JS functions, run in Node through `scripts/dashboard_js.py`, so the Excel figures equal the web figures. It reads:
   - `dashboard/data/{ex}_dashboard_data.json`, the at-today's-rates file the tab uses
   - `{ex}_share_analysis.json`, whose latest close is the CMP (the job sees no live quote)
   - `valuation_inputs.json` (the defaults), with the shared overrides on top
3. **Writes.** Each target is written through the Excel REST API inside a persistent workbook session (`createSession` with `persistChanges: true`, then `closeSession`). Writes go range by range, so:
   - a workbook open in Excel receives them
   - formulas elsewhere are never replaced

   Safeguards:
   - **Identity check.** Each vF file's `Tusk - Summary!B2` must name its exchange (`National Stock Exchange (NSE)`, `BSE`, `MCX`). BSE's and MCX's labels are otherwise identical, so this catches swapped target ids. On a mismatch nothing is written to that file, and it is `failed`.
   - **Only its own sheets.** A `Web Dashboard` or `WD_*` sheet is written only when it is new, empty, or its `A1` holds the job's stamp ("Written by ExchangesDash …"). Any other sheet of that name is left alone, with an error for that sheet (the file is `partial`).
   - **Never a blank sheet.** The new rows are written over the old first. Only then is the area beyond them (rows below, columns to the right) cleared. A run that fails part-way leaves the previous values, not a blank sheet.
   - **Text stays text.** A text value starting with `=` (or `+`, `-`, `@` when not a number) is written with a leading apostrophe.

   Graph limits and failures:
   - Large tables are written in chunks of whole rows, at most 4,000 cells and about 1 MB per request.
   - Graph's 429 / 503 / 504 answers are retried after `Retry-After`, or with exponential backoff, up to 5 tries.
   - `createSession` waits up to 180 s and is not retried after a read timeout, since the session may have been created; any session id received is closed.
   - A 423 lock fails that file only; the other files are still written. A 409 on adding a sheet (an add applied, then retried) re-reads the sheet names and carries on.
4. **Log.** The run is recorded in Supabase `excel_sync_runs` (`valuation_sync_schema.sql`):
   - A manual run's row (created by the API) goes `queued` → `running` → `success` / `partial` / `failed`.
   - A scheduled run inserts its own row.
   - `files` holds one entry per target: `target`, `status` (`success`, `partial`, `failed` or `skipped`), `cells`, `sheets`, `errors`, `duration_s`, `dry_run`, the resolved `item` ids, and for vF files `inputs_written` (true only when every input cell was written; the panel's tooltip shows it).
   - `github_run_id` links the run to the Actions log.
   - **No row stays open.** The mirror job's last step runs `if: always()` (`--finalize`) and closes the row as `failed` if the job died, timed out or was cancelled before recording a result.
   - GitHub keeps one running and at most one pending run per concurrency group. A newer pending run cancels the older, whose job then never starts. `GET /api/excel-refresh` closes any run still `queued` or `running` 45 minutes after it was requested.

   Run status:
   - **success**: every configured file succeeded
   - **failed**: none was written
   - **partial**: anything in between. This includes a vF file whose label check skipped its input cells while its `Web Dashboard` sheet was written, a sheet left alone because the job did not write it, and a `closeSession` that failed.

## One-time setup

### 1. Microsoft Graph access (M365 admin)

The four files live in the **OneDrive of the "Tusk Invest" account**. Its folder links look like `https://tuskinvest-my.sharepoint.com/:f:/p/tuskinvest/…`, and they are not in a SharePoint site library.

The mirror uses an app registration with the client-credentials flow, as `scripts/excel_sync.py` does. The admin has granted it both of these:

- **`Files.ReadWrite.All`** (application, admin consent). This is what reaches a user's OneDrive (`/users/{upn}/drive`).
- **`Sites.Selected`**, with a write grant on a site:

  ```
  POST https://graph.microsoft.com/v1.0/sites/{site-id}/permissions
  {"roles": ["write"], "grantedToIdentities": [{"application": {"id": "<client id>", "displayName": "ExchangesDash Excel mirror"}}]}
  ```

  This grant applies only if the files move to a SharePoint site library. It is not needed for the OneDrive files.

The app also needs a client secret.

**App-only Excel REST.** Microsoft's v1.0 pages for the workbook APIs (`createSession`, ranges, worksheets) list "Application: Not supported", although app-only calls are known to work on OneDrive for Business and SharePoint files. `--check` therefore opens and closes a session that saves nothing (`persistChanges: false`) on every file before anything is written, and reports `session OK` or `REFUSED …` per file.

If the workbook calls are refused, the fallbacks are not implemented. The options are:

1. **Download, edit, upload.** `scripts/excel_sync.py` already downloads the file, edits it with openpyxl and uploads it with `If-Match` on the eTag. The same approach could write the vF input cells and the `Web Dashboard` / `WD_*` sheets. The costs:
   - a workbook open in Excel conflicts with the upload, so the run must retry later and must not overwrite
   - openpyxl drops some features (charts, pivot caches, external-link values) on save, so test this on copies first
2. **Delegated auth.** A service account signs in once (device-code flow), and the job keeps its refresh token as a secret. Excel REST is then supported as documented, but the token needs care: it expires after inactivity, and a password change or MFA can revoke it.

### 2. GitHub (repository settings → Secrets and variables → Actions)

| Kind | Name | Value |
|---|---|---|
| secret | `MSGRAPH_TENANT_ID`, `MSGRAPH_CLIENT_ID`, `MSGRAPH_CLIENT_SECRET` | the app above. These are shared with `excel_sync.py`; if the mirror uses its own app, these are its values. |
| secret | `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | the ExchangesDash Supabase project and its service-role key. The workflow passes the key as `SUPABASE_KEY`. |
| variable | `EXCEL_TARGETS` | the four real files (see below) |
| variable | `EXCEL_TARGETS_DRYRUN` | copies of the four files in a test folder. **It must never point at the real files**: dry runs write even while `ENABLE_EXCEL_MIRROR` is off. |
| variable | `ENABLE_EXCEL_MIRROR` | `true` to write the real files. Leave it unset until the dry run has been checked. |

### 3. Vercel (project env)

- `GITHUB_DISPATCH_PAT`, already used by the cron triggers: Actions write on this repo
- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
- `TEAM_SESSION_SECRET`, from the shared-inputs sign-in

Without Supabase or the PAT, `/api/excel-refresh` answers 503 and the panel says "Not configured".

### 4. Fill `EXCEL_TARGETS`

`EXCEL_TARGETS` (and `EXCEL_TARGETS_DRYRUN`) is JSON with one entry per target. Each entry takes one of three forms:

| Form | Looked up at | Use |
|---|---|---|
| `{"drive_id": "b!…", "item_id": "01…"}` | `/drives/{drive_id}/items/{item_id}` | pinned: the final form |
| `{"user": "<upn>", "path": "/folder/file.xlsx"}` | `/users/{upn}/drive/root:{path}` | a file in a user's OneDrive (these files) |
| `{"drive_id": "b!…", "path": "/folder/file.xlsx"}` | `/drives/{drive_id}/root:{path}` | a file in any drive, such as a SharePoint library |

Example:

```json
{
  "nse_vf":    {"user": "tuskinvest@<tenant domain>", "path": "/Portfolio Stock Valuations - Bull Base Bear (Tusk Prop)/20250809_NSE vF.xlsx"},
  "bse_vf":    {"drive_id": "b!…", "item_id": "01…"},
  "mcx_vf":    {"user": "tuskinvest@<tenant domain>", "path": "/Portfolio Stock Valuations - Bull Base Bear (Tusk Prop)/20250827_MCX vF.xlsx"},
  "dashboard": {"user": "tuskinvest@<tenant domain>", "path": "/Direct Equity/Exchanges-capital markets plays/Dashboard/20261027_Exchanges_Dashboard.xlsx"}
}
```

**Finding the UPN and path.** Open the file's folder in OneDrive on the web. The address reads `https://tuskinvest-my.sharepoint.com/personal/<upn with _ for @ and .>/Documents/<path>`:

- `/personal/tuskinvest_example_com/` stands for `tuskinvest@example.com`.
- The path is everything after `/Documents`, URL-decoded.

The `/:f:/p/tuskinvest/…` sharing links redirect to that address.

**Finding drive ids.** Either of these works:

- Let `--check` print them (below).
- Run `GET /users/{upn}/drive?$select=id` (OneDrive) or `GET /sites/{site-id}/drives` (SharePoint) in Graph Explorer.

**Steps:**

1. Start with `user` + `path` entries.
2. Run the workflow by hand with **check_only** ticked: `python scripts/excel_mirror.py --check`, or add `--dry-run` for the test copies. It writes nothing. For each target it prints:
   - the file name and its `drive_id / item_id` (a path entry also prints `pin as {"drive_id": …, "item_id": …}`)
   - the number of sheets
   - whether `Web Dashboard` / `WD_*` exist yet, and any of them the job did not write (`NOT OURS, will be skipped`)
   - the identity and label checks
   - whether a session opens (`OK` or `REFUSED`, see "App-only Excel REST" above)
3. When every row passes, replace each path entry with its printed ids. Ids survive renames and moves; a "Save as" copy is a new item and needs its new id.

A target left out of `EXCEL_TARGETS` is recorded as `skipped`.

## Dry run, then go live

1. Copy the four files into a test folder, and put their ids in `EXCEL_TARGETS_DRYRUN`. Check twice that every id is a copy's: **a dry run writes even while `ENABLE_EXCEL_MIRROR` is off**, so this variable must never point at the real files. Run `--check --dry-run` first: it prints each file's name and folder.
2. Run the workflow with **dry_run** ticked. It writes the copies, and the run appears in the panel with "dry run".
3. Check, on the copies:
   - the `Tusk - Summary` input cells
   - the `Web Dashboard` sheets against the Valuation Model tab
   - the `WD_*` sheets against the web dashboard
   - that formulas elsewhere are untouched
   - that a copy left open in Excel during the run receives the writes
4. Repoint the Exchanges Dashboard workbook's analysis sheets to the `WD_*` sheets, on a copy first.
5. Set `ENABLE_EXCEL_MIRROR` to `true`. The next 01:00 IST run, or a press of Refresh Excel now, writes the real files.

While `ENABLE_EXCEL_MIRROR` is not `true`, a normal run writes nothing. A manual run's row is then closed as `failed` ("switched off"), so the panel does not wait on it.

## vF input cells (`Tusk - Summary`)

These were confirmed on copies of the three files on 23 Nov 2026. The declarative table is `VF_INPUT_CELLS` in `scripts/excel_mirror.py`.

1. **Identity.** `B2` must read `National Stock Exchange (NSE)`, `BSE` or `MCX`, matching the target. On a mismatch nothing is written to the file.
2. **Labels.** Each label cell must read the label shown (trimmed, case-insensitive), and every target cell must hold a value, not a formula. On any mismatch, all of that file's input cells are skipped and the error is recorded. Its `Web Dashboard` sheet is still written.
3. **Missing values.** An input with no value skips only its own cells, with an error.

| File | Cells | Label cell → label | Value |
|---|---|---|---|
| NSE, BSE, MCX | `B16:D16` | `A16` → `PE Ratio` | P/E bear, base, bull (`pe0`, `pe1`, `pe2`) |
| BSE, MCX | `F11` | `A11` → `Target Price - FY27` | `discount_to_today_pct` ÷ 100 (9 % → 0.09) |
| BSE, MCX | `F12` | `A12` → `Target Price - FY28` | `discount_to_fy_end_pct` ÷ 100 (18 % → 0.18) |
| NSE | `F10` | `A10` → `Upside - Current` | `discount_to_today_pct` ÷ 100. NSE's sheet differs: row 9 is `Current` (= FY27 ÷ (1 + F10)), and F11 is empty. |
| NSE | `F12` | `A12` → `Target Price - FY28` | `discount_to_fy_end_pct` ÷ 100 |

The two discounts are fixed values in `valuation_inputs.json` (`d2` / `d1`), the same for every exchange. The FY labels will move with the fiscal year (`Target Price - FY28` → `FY29`): update `VF_INPUT_CELLS` when the workbooks roll over, or the label check will skip the input cells and say so in the panel.

## `Web Dashboard` sheet (each vF file)

The sheet is cleared and rewritten on every run. It has five columns, A–E, at fixed addresses (`WEB_ADDRESSES` in the script names the main ones), so model cells can link to it:

| Rows | Content |
|---|---|
| `A1` | stamp: "Written by ExchangesDash at <IST time>; data to <date>; inputs last changed <IST time>" |
| `A2` | what the sheet is |
| `A4`, headers `A5:E5` | **Inputs**: Key, Input, Value, Default, Edited |
| `A6:E19` | one row per input, in this order: `adr` (ADR estimate, ₹ Cr / session; blank = the 45 DMA), `g` (QoQ growth %), `pe0`, `pe1`, `pe2`, `w0`, `w1`, `w2` (weights %), `from` (regression data-from date; blank = all data), `oi` (other income next FY, ₹ Cr), `margin` (PAT margin %), `days` (sessions next FY), `d1` (discount to this FY's end %), `d2` (discount to today %). The value in use is in column C (e.g. base P/E = `C9`), the default in D, and `TRUE` in E where the shared inputs changed it. |
| `A21`, headers `A22:B22` | **Market and fit** (value in column B) |
| `B23` … `B47` | CMP ₹ (`B23`), CMP date (`B24`), data to (`B25`), current quarter (`B26`), quarter ADR to date (`B27`), quarter sessions (`B28`), 45 DMA ADR (`B29`), ADR in the estimate table (`B30`), next FY (`B31`), next-FY average ADR (`B32`), total income next FY (`B33`), PAT next FY (`B34`), EPS next FY (`B35`), shares Cr (`B36`), fit sessions n (`B37`), regression data from (`B38`), fit first point (`B39`), fit intercept (`B40`), slope (`B41`), standard error (`B42`), R² (`B43`), price ÷ MA mean (`B44`) and σ (`B45`), fit note (`B46`), ratio note (`B47`) |
| headers `A49:D49` | **Targets**, ₹ per share: Bear (B), Base (C), Bull (D) |
| `A50:D50` | triangulated target: the ADR-estimate triangulation, the headline on the tab's strip |
| `A51:D51` | its upside vs CMP, as a fraction (0.05 = +5 %) |
| `A52:D54` | ADR model: next FY-end target, this FY-end target, today |
| `A55:D59` | 45 DMA triangulation: Regression, Ratio, ADR model, weighted average, upside |
| `A60:D64` | ADR-estimate triangulation: the same five rows. These equal the 45 DMA rows when no ADR estimate is set. |
| `A66`, from `A67` | **ADR path**: quarter label and ADR (column B), from the current quarter to Q4 of the next FY, then the next FY's average. The number of rows depends on the quarter, so this block is last. |

Dates are ISO text (`YYYY-MM-DD`), which Excel turns into dates on entry. An empty cell means no value: no fit, no ratio, or no ADR estimate.

## `WD_*` feed sheets (Exchanges Dashboard workbook)

Every feed sheet has the same shape: a stamp in row 1, headers in row 2 (field names), data from row 3. Each sheet is created if missing, otherwise its used range is cleared (contents only) and rewritten. Values are plain, and dates are ISO text (`YYYY-MM-DD`) that Excel converts to dates.

| Sheet | Rows | Columns |
|---|---|---|
| `WD_Inputs` | one per exchange: `bse`, `mcx`, `nse` (rows 3–5) | `exchange`, `adr`, `g`, `pe0`, `pe1`, `pe2`, `w0`, `w1`, `w2`, `from`, `oi`, `margin`, `days`, `d1`, `d2` (effective inputs), `edited` (the keys the shared inputs changed), `inputs_changed_at` (IST) |
| `WD_Valuation` | one per exchange: `bse`, `mcx`, `nse` | see below |
| `WD_NSE_Daily`, `WD_BSE_Daily`, `WD_MCX_Daily` | one per session in `daily_all` of `{ex}_dashboard_data.json` (at today's rates), oldest first | every field of the rows, `date` first, then in the file's order. MCX includes `modelled` (TRUE before 2 Sep 2024). |
| `WD_Quarterly`, `WD_Monthly` | each exchange's `quarterly` / `monthly` rows, stacked NSE, BSE, MCX | `exchange`, `quarter` / `month`, then every field of the rows (fields one exchange lacks are blank) |
| `WD_VIX` | NSE sessions with a VIX | `date`, `vix` |
| `WD_Contracts` | every NSE or BSE session, oldest first | `date`, `nse_option_contracts` (index + stock options), `nse_futures_contracts`, `nse_option_premium_cr`, `bse_contracts`, `bse_option_premium_cr` (the Contracts to Premium tab's inputs; blank where an exchange has no row) |

The daily, quarterly and monthly columns follow the data files. A field added to the pipelines later is appended, so in those sheets look columns up by their row-2 header (`MATCH`), not by letter. `WD_Inputs` and `WD_Valuation` have fixed columns.

`WD_Valuation` columns:

| Columns | Content |
|---|---|
| `A`–`L` | `exchange`, `cmp`, `cmp_date`, `data_to`, `quarter`, `quarter_adr`, `adr45`, `adr_estimate_used`, `estimate_is_45dma`, `next_fy`, `next_fy_adr`, `eps_next_fy` |
| `M`–`O` | `target_bear` / `_base` / `_bull`: the headline |
| `P`–`R` | `upside_*`, as fractions |
| `S`–`U` | `adr_model_fy_next_end_*` |
| `V`–`X` | `adr_model_fy_end_*` |
| `Y`–`AA` | `adr_model_today_*` |
| `AB`–`AM` | the 45 DMA triangulation: `dma_regression_*`, `dma_ratio_*`, `dma_adr_model_*`, `dma_avg_*` |
| `AN`–`AY` | the estimate triangulation: `est_regression_*`, `est_ratio_*`, `est_adr_model_*`, `est_avg_*` |
| `AZ`–`BJ` | `fit_n`, `data_from`, `fit_first_point`, `fit_intercept`, `fit_slope`, `fit_se`, `fit_r2`, `ratio_mean`, `ratio_sd`, `shares_cr`, `inputs_changed_at` |

## Files

| File | Role |
|---|---|
| `scripts/excel_mirror.py` | the job |
| `scripts/valuation_outputs.py` | the results |
| `scripts/dashboard_js.py` | the JS loader, shared with the tests |
| `.github/workflows/excel-mirror.yml` | the workflow. Inputs: `trigger`, `run_id`, `dry_run`, `check_only`. Runs queue in the `excel-mirror` concurrency group. |
| `dashboard/api/excel-refresh.js` | the button and the run list |
| `dashboard/api/_github_dispatch.js` | workflow dispatch, shared with the cron triggers |
| `dashboard/js/23-excel-sync.js` | the panel |

Tests:

- `tests/test_excel_mirror.py`: a fake Graph and Supabase at the HTTP level
- `tests/test_valuation_outputs.py`
- `tests/test_excel_refresh_api.py`
- `tests/test_excel_sync_panel.py`
- `tests/test_trigger_scheduled.py`
