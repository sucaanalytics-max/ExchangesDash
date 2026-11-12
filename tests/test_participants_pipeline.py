"""Participant-wise data pipeline (scripts/participants_pipeline.py) and its monthly report
(scripts/participants_report.py). Fixtures are trimmed copies of the live files' layouts
(12 Nov 2026), including the quirks the parsers handle: NSE's badly quoted CSV title, the CM
category file's FPI block straight after the main one and its dated titles, '-' values,
NSDL's month / year totals after the last day, and Market Pulse's three table layouts."""

import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

from helpers import ROOT  # also puts scripts/ on the path
import participants_pipeline as p
import participants_report as rpt

NSE_OI_CSV = '''""Participant wise Open Interest (no. of contracts) in Equity Derivatives as on Nov 06, 2026"",,,,,,,,,,,,,,
Client Type,Future Index Long,Future Index Short,Future Stock Long,Future Stock Short       ,Option Index Call Long,Option Index Put Long,Option Index Call Short,Option Index Put Short,Option Stock Call Long,Option Stock Put Long,Option Stock Call Short,Option Stock Put Short,Total Long Contracts      ,Total Short Contracts
Client,180828,97047,3139917,320512,2906186,4070036,2894792,4474207,1644069,1096053,1040787,1050895,13037089,9878241
DII,54004,18468,330049,4393321,10818,104950,553,1003,2363,41614,387014,31515,543798,4831874
FII,48656,149072,3605434,2526231,861276,1379216,988900,929475,310259,386488,366244,296547,6591329,5256468
Pro,29551,48452,684647,519983,1141859,1529740,1035893,1679258,1227563,984087,1390209,1129285,5597447,5803080
TOTAL,313039,313039,7760047,7760047,4920138,7083942,4920138,7083942,3184254,2508242,3184254,2508242,25769663,25769663
'''


class FakeSheet:
    def __init__(self, rows):
        width = max(len(r) for r in rows)
        self.rows = [list(r) + [""] * (width - len(r)) for r in rows]
        self.nrows, self.ncols = len(self.rows), width

    def cell_value(self, r, c):
        return self.rows[r][c]


class FakeBook:
    datemode = 0

    def __init__(self, *sheets):
        self.sheets = [FakeSheet(s) for s in sheets]
        self.nsheets = len(self.sheets)

    def sheet_by_index(self, i):
        return self.sheets[i]


def with_book(*sheets):
    return mock.patch.object(p, "_xls_sheets", lambda body: FakeBook(*sheets))


FII_STATS = [
    ["FII DERIVATIVES STATISTICS FOR 06-Nov-2026", "", "", "", "", "", ""],
    ["", "BUY", "BUY", "SELL", "SELL", "OPEN INTEREST AT THE END OF THE DAY", ""],
    ["", "No. of contracts", "Amt in Crores", "No. of contracts", "Amt in Crores", "No. of contracts", "Amt in Crores"],
    ["INDEX FUTURES", 65215.0, 10832.49, 28193.0, 4698.05, 197728.0, 32975.0],
    ["NIFTY FUTURES", 43034.0, 6958.35, 16327.0, 2634.13, 127577.0, 20767.53],
    ["", "", "", "", "", "", ""],
    ["INDEX OPTIONS", 12835658.0, 2067138.99, 12785878.0, 2060396.28, 4158866.0, 685865.45],
    ["STOCK FUTURES", 397938.0, 26403.25, 406085.0, 27569.44, 6131665.0, 406829.2],
    ["Notes:", "", "", "", "", "", ""],
    ["Both buy and sell positions have been considered", "", "", "", "", "", ""],
]

