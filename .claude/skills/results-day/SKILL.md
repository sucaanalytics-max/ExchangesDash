---
name: results-day
description: Add a newly reported NSE or BSE quarter (results day), or a newly announced Muhurat / DR-test session, to the hand-kept registers, and update the tests that pin the latest quarter. Use when NSE or BSE publishes quarterly results, or an exchange announces a special session.
---

# Results day

Everything below is a hand edit to a Python register. Never edit the generated JSON in `dashboard/data/` or `data/`: the next pipeline run rebuilds it from these registers. Query data files with `python3 -I -c` rather than reading them.

## NSE quarter (`scripts/nse_reported_pnl.py`)

1. Sources: the press release (audited consolidated statement) and the earnings presentation on nsearchives.nseindia.com.
2. Append one dict to `REPORTED`, in `nse_pnl`'s columns, following the conventions in the module docstring:
   - statement totals and expense lines in ₹ Cr to 2 dp; presentation revenue lines in whole crores, with the rounding left in `other_operating` / `other_non_operating`;
   - `total_expense` = statement total expenses + Core SGF contribution;
   - `ebitda` = `total_revenue − total_expense`;
   - `pbt` = continuing PBT + discontinued operations after tax;
   - `None` for any line not disclosed separately, and say in `note` where its amount sits.

   Set `is_predicted: False`, `trading_days`, and `source` (document and date).
3. Update the tests that pin the latest quarters, in `tests/test_nse_reported_pnl.py`:
   - `test_reported_quarters_replace_manual_forecasts` asserts that the next quarter is still predicted; move it forward.
   - `test_forecast_rests_on_latest_reported_quarters` expects `base_quarters` to be the last two reported quarters, plus their `non_operating_income_ratio`. Recompute these from the new row.
4. `test_identities` checks that the new row adds up. If it fails, the row is wrong, not the test.

## BSE quarter (`scripts/fee_register.py`, cash calibration)

1. From the results filing, take "Equity Cash – Transaction Charges Income" (normal plus special rate) for the fiscal quarter, in ₹ Cr. When only cumulative figures are given, derive the quarter as H1 − Q1, 9M − H1 or FY − 9M.
2. Take the quarter's cash traded value from the at-today's-rates file:
   ```bash
   python3 -I -c "import json; d=json.load(open('dashboard/data/bse_dashboard_data.json')); print({q['quarter']: q['cash_traded_value'] for q in d['quarterly'][-6:]})"
   ```
3. Compute rate (₹/Cr per side) = income_cr × 1e7 ÷ (2 × cash_traded_value), rounded to a whole number. Append `(fy_quarter, rate, filing_id, derivation)` to `BSE_CASH_CALIBRATED_QUARTERS`. The rows are oldest first and must be contiguous; `filing_id` is the PDF name under `nsearchives.nseindia.com/corporate/`.
4. Recompute `BSE_CASH_PROVISIONAL_RATE` by pooling the last four calibrated quarters (turnover-weighted), and update `BSE_CASH_PROVISIONAL_SOURCE` to name them:
   ```bash
   python3 -I -c "
   import json, sys; sys.path.insert(0, 'scripts'); import fee_register as fr
   tv = {q['quarter']: q['cash_traded_value'] for q in json.load(open('dashboard/data/bse_dashboard_data.json'))['quarterly']}
   last = fr.BSE_CASH_CALIBRATED_QUARTERS[-4:]
   print([l for l, *_ in last], round(sum(r * tv[l] for l, r, *_ in last) / sum(tv[l] for l, r, *_ in last)))"
   ```
   Run this after step 3 and edit the constant; before this change the formula gave 616.
5. `tests/test_fees.py` `test_bse_cash_calibrated_then_provisional` pins a reported date (Q1 FY 2027, rate 557) and an unreported date (2026-10-15). Once 2026-10-15 falls in a reported quarter, move the unreported date forward.

## Special session (`scripts/trading_calendar.py`)

When an exchange announces a Muhurat or DR-test session, add `{"date", "type": "muhurat" | "dr_test", "exchanges": (...), "note"}` to `SPECIAL_SESSIONS`, naming the circular in `note`. Full weekend sessions, such as Budget day, are normal trading days: don't add them.

## Verify

```bash
python3 -m unittest discover -s tests
python3 scripts/check_take_rates.py   # also validates the fee register
python3 -m pyflakes scripts/fee_register.py scripts/nse_reported_pnl.py scripts/trading_calendar.py
```

After merging, run the `Exchange Daily Update` workflow by hand (exchange `all`) so the JSON is rebuilt from the new rows.
