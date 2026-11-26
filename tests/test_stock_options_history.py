"""NSE stock futures and options history (scripts/stock_options_history.py): the bhavcopy's
rows filtered to the symbols, nearest option expiries and strike band; month files written
once per day; planning and a run with the network faked."""

import csv
import io
import json
import tempfile
import unittest
import zipfile
from datetime import date
from pathlib import Path

import helpers  # noqa: F401  (puts scripts/ on sys.path)

import stock_options_history as soh

COLS = ["TradDt", "BizDt", "Sgmt", "Src", "FinInstrmTp", "FinInstrmId", "ISIN", "TckrSymb", "SctySrs",
        "XpryDt", "FininstrmActlXpryDt", "StrkPric", "OptnTp", "FinInstrmNm", "OpnPric", "HghPric", "LwPric",
        "ClsPric", "LastPric", "PrvsClsgPric", "UndrlygPric", "SttlmPric", "OpnIntrst", "ChngInOpnIntrst",
        "TtlTradgVol", "TtlTrfVal", "TtlNbOfTxsExctd", "SsnId", "NewBrdLotQty", "Rmks"]


def row(tp, sym, xp, strike="", opt="", close="100", und="1000", vol="3", d="2026-11-20"):
    return {"TradDt": d, "BizDt": d, "Sgmt": "FO", "Src": "NSE", "FinInstrmTp": tp, "TckrSymb": sym,
            "XpryDt": xp, "StrkPric": strike, "OptnTp": opt, "OpnPric": "0", "HghPric": "0", "LwPric": "0",
            "ClsPric": close, "SttlmPric": close, "UndrlygPric": und, "OpnIntrst": "400",
            "TtlTradgVol": vol, "NewBrdLotQty": "200"}


def make_zip(rows):
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=COLS, extrasaction="ignore")
    w.writeheader()
    for r in rows:
        w.writerow({c: r.get(c, "") for c in COLS})
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        z.writestr("BhavCopy_NSE_FO_0_0_0_20261120_F_0000.csv", buf.getvalue())
    return out.getvalue()


DAY = [
    row("STF", "MCX", "2026-11-24", close="1010.5"),
    row("STF", "MCX", "2026-12-29", close="1020"),
    row("STO", "MCX", "2026-11-24", "950", "PE", "12.35"),
    row("STO", "MCX", "2026-11-24", "1300", "CE", "0.5"),      # outside ±25 %: dropped
    row("STO", "MCX", "2026-12-29", "1000", "CE", "45"),
    row("STO", "MCX", "2027-01-26", "1000", "PE", "60"),       # third expiry: dropped
    row("STO", "INFY", "2026-11-24", "1500", "CE", "10"),      # other symbol: dropped
    row("IDO", "MCX", "2026-11-24", "1000", "CE", "10"),       # not a stock contract: dropped
]


class ParseTest(unittest.TestCase):
    def test_filters_and_fields(self):
        td, out = soh.parse_bhavcopy(make_zip(DAY))
        self.assertEqual(td, "2026-11-20")
        self.assertEqual(list(out), ["MCX"])
        got = [(r["type"], r["expiry"], r["strike"], r["close"]) for r in out["MCX"]]
        self.assertEqual(got, [
            ("FUT", "2026-11-24", "0", "1010.5"),
            ("FUT", "2026-12-29", "0", "1020"),
            ("CE", "2026-12-29", "1000", "45"),
            ("PE", "2026-11-24", "950", "12.35"),
        ])
        r = out["MCX"][0]
        self.assertEqual((r["contracts"], r["oi"], r["lot"], r["underlying"]), ("3", "400", "200", "1000"))

    def test_symbol_absent(self):
        _, out = soh.parse_bhavcopy(make_zip([row("STF", "INFY", "2026-11-24")]))
        self.assertEqual(out, {})


class StoreTest(unittest.TestCase):
    def test_written_once_and_sorted(self):
        with tempfile.TemporaryDirectory() as tmp:
            _, out = soh.parse_bhavcopy(make_zip(DAY))
            self.assertEqual(soh.write_day(tmp, "MCX", "2026-11-20", out["MCX"]), 4)
            self.assertEqual(soh.write_day(tmp, "MCX", "2026-11-20", out["MCX"]), 0)
            earlier = [dict(r, date="2026-11-19") for r in out["MCX"][:1]]
            soh.write_day(tmp, "MCX", "2026-11-19", earlier)
            with open(Path(tmp) / "MCX" / "2026-11.csv") as fh:
                rows = list(csv.DictReader(fh))
            self.assertEqual([r["date"] for r in rows], ["2026-11-19"] + ["2026-11-20"] * 4)
            self.assertEqual(soh.stored_days(tmp, ("MCX",)), {"2026-11-19", "2026-11-20"})


class PlanTest(unittest.TestCase):
    def test_newest_missing_first(self):
        days = ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19"]
        unav = {"unavailable": ["2026-11-18"], "empty": ["2026-11-16"]}
        self.assertEqual(soh.plan(days, {"2026-11-19"}, unav), ["2026-11-17"])
        self.assertEqual(soh.plan(days, {"2026-11-19"}, unav, retry=True), ["2026-11-18", "2026-11-17"])
        self.assertEqual(soh.plan(days, set(), unav, max_days=1), ["2026-11-19"])

    def test_trading_days_add_weekdays_after_the_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "nse.json"
            p.write_text(json.dumps({"daily_all": [{"date": "2026-11-19"}, {"date": "2026-11-20"}]}))
            got = soh.trading_days(date(2026, 11, 20), date(2026, 11, 24), p)
        self.assertEqual(got, ["2026-11-20", "2026-11-23", "2026-11-24"])


class Resp:
    def __init__(self, status, content=b""):
        self.status_code, self.content = status, content


class FakeSession:
    def __init__(self, replies):
        self.replies = replies

    def get(self, url, **kw):
        return self.replies[url.split("_F_0000")[0][-8:]]


class RunTest(unittest.TestCase):
    def test_run(self):
        replies = {
            "20261120": Resp(200, make_zip(DAY)),
            "20261119": Resp(404),                                   # recent: not posted yet
            "20261102": Resp(404),                                   # old: unavailable
            "20261118": Resp(200, make_zip([row("STF", "INFY", "2026-11-24", d="2026-11-18")])),
        }
        with tempfile.TemporaryDirectory() as tmp:
            days, rows, latest, unav, refused = soh.run(
                FakeSession(replies), ["2026-11-20", "2026-11-19", "2026-11-18", "2026-11-02"],
                date(2026, 11, 21), out_dir=tmp, pause=lambda s: None)
        self.assertEqual((days, rows, latest, refused), (1, 4, "2026-11-20", False))
        self.assertEqual(unav, {"unavailable": ["2026-11-02"], "empty": ["2026-11-18"]})

    def test_refused_stops(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = soh.run(FakeSession({"20261120": Resp(403)}), ["2026-11-20", "2026-11-19"],
                          date(2026, 11, 21), out_dir=tmp, pause=lambda s: None)
        self.assertTrue(out[4])
        self.assertEqual(out[0], 0)


if __name__ == "__main__":
    unittest.main()