# NSE CM category file: the FPI block follows the main block with no blank line; dates as text here
CM_CAT = [
    ["Category-wise turnover for 06-11-2026", "", "", ""],
    ["Trade Date", "Client Categories", "Buy Value in Rs.Crores", "Sell Value in Rs.Crores"],
    ["06-Nov-2026", "Bank", 252.11, 814.12],
    ["06-Nov-2026", "Mutual Funds", 13353.99, 17080.42],
    ["06-Nov-2026", "RETAIL", 49224.72, 50598.13],
    ["06-Nov-2026", "OTHERS", 86650.57, 78247.94],
    ["FPI Data as reported by NSDL on 07-11-2026", "", "", ""],
    ["Trade Date", "Client Categories", "Buy Value in Rs.Crores", "Sell Value in Rs.Crores"],
    ["06-11-2026 and 08-11-2026", "FPI", 32089.6, 17360.23],
    ["", "", "", ""],
    ["Notes :", "", "", ""],
    ["1. Data is categorised first on custodial participant code basis.", "", "", ""],
    ["2. 'Retail' includes HUF, Individual/Proprietorship Firms, NRI.", "", "", ""],
]
CM_HISTORICAL = [
    ["Historical Categorywise Turnover - Domestic Institutional Investors (DII)", "", "", ""],
    ["", "Bank", "", "Total  - DII"],
    ["Date", "Buy Traded Value (Rs. Crores)", "Sell Traded Value (Rs. Crores)", "Buy Traded Value (Rs. Crores)"],
    ["October'26", 2246.4797, 3256.7674, 156793.56],
    ["November '25", 2057.98, 3840.09, 144591.44],
]
# NSE F&O category file to early 2024: an older notional table, then the client category one; a '-' value
FO_CAT_2023 = [
    ["Trade Date", "Category", "Buy Value in Rs.Crores", "Sell Value in Rs.Crores"],
    ["01/Nov/23", "Mutual Funds", 2224.18, 4418.57],
    ["01/Nov/23", "Proprietory Trades", 27379574.05, 27377130.08],
    ["", "", "", ""],
    ["Notes :", "", "", ""],
    ["2. Others exclude FIIs, Mutual Funds, Proprietory Trades", "", "", ""],
    ["", "", "", ""],
    ["Client Category Wise Turnover", "", "", ""],
    ["Trade Date", "Client Categories", "Buy Value in Rs.Crores", "Sell Value in Rs.Crores"],
    ["01/Nov/23", "AIF", 361.08, 368.94],
    ["01/Nov/23", "Insurance Companies", "-", 0.0],
    ["01/Nov/23", "RETAIL", 43883.71, 42121.69],
]

NSDL_HTML = """<table>
<tr><td>Stock exchanges compile the provisional FII/FPI trade data …</td></tr>
<tr><td>Daily Trends in FPI Investments up to 30-Nov-2023</td></tr>
<tr><th>Reporting Date</th><th>Debt/Equity</th><th>Investment Route</th><th>Gross Purchases(Rs Crore)</th>
    <th>Gross Sales(Rs Crore)</th><th>Net Investment (Rs Crore)</th><th>Net Investment US($) million</th><th>Conversion</th></tr>
<tr><td>01-Nov-2023</td><td>Equity</td><td>Stock Exchange</td><td>11000.27</td><td>11577.64</td><td>(577.37)</td><td>(69.34)</td><td>Rs.83.2692</td></tr>
<tr><td>Primary market &amp; others</td><td>146.41</td><td>2.09</td><td>144.32</td><td>17.33</td></tr>
<tr><td>Sub-total</td><td>11146.68</td><td>11579.73</td><td>(433.05)</td><td>(52.01)</td></tr>
<tr><td>Total</td><td>12968.98</td><td>12545.01</td><td>423.97</td><td>50.90</td></tr>
<tr><td>02-Nov-2023</td><td>Equity</td><td>Stock Exchange</td><td>6681.15</td><td>8478.01</td><td>(1796.86)</td><td>(215.75)</td><td>Rs.83.2843</td></tr>
<tr><td>Sub-total</td><td>6687.13</td><td>8478.01</td><td>(1790.88)</td><td>(215.03)</td></tr>
<tr><td>Total</td><td>7166.08</td><td>8892.45</td><td>(1726.37)</td><td>(207.29)</td></tr>
<tr><td>Total for November</td><td>Equity</td><td>Stock Exchange</td><td>17681.42</td><td>20055.65</td><td>(2374.23)</td><td>(285.09)</td></tr>
<tr><td>Total</td><td>20135.06</td><td>21437.46</td><td>(1302.40)</td><td>(156.39)</td></tr>
<tr><th>Reporting Date</th><th>Derivative Products</th><th>Buy</th><th>Sell</th><th>Open Interest at the end of the date</th></tr>
<tr><td>No. of Contracts</td><td>Amount in Crore</td><td>No. of Contracts</td><td>Amount in Crore</td><td>No. of Contracts</td><td>Amount in Crore</td></tr>
<tr><td>01-Nov-2023</td><td>Index Futures</td><td>47337.00</td><td>3833.72</td><td>46667.00</td><td>3765.75</td><td>215432.00</td><td>17525.90</td></tr>
<tr><td>Index Options</td><td>28068062.00</td><td>2108592.21</td><td>27923820.00</td><td>2100452.13</td><td>4294035.00</td><td>344480.12</td></tr>
<tr><td>Total for November</td><td>Index Futures</td><td>9.00</td><td>9.00</td><td>9.00</td><td>9.00</td><td>9.00</td><td>9.00</td></tr>
<tr><td>Index Options</td><td>9.00</td><td>9.00</td><td>9.00</td><td>9.00</td><td>9.00</td><td>9.00</td></tr>
</table>"""

