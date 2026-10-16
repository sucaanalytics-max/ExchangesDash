"""
bse_export_seed.py — Run locally to export Excel data to bse_revenue_seed.csv.
Re-run whenever the Excel file is updated with new rows.

Source: Regression sheet, columns A (Date), B (Revenue ₹ Cr), C (Price)
Output: dashboard/data/bse_revenue_seed.csv
"""

import csv
from datetime import datetime
from pathlib import Path

EXCEL_PATH = Path(
    "/Users/shreevar/Library/CloudStorage/"
    "OneDrive-TUSKINVESTMENTLIMITED/"
    "Tusk Invest's files - Tusk Equity/"
    "Portfolio Stock Valuations - Bull Base Bear (Tusk Prop)/"
    "20251110_BSE VF.xlsx"
)
SHEET_NAME = "Regression"
OUTPUT_CSV = Path(__file__).parent.parent / "dashboard" / "data" / "bse_revenue_seed.csv"


def main():
    import openpyxl
    print(f"Reading: {EXCEL_PATH.name} → sheet '{SHEET_NAME}'")
    wb = openpyxl.load_workbook(EXCEL_PATH, read_only=True, data_only=True)
    ws = wb[SHEET_NAME]

    # Row 1: exchange labels, Row 2: column headers, Row 3+: data
    valid = []
    skipped = 0
    for row in ws.iter_rows(min_row=3, min_col=1, max_col=3, values_only=True):
        date_val, rev, price = row
        if date_val is None or rev in (None, "#N/A", ""):
            skipped += 1
            continue
        if isinstance(date_val, datetime):
            date_str = date_val.strftime("%Y-%m-%d")
        else:
            skipped += 1
            continue
        try:
            rev_f = float(rev)
        except (TypeError, ValueError):
            skipped += 1
            continue
        price_f = None
        if price not in (None, "#N/A", ""):
            try:
                price_f = round(float(price), 4)
            except (TypeError, ValueError):
                pass
        valid.append({"date": date_str, "revenue_cr": round(rev_f, 6), "price": price_f})

    OUTPUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_CSV, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["date", "revenue_cr", "price"])
        writer.writeheader()
        writer.writerows(valid)

    print(f"Exported {len(valid)} rows  (skipped {skipped})")
    print(f"Date range: {valid[0]['date']} → {valid[-1]['date']}")
    print(f"Output: {OUTPUT_CSV}")


if __name__ == "__main__":
    main()
