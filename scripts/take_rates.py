"""
Exchange transaction-charge take rates — the single source for every Python
script that turns turnover/premium into revenue. Rates are one-side % × 2
(both sides of each trade), applied to:
  futures → notional turnover, options → premium turnover, cash → traded value.

dashboard/api/revenue.js keeps a JS copy of these numbers;
scripts/check_take_rates.py fails CI if the two drift apart.
"""

# NSE — corrected 2026-08-07 (commit e0aaaf754)
NSE_TR_FUT  = 0.00183 / 100 * 2
NSE_TR_OPT  = 0.03553 / 100 * 2
NSE_TR_CASH = 0.00307 / 100 * 2

# BSE — no futures fee
BSE_TR_FUT  = 0.0
BSE_TR_OPT  = 0.03250 / 100 * 2
BSE_TR_CASH = 0.00375 / 100 * 2