PULSE_2026 = """Market Pulse
Table 89: Share of client participation in NSE cash market segment (%)
MoM Change YoY Change
C lient category Aug-26 Jul-26 Aug-25
(bps) (bps)
FY27TD FY26 CY26TD
Corporates 4.4 3.9 3.6 45 74 4.0 3.7 3.8
DIIs 12.7 13.9 14.5 (124) (185) 13.1 14.2 13.4
Foreign Investors 14.1 12.3 17.2 180 (307) 13.1 14.6 13.3
Individuals 33.5 33.0 32.0 53 155 33.2 33.4 32.7
Prop 31.7 33.4 29.4 (172) 234 33.4 30.9 33.7
Others 3.6 3.5 3.3 18 29 3.2 3.2 3.0
Source: NSE EPR.
"""
PULSE_2023 = """Table 61: Share of client participation in NSE's CM segment (%)
MoM chg Apr-23 to Apr-22 to YoY chg
Client category Nov-23 Oct-23 FY23 CY23TD
(bps) Nov-23 Nov-22 (bps)
Cash Segment
Corporates 5.7 5.6 15 5.6 4.0 155 4.2 5.3
DII 10.5 11.8 (133) 11.4 11.1 27 11.5 11.6
FPI 16.3 14.4 186 15.3 15.0 37 15.1 15.6
Individual
35.7 35.4 27 35.0 37.2 (228) 36.5 34.7
investors
PRO 26.9 28.2 (130) 27.8 27.0 83 27.2 27.8
Others 4.9 4.6 34 4.9 5.7 (75) 5.5 5.0
Source: NSE EPR.
"""
PULSE_ANNUAL = """Table 66: Share of client participation in NSE cash market segment (%) in 2025
Client category Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec
Corporates 3.6 4.0 4.3 3.6 3.8 4.1 3.3 3.6 3.7 3.6 3.5 3.7
DIIs 14.2 14.2 14.5 14.4 12.0 14.1 14.1 14.5 14.2 14.4 14.4 15.8
Foreign Investors 13.4 16.5 16.3 15.5 15.6 14.9 14.1 17.2 14.9 12.8 17.2 12.8
Individuals 32.9 30.6 32.1 32.8 35.8 34.4 35.3 32.0 34.5 34.8 32.5 33.8
Prop 30.7 30.3 29.0 29.8 28.4 27.7 29.3 29.4 29.9 31.7 29.9 30.9
Others 5.2 4.4 3.8 3.9 4.4 4.8 3.9 3.3 2.8 2.7 2.5 2.9
Source: NSE EPR.
"""


class Helpers(unittest.TestCase):
    def test_numbers_and_dates(self):
        self.assertEqual([p.num(x) for x in ("1,234.5", "(7.88)", "-", "", "Rs.93.8579", None)],
                         [1234.5, -7.88, None, None, 93.8579, None])
        self.assertEqual([p.parse_day(x) for x in ("Nov 06, 2026", "as on Oct 03,2023", "06-Nov-2026",
                                                     "01/Nov/23", "2026-11-11T00:00:00", "06-11-2026 and 08-11-2026")],
                         [date(2026, 11, 6), date(2023, 10, 3), date(2026, 11, 6), date(2023, 11, 1),
                          date(2026, 11, 11), None])

    def test_compact_round_trip(self):
        tables = {"T": {"A": {"x": 1, "y": 2}, "B": {"y": 3, "z": None}}}
        packed = p.compact(tables)
        self.assertEqual(packed["T"]["fields"], ["x", "y", "z"])
        self.assertEqual(packed["T"]["rows"]["B"], [None, 3, None])
        self.assertEqual(p.expand(packed)["T"]["A"], {"x": 1, "y": 2, "z": None})


