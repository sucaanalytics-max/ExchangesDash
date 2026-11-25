"""analyst/: the read-only loader over the published data files."""

import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import analyst  # noqa: E402
from analyst import loader as L  # noqa: E402


def git(repo, *args, date=None):
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.com",
               GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.com")
    if date:
        env["GIT_AUTHOR_DATE"] = env["GIT_COMMITTER_DATE"] = date
    return subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True,
                          text=True, env=env).stdout.strip()


def write(repo, path, obj):
    full = os.path.join(repo, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w", encoding="utf-8") as f:
        f.write(obj if isinstance(obj, str) else json.dumps(obj))


def nse(*dates, special=()):
    rows = [{"date": d, "total_rev": 100.0, "cash_trades": None} for d in dates]
    return {"daily_all": rows, "daily": rows[-1:], "monthly": [], "quarterly": [], "weekly": [],
            "special_sessions": [{"date": d, "session": "muhurat", "total_rev": 5.0} for d in special]}


class Fixture(unittest.TestCase):
    """A throwaway repo whose origin/main has a side branch merged late."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        r = cls.repo = cls.tmp.name
        git(r, "init", "-q", "-b", "main")
        # day 1: data to 2026-01-01
        write(r, "dashboard/data/nse_dashboard_data.json", nse("2026-01-01", special=["2025-10-21"]))
        write(r, "dashboard/data/mcx_dashboard_data.json", {"daily_all": [
            {"date": "2024-08-30", "total_rev": 1.0, "modelled": True},
            {"date": "2024-09-02", "total_rev": 2.0, "modelled": False}],
            "monthly": [], "quarterly": [], "special_sessions": []})
        write(r, "dashboard/data/nse_commodity_daily.json", {"unavailable": {}, "daily": [
            {"date": "2026-01-01", "parser": 1, "rev": [0.1, 0.1], "ru": None,
             "nse": {"crude": {"f": [1, 2.0], "o": [3, 4.0, 0.5]}}, "mcx": None},
            {"date": "2026-01-02", "parser": 2, "rev": [0.2, 0.2], "xo": ["crude"],
             "ru": {"nse": {"crude": 0.01}, "mcx": {"crude": 3.0, "gold": 1.0}},
             "nse": {"crude": {"f": [1, 2.0]}, "gold": {"f": [1, 1.0]}},
             "mcx": {"crude": {"f": [10, 20.0], "o": [30, 40.0, 5.0]}, "gold": {"f": [5, 9.0]}}}]})
        write(r, "dashboard/data/mtf_daily.json", {
            "updated_at": "2026-01-02T00:00:00Z", "notes": [], "combined": [],
            "nse": [{"date": "2026-01-01", "closing_cr": 10.0, "flags": []}],
            "bse": [{"date": "2026-01-01", "amount_financed_cr": 1.0, "flags": ["spike"]},
                    {"date": "2026-01-02", "amount_financed_cr": 1.0, "flags": ["spike", "arithmetic"]}],
            "unavailable": {"nse": {"2021-04-01": "not published"}, "bse": {}}})
        write(r, "dashboard/data/participants_nse_fo_oi.json", {"days": [
            {"date": "2026-01-01", "tables": {"OI": {"fields": ["Long", "Short"],
                                                     "rows": {"Client": [5, 6], "FII": [7, 8]}}}}]})
        write(r, "dashboard/data/participants_nse_pulse.json", {"editions": [
            {"edition": "2026-01", "tables": {"Cash (%)": {"months": ["Dec-25", "Nov-25"],
                                                           "rows": {"DIIs": {"Dec-25": 14.0, "Nov-25": 13.0}}}}}]})
        write(r, "data/intraday/5m/2026-01.csv",
              "ts,symbol,open,high,low,close,volume\n2026-01-01 09:15,BSE.NS,1,2,0.5,1.5,\n")
        git(r, "add", "-A")
        git(r, "commit", "-q", "-m", "day 1", date="2026-01-01T12:00:00+05:30")
        cls.day1 = git(r, "rev-parse", "HEAD")

        # a PR branch commit dated 2 Jan that only reaches main on 4 Jan
        git(r, "checkout", "-q", "-b", "side")
        write(r, "dashboard/data/nse_dashboard_data.json", nse("2026-01-01", "2026-01-02", "2026-01-03"))
        git(r, "commit", "-qam", "side", date="2026-01-02T12:00:00+05:30")
        git(r, "checkout", "-q", "main")

        # day 3: the bots add 2026-01-02
        write(r, "dashboard/data/nse_dashboard_data.json", nse("2026-01-01", "2026-01-02"))
        git(r, "commit", "-qam", "day 3", date="2026-01-03T12:00:00+05:30")
        cls.day3 = git(r, "rev-parse", "HEAD")
        git(r, "merge", "-q", "--no-ff", "-X", "theirs", "-m", "merge side", "side",
            date="2026-01-04T12:00:00+05:30")
        git(r, "update-ref", "refs/remotes/origin/main", "HEAD")

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def snap(self, ref=None):
        return analyst.snapshot(ref, source="local", repo_dir=self.repo, fetch=False)

    # point in time
    def test_date_ref_takes_the_first_parent_line(self):
        s = self.snap("2026-01-02")       # the side commit is dated the 2nd but wasn't on main yet
        self.assertEqual(s.commit, self.day1)
        self.assertEqual(s.load("nse_daily").meta["last_date"], "2026-01-01")
        self.assertEqual(self.snap("2026-01-03").commit, self.day3)
        self.assertEqual(self.snap().load("nse_daily").meta["last_date"], "2026-01-03")

    def test_date_before_history_and_github_date_refs_raise(self):
        with self.assertRaises(ValueError):
            self.snap("2025-12-01")
        with self.assertRaises(ValueError):
            L._GitHubStore("2026-01-01")          # raises before any network call

    def test_worktree_reads_files_on_disk(self):
        s = self.snap(L.WORKTREE)
        self.assertEqual(s.load("nse_daily").meta["last_date"], "2026-01-03")

    # flattening and caveats
    def test_exchange_rows_meta_and_caveats(self):
        ds = self.snap(self.day1).load("nse_daily")
        self.assertEqual(len(ds), 1)
        self.assertEqual(ds.meta["commit"], self.day1)
        self.assertTrue(any("special_sessions" in c for c in ds.meta["caveats"]))
        self.assertTrue(any("cash_trades 1" in c for c in ds.meta["caveats"]))   # null, never 0
        sp = self.snap(self.day1).load("nse_special_sessions")
        self.assertEqual([r["date"] for r in sp], ["2025-10-21"])

    def test_mcx_modelled_rows_kept_and_flagged(self):
        ds = self.snap().load("mcx_daily")
        self.assertEqual(len(ds), 2)
        self.assertTrue(any(c.startswith("1 rows are modelled") for c in ds.meta["caveats"]))

    def test_commodity_long_rows_and_expiry_flag(self):
        rows = self.snap().load("nse_commodity_daily").rows
        day1 = [r for r in rows if r["date"] == "2026-01-01"]
        self.assertEqual([(r["side"], r["underlying"]) for r in day1], [("nse", "crude")])  # mcx null
        self.assertIsNone(day1[0]["nse_option_expiry"])             # parser 1: unknown
        self.assertEqual(day1[0]["opt_premium_cr"], 0.5)
        day2 = {(r["side"], r["underlying"]): r for r in rows if r["date"] == "2026-01-02"}
        self.assertTrue(day2[("nse", "crude")]["nse_option_expiry"])
        self.assertFalse(day2[("nse", "gold")]["nse_option_expiry"])   # parser 2, not in xo
        self.assertIsNone(day2[("mcx", "crude")]["nse_option_expiry"])
        self.assertEqual(day2[("mcx", "crude")]["txn_rev_cr"], 3.0)
        self.assertIsNone(day2[("nse", "gold")]["opt_contracts"])

    def test_mtf_flags_and_unavailable_in_caveats(self):
        cav = self.snap().load("mtf_bse").meta["caveats"]
        self.assertIn("arithmetic 1, spike 2", " ".join(cav))
        self.assertTrue(any("NSE: 1 dates" in c for c in cav))

    def test_participants_long_format(self):
        s = self.snap()
        rows = s.load("participants_nse_fo_oi").rows
        self.assertEqual(len(rows), 4)
        self.assertIn({"date": "2026-01-01", "table": "OI", "category": "FII", "field": "Short",
                       "value": 8}, rows)
        pulse = s.load("participants_nse_pulse").rows
        self.assertIn({"edition": "2026-01", "table": "Cash (%)", "category": "DIIs",
                       "field": "Nov-25", "value": 13.0}, pulse)

    def test_csv_numbers_and_blanks(self):
        r = self.snap().load("intraday_5m").rows[0]
        self.assertEqual((r["ts"], r["symbol"], r["close"], r["volume"]),
                         ("2026-01-01 09:15", "BSE.NS", 1.5, None))

    def test_missing_file_and_unknown_name(self):
        with self.assertRaises(FileNotFoundError):
            self.snap().load("bse_daily")
        with self.assertRaises(KeyError):
            self.snap().load("nope")


class RegistryMatchesRepo(unittest.TestCase):
    def test_every_required_path_is_committed(self):
        missing = [s["path"] for s in L.REGISTRY.values()
                   if not s["optional"] and not os.path.exists(os.path.join(ROOT, s["path"]))]
        self.assertEqual(missing, [])

    def test_participant_sources_match_the_files(self):
        files = {f[len("participants_"):-len(".json")] for f in os.listdir(os.path.join(ROOT, "dashboard/data"))
                 if f.startswith("participants_") and f not in ("participants_daily.json",
                                                                 "participants_monthly.json")}
        self.assertEqual(files, set(L.PARTICIPANT_SOURCES))


if __name__ == "__main__":
    unittest.main()
