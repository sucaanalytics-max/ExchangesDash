"""
Exchange transaction-charge take rates at TODAY's statutory rates — what every
Python script uses to turn turnover/premium into revenue for the
at-today's-rates files, the live pollers and /api/revenue. Rates are one-side
% × 2 (both sides of each trade), applied to:
  futures → notional turnover, options → premium turnover, cash → traded value.

Derived from the latest open-ended statutory rule in scripts/fee_register.py
(the single source of every rate, current and historical; the date-effective
*_eff.json files price each day with fee_register.rate instead). The values
are bit-identical to the literals they replaced:
  NSE fut 0.00183 % / opt 0.03553 % / cash 0.00307 % (NSE/FA/73061),
  BSE fut nil / opt 0.03250 % / cash 0.00375 %.

dashboard/api/revenue.js keeps a JS copy of these numbers;
scripts/check_take_rates.py fails CI if the two drift apart.
"""

from fee_register import current_statutory_rate as _today

# NSE
NSE_TR_FUT  = _today("NSE", "fut")
NSE_TR_OPT  = _today("NSE", "opt")
NSE_TR_CASH = _today("NSE", "cash")

# BSE — no futures fee
BSE_TR_FUT  = _today("BSE", "fut")
BSE_TR_OPT  = _today("BSE", "opt")
BSE_TR_CASH = _today("BSE", "cash")