class Parsers(unittest.TestCase):
    def test_nse_participant_csv(self):
        as_of, tables = p.parse_nse_participant_csv(NSE_OI_CSV)
        self.assertEqual(as_of, date(2026, 11, 6))      # the title's date, split at its comma by csv
        (title, t), = tables.items()
        self.assertEqual(title, "Participant wise Open Interest (no. of contracts) in Equity Derivatives")
        self.assertEqual(list(t), ["Client", "DII", "FII", "Pro", "TOTAL"])
        self.assertIn("Future Stock Short", t["FII"])   # padded header names are cleaned
        for field in t["TOTAL"]:   # the four categories add up to NSE's TOTAL (NSE's own file is one
            # contract off in Option Index Call Long on 6 Nov 2026: 4,920,139 against 4,920,138)
            self.assertAlmostEqual(sum(t[c][field] for c in ("Client", "DII", "FII", "Pro")), t["TOTAL"][field],
                                   delta=1)
        self.assertEqual(t["TOTAL"]["Total Long Contracts"], t["TOTAL"]["Total Short Contracts"])

    def test_fii_stats(self):
        with with_book(FII_STATS):
            as_of, tables = p.parse_fii_stats(b"x")
        t = tables["FII derivatives statistics"]
        self.assertEqual(as_of, date(2026, 11, 6))
        self.assertEqual(list(t), ["INDEX FUTURES", "NIFTY FUTURES", "INDEX OPTIONS", "STOCK FUTURES"])
        self.assertEqual(t["INDEX OPTIONS"]["Buy · No. of contracts"], 12835658)
        self.assertEqual(t["INDEX OPTIONS"]["Open Interest At The End Of The Day · Amt in Crores"], 685865.45)

    def test_cm_category_file(self):
        with with_book(CM_CAT, CM_HISTORICAL):
            as_of, tables, notes, monthly = p.parse_nse_cat_xls(b"x")
        self.assertEqual(as_of, date(2026, 11, 6))
        self.assertEqual(list(tables), ["Category-wise turnover", "FPI Data as reported by NSDL"])   # dates dropped
        self.assertEqual(list(tables["Category-wise turnover"]), ["Bank", "Mutual Funds", "RETAIL", "OTHERS"])
        self.assertEqual(tables["FPI Data as reported by NSDL"]["FPI"],
                         {"Trade Date": "06-11-2026 and 08-11-2026", "Buy Value in Rs.Crores": 32089.6,
                          "Sell Value in Rs.Crores": 17360.23})
        self.assertEqual(len(notes), 2)
        self.assertEqual(sorted(monthly["months"]), ["2025-11", "2026-10"])
        self.assertEqual(monthly["months"]["2026-10"]["Total - DII · Buy Traded Value (Rs. Crores)"], 156793.56)

    def test_fo_category_file_with_two_tables(self):
        with with_book(FO_CAT_2023):
            as_of, tables, notes, monthly = p.parse_nse_cat_xls(b"x")
        self.assertEqual(as_of, date(2023, 11, 1))
        self.assertEqual(list(tables), ["Category", "Client Category Wise Turnover"])
        self.assertEqual(list(tables["Client Category Wise Turnover"]), ["AIF", "Insurance Companies", "RETAIL"])
        self.assertIsNone(tables["Client Category Wise Turnover"]["Insurance Companies"]["Buy Value in Rs.Crores"])
        self.assertIsNone(monthly)

    def test_nse_fiidii(self):
        doc = [{"buyValue": "19704.39", "category": "DII", "date": "11-Nov-2026", "netValue": "-8434.53",
                "sellValue": "28138.92"}]
        out = p.parse_nse_fiidii(doc, "NSE, BSE and MSEI")
        self.assertEqual(out[date(2026, 11, 11)]["NSE, BSE and MSEI"]["DII"]["Net Value (₹ Cr)"], -8434.53)

    def test_bse_participant(self):
        row = {"CLIENT_TYPE": "FII", "RD_DATE": "2026-11-11T00:00:00", **{k: 1 for k in p.BSE_PARTICIPANT_FIELDS}}
        as_of, tables = p.parse_bse_participant({"Table": [row]}, "Participant wise Open Interest (contracts)")
        self.assertEqual(as_of, date(2026, 11, 11))
        self.assertEqual(tables["Participant wise Open Interest (contracts)"]["FII"]["Index Options Put Short"], 1)
        self.assertEqual(p.parse_bse_participant({"Table": []}, "x"), (None, {}))

    def test_bse_fo_category_archive(self):
        doc = {"table": [{"DT_TM": "01 Nov 2023", "Prop_Buy": "112400.61", "Prop_Sell": "111882.52", "MF_Buy": "-",
                          "MF_Sell": "-", "FII_Buy": "6936.99", "FII_SELL": "6977.84"}]}
        cats = p.parse_bse_fo_cat(doc)[date(2023, 11, 1)]["Investor categorywise turnover, equity derivatives"]
        self.assertEqual(cats["Proprietary"], {"Buy (₹ Cr)": 112400.61, "Sell (₹ Cr)": 111882.52})
        self.assertEqual(cats["FII / FPI"]["Sell (₹ Cr)"], 6977.84)
        self.assertIsNone(cats["Mutual Funds"]["Buy (₹ Cr)"])

    def test_bse_cash_categories(self):
        mkt = {"Table": [
            {"REPORTING_DATE": "2026-11-11T00:00:00", "ORDERFLAG": "1D", "CLIENT_TYPE_OWN": "OWN",
             "PURCHASE_OWN": 41548717713.73, "SALE_OWN": 37178017248.08, "NET_OWN": 4370700465.65,
             "CLIENT_TYPE_DFI": None, "PURCHASE_DFI": None, "SALE_DFI": None, "NET_DFI": None,
             "BUY_TOTAL": 1e11, "SELL_TOTAL": 1e11, "NET_TOTAL": 0.0},
            {"REPORTING_DATE": "2026-11-11T00:00:00", "ORDERFLAG": "2MS", "CLIENT_TYPE_OWN": "OWN",
             "PURCHASE_OWN": 9e12, "SALE_OWN": 9e12, "NET_OWN": 0.0}]}
        combined = {"Table": [{"REPORTING_DATE": "2026-11-11T00:00:00", "ORDERFLAG": "1D",
                               "CLIENT_TYPE_BSENSE": "FII_BSENSE", "PURCHASE_BSENSE": 300872100000.0,
                               "SALE_BSENSE": 175238800000.0, "NET_BSENSE": 125633300000.0}]}
        day = p.parse_bse_cash_cat(mkt, combined)[date(2026, 11, 11)]
        own = day["BSE cash market, by client type"]["Own (Proprietary)"]
        self.assertEqual(own["Purchase (₹ Cr)"], 4154.8718)                 # rupees → ₹ Cr; month-to-date row left out
        self.assertNotIn("DFI", day["BSE cash market, by client type"])     # a category BSE did not report that day
        self.assertEqual(day["FII / FPI and DII, BSE + NSE + MSEI"]["FII / FPI"]["Purchase (₹ Cr)"], 30087.21)

    def test_nsdl_days_and_totals(self):
        days = p.parse_nsdl(NSDL_HTML)
        self.assertEqual(sorted(days), [date(2023, 11, 1), date(2023, 11, 2)])
        d1 = days[date(2023, 11, 1)]
        self.assertEqual(d1["FPI investment"]["Equity · Stock Exchange"]["Net Investment (₹ Cr)"], -577.37)
        self.assertEqual(d1["FPI investment"]["Equity · Primary market & others"]["Gross Purchases (₹ Cr)"], 146.41)
        self.assertEqual(d1["Conversion"]["1 USD to INR"], {"Rate (₹)": 83.2692})
        self.assertEqual(d1["FPI derivative trades"]["Index Options"]["Open Interest · No. of Contracts"], 4294035)
        self.assertEqual(list(d1["FPI derivative trades"]), ["Index Futures", "Index Options"])
        # 'Total for November' and the total under it are not the last day's figures
        self.assertEqual(days[date(2023, 11, 2)]["FPI investment"]["Total"]["Net Investment (₹ Cr)"], -1726.37)


