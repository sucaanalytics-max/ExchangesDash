"""NSE quarterly P&L as reported in NSE's results filings, in nse_pnl's columns.

nse_pnl (Supabase) is kept by hand and neither pipeline writes it, so a quarter
whose results are out can still hold its manual forecast there. Each row here
replaces the nse_pnl row for the same quarter when nse_pipeline builds its
outputs (apply), so reported quarters reach the dashboard without a database
edit. Add a quarter when NSE publishes results: the press release (with the
audited consolidated statement) and the earnings presentation on
nsearchives.nseindia.com. tests/test_nse_reported_pnl.py checks every row adds
up the way nse_pipeline's P&L definitions say it must.

Conventions (as in nse_pipeline, "NSE P&L definitions"):
- Totals and expense lines are the audited statement's (₹ Cr, 2 dp); revenue
  lines are the presentation's whole crores, with the rounding left in
  other_operating / other_non_operating so the lines sum to the statement.
- data_centre = data centre rack charges + data connectivity charges.
- total_expense = statement total expenses + contribution to Core SGF.
- ebitda = total_revenue − total_expense (nse_pnl's column, not operating EBITDA).
- pbt = continuing PBT + profit from discontinued operations after tax, so
  pat = pbt − income_tax is the reported profit for the period.
- None = not disclosed separately; the amount sits in the line named in `note`.
"""

REPORTED = [
    {
        "quarter": "Q4 FY 2026", "trading_days": 60, "is_predicted": False,
        "transaction_rev": 4077, "listing_income": 76, "data_centre": 326, "data_feed": 128,
        "index_licensing": 40, "clearing_settlement": 79, "operating_investment": 198,
        "other_operating": 43.59, "investment_income": 380, "other_non_operating": 12.18,
        "total_revenue": 5359.77,
        "employee_cost": 214.08, "regulatory_fees": 219.67, "depreciation": 151.22,
        "technology_expense": 362, "sebi_settlement": 84, "csr_expense": 223, "other_expense": 232.29,
        "sgf_contribution": 0, "total_expense": 1486.26,
        "ebitda": 3873.51, "ebitda_margin": 0.72,
        "share_profit_associates": 22.11, "profit_sale_investment": 0, "labour_codes": 0,
        "discontinued_operations": 7.33,
        "pbt": 3902.95, "income_tax": 1031.96, "tax_rate": 0.26,
        "pat": 2870.99, "pat_margin": 0.54, "eps": 11.60,
        "source": "NSE Q4 FY26 press release and earnings presentation, 5 May 2026",
        "note": "sebi_settlement: settlement applications in the colocation and dark fibre cases",
    },
    {
        "quarter": "Q1 FY 2027", "trading_days": 60, "is_predicted": False,
        "transaction_rev": 3623, "listing_income": None, "data_centre": 258, "data_feed": 150,
        "index_licensing": None, "clearing_settlement": None, "operating_investment": 234,
        "other_operating": 295.41, "investment_income": 691.76, "other_non_operating": None,
        "total_revenue": 5252.17,
        "employee_cost": 242.59, "regulatory_fees": 188.34, "depreciation": 162.55,
        "technology_expense": None, "sebi_settlement": 7.04, "csr_expense": None, "other_expense": 571.51,
        "sgf_contribution": 5.00, "total_expense": 1177.03,
        "ebitda": 4075.14, "ebitda_margin": 0.78,
        "share_profit_associates": 25.75, "profit_sale_investment": 20.27, "labour_codes": 48.32,
        "discontinued_operations": -1.80,
        "pbt": 4167.68, "income_tax": 1047.60, "tax_rate": 0.25,
        "pat": 3120.08, "pat_margin": 0.59, "eps": 12.61,
        "source": "NSE Q1 FY27 press release with audited consolidated results, 30 Jul 2026",
        "note": ("The press release splits out only transaction charges, data connectivity (in data_centre), "
                 "data feed and operating investment income: listing, rack, index licensing, clearing and "
                 "other operating revenue are together in other_operating, all other income in "
                 "investment_income, and technology and CSR in other_expense. sebi_settlement: financial "
                 "disincentives SEBI directed to the Investor Protection Fund (notes 4a, 4b). labour_codes: "
                 "reversal of the FY26 provision for the new Labour Codes (note 7)."),
    },
]


def apply(pnl):
    """nse_pnl rows with each reported quarter replacing (or adding) its row.
    Order is left to the caller."""
    by_quarter = {r.get("quarter"): r for r in (pnl or [])}
    for row in REPORTED:
        by_quarter[row["quarter"]] = dict(row)
    return list(by_quarter.values())
