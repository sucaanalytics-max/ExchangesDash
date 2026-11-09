---
name: broker-mtf
description: Add a broker's newly published MTF book (or MTF market share) to the hand-kept register behind the MTF mode's Brokers tab, after checking it in the filing. Use when a broker or its parent publishes results, a monthly business update or a rating rationale with an MTF figure, or when the daily job's summary lists "Broker MTF register: figures due".
---

# Broker MTF figures

The Brokers tab (MTF mode, NSE + BSE view) reads `dashboard/data/mtf_brokers.json`. `scripts/mtf_pipeline.py` (`brokers_doc`) builds it from the hand-kept register `scripts/broker_mtf_register.py`, pricing each figure against the exchanges' combined book on the same date. Edit the register, never the JSON. Query the data files with `python3 -I -c`; don't read them.

## Which figures are due

The `mtf-update` job prints the brokers whose next figure should be out, both to its log and to the run summary. The same check runs locally:

```bash
cd scripts && python3 -c "import mtf_pipeline as m; from datetime import date; print(m.brokers_due(date.today()))"
```

`BROKERS[id]["sources"]` names each broker's best source, how often it publishes and the fallbacks. For example, Bajaj Finance's presentation gives Bajaj Broking's book; ICICI Bank's and Kotak Bank's presentations give their broking arms' market share; and rating rationales are the only source for HDFC, Axis, SBI, Mirae and Nuvama.

## Figures read automatically

Groww's investor-relations "MTF Net Book" is read on every MTF run (`LIVE_FEEDS` in the register; `refresh_live` in `scripts/mtf_pipeline.py`) into `dashboard/data/mtf_broker_live.json`, under basis `live`. Don't add it by hand: `validate()` rejects hand-kept `live` rows. If the job warns that the page changed, fix `parse_groww_ir`.

## Add a figure

1. **Fetch the primary document**, never an aggregator such as mtf.trading or a news site, and find the figure and its page:
   ```bash
   curl -sL -A 'Mozilla/5.0' '<url>' -o /tmp/doc.pdf
   pdftotext -layout /tmp/doc.pdf - | grep -n -i -B2 -A2 'MTF\|margin trad'
   for p in $(seq 1 $(pdfinfo /tmp/doc.pdf | awk '/^Pages/ {print $2}')); do pdftotext -f $p -l $p /tmp/doc.pdf - | grep -qi 'MTF book' && echo $p; done
   ```
2. **Append a dict to `DISCLOSURES`** in the broker's block, keeping BROKERS order and then date order:
   - `broker` and `as_of`. `as_of` is the period end; for a monthly average it is the month's last day.
   - Exactly one of `book_cr` (₹ crore: ₹ mn ÷ 10, ₹ bn × 100, ₹ lakh ÷ 100) or `share_pct` (a share the filing states).
   - `measure`, which says what the figure is:
     - `share`: a published market share.
     - `gross`: the document says gross.
     - `net`: it says net, or it is a balance-sheet loan line.
     - `client_funding`: Angel One.
     - `unstated`: anything else.
   - `basis`: `period_end`, or `month_avg` for Angel One's monthly update.
   - `precision: "integer"` for a whole-number share such as Kotak's "~14 %".
   - `rounded: True` for a rounded ₹ figure such as "₹9,600+ Cr".
   - `source` (the document's name), `url`, `page` and `quote`. The quote is the document's words with the figure in them.
   - When a document restates an earlier period, add it if that period is missing, citing this document.
   - When it gives two measures (HDFC Securities' gross and net), add one row for each.
3. **If the broker's source has changed**, update its `sources`. If its main measure has changed, update `primary` too.
4. **Rebuild the JSON and test:**
   ```bash
   python3 scripts/mtf_pipeline.py --brokers-only
   python3 -m unittest discover -s tests
   ```
   `--brokers-only` validates the register and rebuilds the JSON from the committed `mtf_daily.json`, with no network. Commit the register and `dashboard/data/mtf_brokers.json` together. The `mtf-update` job rebuilds the file on every run and commits it to `main`.

## Conventions

- **Shares are ours.** Each figure is divided by the NSE + BSE book on its date. Brokers' own shares use their own denominators, so they are not used as the denominator; a published share is entered as a `share` row instead.
- **Like with like.** Changes and share moves compare figures of the same measure and basis only.
- **1 Oct 2025.** From that date brokers report MTF on revised (gross) rules. NSE's book steps up 7 % that day (`MTF_NOTES` in `dashboard/js/40-mtf.js`), so moves across it carry a †.