class MarketPulse(unittest.TestCase):
    def test_current_layout(self):
        t = p.parse_pulse_text(PULSE_2026)["Share of client participation in NSE cash market segment (%)"]
        self.assertEqual(t["months"], ["Aug-26", "Jul-26", "Aug-25"])
        self.assertEqual(list(t["rows"]), ["Corporates", "DIIs", "Foreign Investors", "Individuals", "Prop", "Others"])
        self.assertEqual(t["rows"]["DIIs"], {"Aug-26": 12.7, "Jul-26": 13.9, "Aug-25": 14.5})   # bps left out

    def test_2023_layout_with_wrapped_label_and_section(self):
        t = p.parse_pulse_text(PULSE_2023)["Share of client participation in NSE's CM segment (%)"]
        self.assertEqual(t["months"], ["Nov-23", "Oct-23"])
        self.assertEqual(t["rows"]["Cash Segment · Individual investors"], {"Nov-23": 35.7, "Oct-23": 35.4})
        self.assertEqual(len(t["rows"]), 6)

    def test_annual_review_layout(self):
        t = p.parse_pulse_text(PULSE_ANNUAL)["Share of client participation in NSE cash market segment (%) in 2025"]
        self.assertEqual(t["months"][0], "Jan-25")
        self.assertEqual(len(t["months"]), 12)
        self.assertEqual(t["rows"]["Foreign Investors"]["Nov-25"], 17.2)

    def test_checks_flag_columns_that_dont_add_up(self):
        tables = p.parse_pulse_text(PULSE_2026)
        self.assertEqual(p.pulse_checks(tables), [])
        tables["Share of client participation in NSE cash market segment (%)"]["rows"]["Others"]["Aug-26"] = 9.6
        self.assertEqual(len(p.pulse_checks(tables)), 1)


