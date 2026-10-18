"""dashboard/vercel-ignore-build.sh, run against a throwaway git repo the way
Vercel runs it: from dashboard/, with VERCEL_GIT_COMMIT_MESSAGE and
VERCEL_GIT_PREVIOUS_SHA exported. Exit 0 = skip the build, 1 = build."""

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from helpers import ROOT

SCRIPT = ROOT / "dashboard" / "vercel-ignore-build.sh"
SKIP, BUILD = 0, 1


def git(repo, *args):
    return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True,
                          text=True).stdout.strip()


@unittest.skipUnless(shutil.which("git") and shutil.which("bash"), "needs git and bash")
class VercelIgnoreBuild(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        git(self.repo, "init", "-q")
        git(self.repo, "config", "user.email", "t@example.com")
        git(self.repo, "config", "user.name", "t")
        self.write("dashboard/app.js", "v1")
        self.write("dashboard/data/nse_dashboard_data.json", "{}")
        self.write("dashboard/data/nse_live.json", "{}")
        self.write("data/dashboard_data.json", "{}")
        shutil.copy(SCRIPT, self.repo / "dashboard" / SCRIPT.name)
        self.deployed = self.commit("initial")

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, path, text):
        p = self.repo / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)

    def commit(self, msg, **files):
        for path, text in files.items():
            self.write(path, text)
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "--allow-empty", "-m", msg)
        return git(self.repo, "rev-parse", "HEAD")

    def run_script(self, msg=None, prev="deployed"):
        env = {k: v for k, v in os.environ.items() if not k.startswith("VERCEL_")}
        if msg is not None:
            env["VERCEL_GIT_COMMIT_MESSAGE"] = msg
        if prev:
            env["VERCEL_GIT_PREVIOUS_SHA"] = self.deployed if prev == "deployed" else prev
        return subprocess.run(["bash", SCRIPT.name], cwd=self.repo / "dashboard", env=env,
                              capture_output=True, text=True).returncode

    def data_commit(self, msg):
        self.commit(msg, **{"dashboard/data/nse_dashboard_data.json": msg,
                            "data/dashboard_data.json": msg})
        return msg

    def test_bot_data_commits_skip(self):
        for msg in ["📊 NSE update: 2026-10-19 — 1 new day(s)",
                    "📊 BSE update: 2026-10-19 — 1 new day(s)",
                    "📊 MCX update: 2026-10-19 — 0 new day(s)",
                    "📈 NSE share analysis: 2026-10-19",
                    "📈 BSE share analysis: 2026-10-19",
                    "📈 MCX share analysis: 2026-10-19",
                    "📡 Live update: 2026-10-19 09:15 UTC",
                    "📡 BSE Live update: 2026-10-19 09:15 UTC",
                    "📡 MCX Live update: 2026-10-19 09:15 UTC"]:
            with self.subTest(msg=msg):
                self.assertEqual(self.run_script(self.data_commit(msg)), SKIP)

    def test_deploy_marker_builds(self):
        self.data_commit("📊 NSE update: 2026-10-19 — 1 new day(s)")
        msg = self.commit("🚀 Deploy data: 2026-10-19 [deploy]")
        self.assertEqual(self.run_script(msg), BUILD)
        self.assertEqual(self.run_script("📈 NSE share analysis: 2026-10-19 [deploy]"), BUILD)
        self.assertEqual(self.run_script(msg, prev=None), BUILD)

    def test_bot_commit_over_undeployed_code_builds(self):
        self.commit("Fix chart", **{"dashboard/app.js": "v2"})
        msg = self.data_commit("📈 BSE share analysis: 2026-10-19")
        self.assertEqual(self.run_script(msg), BUILD)

    def test_bot_commit_without_previous_deploy_builds(self):
        msg = self.data_commit("📊 NSE update: 2026-10-19 — 1 new day(s)")
        self.assertEqual(self.run_script(msg, prev=None), BUILD)

    def test_human_commits(self):
        self.assertEqual(self.run_script(self.data_commit("Regenerate NSE data")), BUILD)
        self.deployed = git(self.repo, "rev-parse", "HEAD")
        msg = self.commit("Refresh live sample", **{"dashboard/data/nse_live.json": "x"})
        self.assertEqual(self.run_script(msg), SKIP)
        self.assertEqual(self.run_script(self.commit("Fix chart", **{"dashboard/app.js": "v2"})), BUILD)

    def test_lookalike_messages_are_not_bot_commits(self):
        self.assertEqual(self.run_script(self.data_commit("📊 Revenue summary: new layout")), BUILD)

    def test_message_falls_back_to_git_log(self):
        self.data_commit("📈 MCX share analysis: 2026-10-19")
        self.assertEqual(self.run_script(msg=None), SKIP)


if __name__ == "__main__":
    unittest.main()
