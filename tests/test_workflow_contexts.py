"""Every workflow under .github/workflows: expressions only use the contexts GitHub
allows where they appear. A job-level `env:`, `concurrency:` or `runs-on:` that reads
`runner`, `job`, `steps` or `env` makes GitHub reject the whole workflow
("Unrecognized named-value"), so no run ever starts (excel-mirror.yml, Nov 2026).
CI has no YAML parser, so the job blocks are read by indentation."""

import re
import unittest

from helpers import ROOT

WORKFLOWS = sorted((ROOT / ".github" / "workflows").glob("*.y*ml"))
FORBIDDEN = re.compile(r"\$\{\{[^}]*\b(runner|job|steps|env)\.")


def jobs(text):
    """{job name: its lines} for the top-level `jobs:` mapping."""
    body = text[text.index("\njobs:\n") + len("\njobs:\n"):]
    out, name = {}, None
    for line in body.splitlines():
        m = re.match(r"^  ([\w-]+):\s*$", line)
        if m:
            name = m.group(1)
            out[name] = []
        elif re.match(r"^\S", line):
            break
        elif name:
            out[name].append(line)
    return out


def job_level(lines, key):
    """The lines of a job's own `key:` (4-space indent), its value and nested block."""
    got, inside = [], False
    for line in lines:
        if re.match(rf"^    {key}:", line):
            inside = True
            got.append(line)
        elif inside and (line.startswith("      ") or not line.strip()):
            got.append(line)
        elif inside:
            break
    return got


class JobLevelContexts(unittest.TestCase):
    def test_found_the_workflows(self):
        self.assertIn("excel-mirror.yml", [p.name for p in WORKFLOWS])

    def test_no_step_or_runner_contexts_in_job_env_concurrency_or_runs_on(self):
        for wf in WORKFLOWS:
            for name, lines in jobs(wf.read_text()).items():
                for key in ("env", "concurrency", "runs-on"):
                    for line in job_level(lines, key):
                        with self.subTest(workflow=wf.name, job=name, key=key, line=line.strip()):
                            self.assertIsNone(FORBIDDEN.search(line))

    def test_the_check_catches_it(self):
        text = "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    env:\n      X: ${{ runner.temp }}/x\n    steps:\n      - run: echo\n"
        lines = job_level(jobs(text)["a"], "env")
        self.assertTrue(any(FORBIDDEN.search(x) for x in lines))


if __name__ == "__main__":
    unittest.main()