class Reply:
    def __init__(self, status, content=b""):
        self.status_code, self.content = status, content


class FakeSession:
    def __init__(self, replies):
        self.replies, self.urls = replies, []

    def get(self, url, **kw):
        self.urls.append(url)
        for key, reply in self.replies.items():
            if key in url:
                if isinstance(reply, Exception):
                    raise reply
                return reply
        return Reply(404)


def empty_store():
    return {"days": {}, "unavailable": {}, "months_read": {}, "editions": {}, "extra": {}, "notes_published": None}


def oi_csv(d):
    return NSE_OI_CSV.replace("Nov 06, 2026", f"{p.MONTHS[d.month - 1]} {d.day:02d}, {d.year}").encode()


class Runs(unittest.TestCase):
    def run_days(self, key, session, st, dates, manual=False, budget=600):
        run = p.Run(manual, 100, budget, "2026-11-12T00:00:00Z", pause=lambda s: None)
        return p.run_days(key, session, st, dates, run, start=date(2026, 10, 1))

    def test_window_and_backfill(self):
        dates = [date(2026, 10, d) for d in (26, 27, 28, 29, 30)] + [date(2026, 11, d) for d in (2, 3, 4, 5, 6)]
        served = {f"fao_participant_oi_{d:%d%m%Y}": Reply(200, oi_csv(d)) for d in dates if d != date(2026, 10, 27)}
        st = empty_store()
        changed, errors, ok = self.run_days("nse_fo_oi", FakeSession(served), st, dates)
        self.assertEqual((changed, errors, ok), (9, 0, 10))
        self.assertEqual(st["unavailable"], {"2026-10-27": "not published (HTTP 404)"})   # outside the window
        rec = st["days"]["2026-11-06"]
        self.assertEqual(rec["tables"][next(iter(rec["tables"]))]["rows"]["FII"][0], 48656)
        # a second run re-reads the window and changes nothing
        changed, _, _ = self.run_days("nse_fo_oi", FakeSession(served), st, dates)
        self.assertEqual(changed, 0)

    def test_file_for_another_day(self):
        d = date(2026, 11, 6)
        session = FakeSession({"fao_participant_oi_06112026": Reply(200, oi_csv(date(2026, 11, 5)))})
        st = empty_store()
        self.run_days("nse_fo_oi", session, st, [date(2026, 10, 1), d], budget=600)
        self.assertNotIn("2026-11-06", st["days"])
        self.assertNotIn("2026-11-05", st["days"])          # not a source keyed on the date inside

    def test_category_files_keyed_on_their_inside_date(self):
        # NSE named 9 Nov 2026's CM category file cat_turnover_111126.xls
        book = [row[:] for row in CM_CAT]
        for row in book:
            if row[0] == "06-Nov-2026":
                row[0] = "09-Nov-2026"
        session = FakeSession({"cat_turnover_111126": Reply(200, b"x" * 100), "cat_turnover_091126": Reply(404)})
        st = empty_store()
        with with_book(book):
            changed, _, _ = self.run_days("nse_cm_cat", session, st, [date(2026, 11, 9), date(2026, 11, 11)])
        self.assertEqual(changed, 1)
        self.assertEqual(list(st["days"]), ["2026-11-09"])

    def test_refusal_stops_the_source(self):
        dates = [date(2026, 11, d) for d in (2, 3, 4)]
        session = FakeSession({"fao_participant_oi": Reply(403)})
        changed, errors, ok = self.run_days("nse_fo_oi", session, empty_store(), dates)
        self.assertEqual((changed, errors, ok), (0, 1, 0))
        self.assertEqual(len(session.urls), 1)

    def test_months_and_store_round_trip(self):
        def fake_month(session, y, m, today):
            return "url", b"body", {date(y, m, 2): {"T": {"A": {"v": float(m)}}}}
        st = empty_store()
        run = p.Run(False, 0, 600, "2026-11-12T00:00:00Z", pause=lambda s: None)
        with mock.patch.object(p, "fetch_bse_fo_cat_month", fake_month), \
                mock.patch.object(p, "HISTORY_START", date(2026, 8, 1)):
            changed, errors, ok = p.run_months("bse_fo_cat", None, st, run, date(2026, 11, 12))
        self.assertEqual((changed, errors, ok), (4, 0, 4))
        self.assertEqual(sorted(st["months_read"]), ["2026-08", "2026-09"])     # the last two are always re-read
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(p, "DATA_DIR", Path(tmp)):
            p.write_if_changed(p.store_path("bse_fo_cat"), p.build_doc("bse_fo_cat", st, "now"))
            again = p.load_store("bse_fo_cat")
        self.assertEqual(again["days"], st["days"])
        self.assertEqual(again["months_read"], st["months_read"])


