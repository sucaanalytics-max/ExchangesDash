"""dashboard/js/*.js: index.html loads every file, in name order, as classic
scripts sharing one global scope, and each file parses on its own."""

import subprocess
import unittest

from helpers import DASHBOARD, JS_FILES, NODE


class DashboardScripts(unittest.TestCase):
    def test_index_html_loads_every_file_in_name_order(self):
        on_disk = sorted(f"js/{p.name}" for p in (DASHBOARD / "js").glob("*.js"))
        self.assertEqual(JS_FILES, on_disk)
        # init() runs at the end of the last file, once everything is declared
        self.assertEqual(JS_FILES[-1], "js/99-init.js")
        self.assertFalse((DASHBOARD / "app.js").exists())

    @unittest.skipUnless(NODE, "node not installed")
    def test_each_file_parses(self):
        for f in JS_FILES:
            with self.subTest(file=f):
                out = subprocess.run(
                    [NODE, "-e", "new (require('vm').Script)(require('fs').readFileSync(process.argv[1], 'utf8'), {filename: process.argv[1]})",
                     str(DASHBOARD / f)], capture_output=True, text=True)
                self.assertEqual(out.returncode, 0, out.stderr)


if __name__ == "__main__":
    unittest.main()
