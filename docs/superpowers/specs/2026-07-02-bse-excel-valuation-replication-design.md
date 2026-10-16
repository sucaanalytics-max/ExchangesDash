# BSE Excel Valuation Model — Replication on Dashboard

**Date:** 2026-07-02
**Source:** `20260121_Exchanges_Dashboard.xlsx`, "BSE" sheet (+ supporting sheets `BSE Reg`, `BSE Analyst`, `NSE+BSE`, `SUMMARY BSE Revenue`)

## Goal

Replicate all analysis on the Excel "BSE" sheet as a single new dedicated section on the live dashboard (`dashboard/`), mirroring the Excel sheet's own 7-part structure and order — not distributed across the existing Predictor/Share Analytics tabs.

## Source sheet structure (reference)

1. **Triangulated Target Price** — average of ADR Model, Regression, Analyst Target, shown against CMP.
2. **Annual Predictor** — Bear/Base/Bull FY2027: ADR → total income → PAT → EPS → PE → price target → discounted target price.
3. **CMP/BearBaseBull/Multiples** — the PE-multiple mechanics feeding #2.
4. **Quarterly Predictor** — same chain as #2, extrapolated for the current quarter.
5. **Revenue trend tables** — FY/Quarterly/Monthly/Weekly, YoY/QoQ/MoM/WoW, for Total/Options/Cash.
6. **Price vs DMA charts** — 45/20/10-day DMA regressions, Price÷DMA ratio with mean/±1σ/±2σ bands, log-log regression.
7. **10-DMA vs 45-DMA** comparison chart.

## New dashboard section

A single new section (tab or panel — implementation detail for the build plan) titled to match, e.g. "BSE Valuation", laid out top-to-bottom in the same 7-part order as the Excel sheet. Existing Predictor and Share Analytics tabs are untouched.

### 1. Triangulated Target Price (depends on 2 and the analyst-targets file)

KPI block averaging:
- **ADR Model** = Annual Predictor's Base-case target price (from section 2, live).
- **Regression** = 45-day DMA regression's predicted price for the latest trading day (from `bse_share_analysis.json`).
- **Analyst Target** = average of broker targets (from `bse_analyst_targets.json`) discounted by the discount % input shared with section 2 (default 18%).

Displayed against CMP, sourced via yfinance `BSE.NS` (same source the regression script already uses). Shows Average Target vs CMP upside/downside.

### 2 & 4. Annual Predictor / Quarterly Predictor (interactive, persisted)

Interactive panel, editable inputs with live client-side recompute:
- Scenario toggle: Bear / Base / Bull.
- Editable: ADR growth % (defaults −5/0/+5), target market-share shift (±1pt default), PAT margin % (default 52%), PE multiple per scenario (default 40/45/50), discount % (default 18%), shares outstanding (manual input — Excel sources this from a live Bloomberg/FactSet plugin we can't replicate).
- Calculation chain per scenario: `ADR → Total Income (ADR × trading days + other income) → PAT (Total Income × PAT margin) → EPS (PAT / shares outstanding) → Price Target (EPS × PE) → Target Price (Price Target ÷ (1 + discount%))`.
- Two sub-tabs: Annual (FY2027) and Quarterly (current quarter) — different trading-days-elapsed logic per Excel.
- Output: KPI cards (EPS / Price Target / Upside vs CMP) per scenario + a Bear/Base/Bull comparison table.
- All inputs auto-save (debounced, not per-keystroke) via the persistence API below, and reload with the last-saved values for anyone opening the dashboard.

### 3. CMP/Multiples

Folded into section 2's UI as the PE-multiple inputs/table — not a separate section in the dashboard implementation, since it's mechanically part of the Annual Predictor chain in Excel.

### 5. Revenue trend tables (verification pass, not new build)

`bse_enriched_data.json` already computes FY/Quarterly/Monthly/Weekly YoY/QoQ/MoM/WoW deltas for Total/Options/Cash. This section is a cross-check of Excel rows 90-109 against the existing rendering (`xlSegmentBlock`/`xlStaticSegmentBlock`) and a patch of any gaps found — reusing/relocating the existing tables into this new section's layout position, not rebuilding them.

### 6. Price vs DMA charts

Existing charts (`chartBseSharePrice`, `chartBseRevMaVsPrice`, `chartBseRatioSD`, `chartBseShareScatter`) relocated into this section, plus:
- **10-vs-45 DMA revenue** — new dual-line overlay chart, reusing `buildSeriesWithDMA` for both windows.
- **Log-log regression** — new chart: `ln(revenue_MA45)` vs `ln(price)`, for two fixed start dates ("Jun 2023 onwards", "Apr 2024 onwards"), own OLS fit via `computeOLS`.

### 7. 10-DMA vs 45-DMA

Same chart as the "10-vs-45 DMA revenue" overlay built in section 6 — Excel lists it as a separate numbered block but it's the same chart; not duplicated.

## Data & pipeline changes

- `scripts/bse_pipeline.py`: add `predictor_assumptions_defaults` (Excel's hardcoded starting values) and any raw inputs the Annual/Quarterly Predictor formulas need that aren't already present (FY/quarter trading-days-total and elapsed, last-45/20-day ADR and market share — reuse what exists, add only gaps).
- `scripts/bse_share_analysis.py`: extend to compute and store 10-day and 20-day window regressions alongside the existing fixed 45-day one, in `bse_share_analysis.json`.
- New file `dashboard/data/bse_analyst_targets.json` (hand-maintained): broker, date, rating, target_price, methodology — updated whenever a new broker report is published.

## Persistence API

New serverless function `dashboard/api/bse-predictor-assumptions.js`, backed by **Vercel Blob**:
- `GET` → current saved assumptions, falling back to Excel-matching defaults if none saved yet.
- `POST` → validates and overwrites the single `bse-predictor-assumptions.json` blob.
- Requires provisioning a Vercel Blob store for this project (`BLOB_READ_WRITE_TOKEN` env var) — via Vercel dashboard or the Vercel MCP connector if authorized.

## Explicitly out of scope / deferred

- Excel's `_FV()` live Bloomberg/FactSet plugin values (shares outstanding, CMP via that specific source) — replaced with yfinance price + a manually editable shares-outstanding input.
- Excel's "Method 1" ADR projections shown as reference-only where Excel itself doesn't feed them into the final number (Annual Predictor uses Method 2 downstream; Quarterly Predictor uses Method 1 downstream) — dashboard will show only the method Excel actually uses per predictor, not both, to avoid confusion.
- Per-user or historical audit trail of assumption changes — single shared "current" state only, per this conversation's persistence requirement.