def day(iso, title, rows):
    return {"date": iso, "tables": p.compact({title: rows})}


class Report(unittest.TestCase):
    def test_views(self):
        vol = "Participant wise Trading Volume (no. of contracts) in Equity Derivatives"
        doc = {"days": [
            day("2026-10-30", vol, {"FII": {"Total Long Contracts": 10, "Total Short Contracts": 10},
                                    "Pro": {"Total Long Contracts": 30, "Total Short Contracts": 30},
                                    "TOTAL": {"Total Long Contracts": 40, "Total Short Contracts": 40}}),
            day("2026-11-02", vol, {"FII": {"Total Long Contracts": 20, "Total Short Contracts": 20},
                                    "Pro": {"Total Long Contracts": 20, "Total Short Contracts": 20},
                                    "TOTAL": {"Total Long Contracts": 40, "Total Short Contracts": 40}}),
            day("2026-11-03", vol, {"FII": {"Total Long Contracts": 40, "Total Short Contracts": 40},
                                    "Pro": {"Total Long Contracts": 0, "Total Short Contracts": 0},
                                    "TOTAL": {"Total Long Contracts": 40, "Total Short Contracts": 40}})]}
        view = next(v for v in rpt.VIEWS if v["id"] == "nse_fo_vol")
        series, days, shares = rpt.view_series(view, doc)
        self.assertEqual(days, {"2026-10": 1, "2026-11": 2})
        self.assertEqual(series["FII"], {"2026-10": 20, "2026-11": 60})    # daily average of long + short
        self.assertEqual(shares["FII"], {"2026-10": 25.0, "2026-11": 75.0})
        self.assertNotIn("TOTAL", shares)

    def test_spellings_merge_and_net_sums(self):
        title = "Category-wise turnover"
        doc = {"days": [day("2025-11-03", title, {"Retail": {"Buy Value in Rs.": 10.0, "Sell Value in Rs.": 4.0}}),
                        day("2026-11-03", title, {"RETAIL": {"Buy Value in Rs.Crores": 5.0,
                                                             "Sell Value in Rs.Crores": 7.0}}),
                        day("2026-11-04", title, {"RETAIL": {"Buy Value in Rs.Crores": 1.0,
                                                             "Sell Value in Rs.Crores": 1.0}})]}
        view = next(v for v in rpt.VIEWS if v["id"] == "nse_cm_cat_net")
        series, _, _ = rpt.view_series(view, doc)
        self.assertEqual(series, {"RETAIL": {"2025-11": 6.0, "2026-11": -2.0}})   # one series, today's spelling

    def test_pulse_series_aliases_and_newest_edition(self):
        doc = {"editions": [
            {"edition": "2023-12", "tables": p.parse_pulse_text(PULSE_2023)},
            {"edition": "2026-09", "tables": p.parse_pulse_text(PULSE_2026)},
            {"edition": "2026-01", "tables": p.parse_pulse_text(PULSE_ANNUAL)}]}
        s = rpt.pulse_series(doc)["Cash market"]
        self.assertEqual(s["Foreign Investors"]["2023-11"], 16.3)   # 'FPI' in the 2023 edition
        self.assertEqual(s["Individuals"]["2023-11"], 35.7)
        self.assertEqual(s["Prop"]["2026-08"], 31.7)
        self.assertEqual(s["DIIs"]["2025-08"], 14.5)                 # the 2026-09 edition's year-ago column

    def test_compare_months_and_markdown(self):
        self.assertEqual(rpt.compare_months("2026-01"), ["2026-01", "2025-12", "2025-01", "2024-01", "2023-01"])
        self.assertEqual(rpt.change(110, 100, "mean"), "+10.0 %")
        self.assertEqual(rpt.change(-5, 20, "sum"), "-25")
        doc = {"views": {"v": {"heading": "H", "unit": "₹ Cr", "aggregation": "mean", "days": {"2026-11": 3},
                               "series": {"FII": {"2026-11": 110.0, "2026-10": 100.0}},
                               "shares": {"FII": {"2026-11": 40.0}}}}, "pulse": {}}
        md = rpt.markdown(doc, "2026-11")
        self.assertIn("### H (₹ Cr)", md)
        self.assertIn("| FII | 110 (40.0 %) | 100 |", md)
        self.assertIn("+10.0 %", md)


