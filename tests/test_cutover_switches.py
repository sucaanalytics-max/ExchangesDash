import io
import unittest

import helpers  # noqa: F401  (puts scripts/ on sys.path)

import bse_pipeline as bse
import excel_sync as xs
import nse_pipeline as nse


class FakeTable:
    def __init__(self, sink):
        self.sink = sink

    def upsert(self, rows, on_conflict=None):
        self.sink.extend(rows)
        return self

    def execute(self):
        return self


class FakeSupabase:
    def __init__(self):
        self.rows = []

    def table(self, _name):
        return FakeTable(self.rows)


class PipelineSourceTag(unittest.TestCase):
    def check(self, mod, value):
        saved = mod.PIPELINE_SOURCE
        mod.PIPELINE_SOURCE = value
        try:
            sb = FakeSupabase()
            mod.upsert_daily_records(sb, [{"date": "2026-10-19", "total_rev": 1.0, "_dt": object()}])
            return sb.rows[0]
        finally:
            mod.PIPELINE_SOURCE = saved

    def test_untagged_by_default(self):
        for mod in (nse, bse):
            self.assertNotIn("pipeline_source", self.check(mod, ""))

    def test_tagged_when_set(self):
        for mod in (nse, bse):
            row = self.check(mod, "exchangesdash")
            self.assertEqual(row["pipeline_source"], "exchangesdash")
            self.assertNotIn("_dt", row)


class FakeDrive:
    """OneDrive item: GET metadata (eTag), GET content, PUT content with If-Match."""

    def __init__(self, content=None, edit_on_put=0):
        self.content, self.version, self.puts, self.edit_on_put = content, 1, [], edit_on_put

    class R:
        def __init__(self, status, content=b"", js=None):
            self.status_code, self.content, self._js, self.text, self.headers = status, content, js, "", {}

        def json(self):
            return self._js

    def get(self, url, headers=None, timeout=None):
        if self.content is None:
            return self.R(404)
        if url.endswith("/content"):
            return self.R(200, self.content)
        return self.R(200, js={"eTag": f'"v{self.version}"'})

    def put(self, url, headers=None, data=None, timeout=None):
        if self.edit_on_put:                      # someone saves the workbook first
            self.edit_on_put -= 1
            self.version += 1
        if "If-Match" in headers and headers["If-Match"] != f'"v{self.version}"':
            return self.R(412)
        if headers.get("If-None-Match") == "*" and self.content is not None:
            return self.R(412)
        self.puts.append(headers)
        self.content, self.version = data, self.version + 1
        return self.R(200)


def workbook_bytes():
    buf = io.BytesIO()
    xs.create_new_workbook().save(buf)
    return buf.getvalue()


class ExcelIfMatch(unittest.TestCase):
    def run_sync(self, drive):
        saved = xs.requests.get, xs.requests.put, xs.time.sleep
        xs.requests.get, xs.requests.put, xs.time.sleep = drive.get, drive.put, lambda s: None
        try:
            for attempt in (1, 2):
                try:
                    return xs.sync_workbook("tok", [{"date": "2026-10-19", "total_rev": 1}], [])
                except xs.ExcelChanged:
                    if attempt == 2:
                        raise
        finally:
            xs.requests.get, xs.requests.put, xs.time.sleep = saved

    def test_upload_carries_if_match(self):
        drive = FakeDrive(workbook_bytes())
        self.run_sync(drive)
        self.assertEqual(drive.puts[0]["If-Match"], '"v1"')

    def test_concurrent_edit_is_retried_from_the_new_version(self):
        drive = FakeDrive(workbook_bytes(), edit_on_put=1)
        self.run_sync(drive)
        self.assertEqual(len(drive.puts), 1)
        self.assertEqual(drive.puts[0]["If-Match"], '"v2"')

    def test_persistent_conflict_never_overwrites(self):
        drive = FakeDrive(workbook_bytes(), edit_on_put=2)
        with self.assertRaises(xs.ExcelChanged):
            self.run_sync(drive)
        self.assertEqual(drive.puts, [])

    def test_new_file_uses_if_none_match(self):
        drive = FakeDrive(None)
        self.run_sync(drive)
        self.assertEqual(drive.puts[0]["If-None-Match"], "*")


if __name__ == "__main__":
    unittest.main()