class Wiring(unittest.TestCase):
    def test_every_source_has_notes_and_a_runner(self):
        for key, src in p.SOURCES.items():
            self.assertIn(key, p.NOTES)
            self.assertIn(src["unit"], ("day", "month", "latest", "edition"))
            if src["unit"] == "day":
                self.assertIn(src["cal"], ("nse", "bse"))
                self.assertEqual(len(src["io"]), 2)

    def test_report_views_read_known_sources(self):
        for view in rpt.VIEWS:
            self.assertIn(view["source"], p.SOURCES)

    def test_workflow_and_repo_wiring(self):
        wf = (ROOT / ".github" / "workflows" / "exchange-update.yml").read_text()
        self.assertIn("python scripts/participants_pipeline.py", wf)
        self.assertIn("python scripts/participants_report.py", wf)
        self.assertIn("git add dashboard/data/participants_*.json", wf)
        self.assertIn("📊 Participants update:", wf)              # vercel-ignore-build.sh skips these commits
        self.assertIn("- participants", wf)                       # the manual run's exchange choice
        self.assertIn('"📊 Participants update: "*', (ROOT / "dashboard" / "vercel-ignore-build.sh").read_text())
        reqs = (ROOT / "requirements.txt").read_text()
        self.assertIn("xlrd", reqs)
        self.assertIn("pdfplumber", reqs)
        self.assertIn(".new_participants_days_count", (ROOT / ".gitignore").read_text())


if __name__ == "__main__":
    unittest.main()
