#!/bin/bash
# Cloud sessions start in a fresh container: install what the CLAUDE.md
# "Verify before pushing" list needs (the unit tests use numpy, requests and
# openpyxl, as in checks.yml; pyflakes for the lint step). Never blocks or
# fails a session: a slow or unreachable index just leaves the install undone.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi
timeout 120 python3 -m pip install --quiet --disable-pip-version-check \
  pyflakes numpy requests openpyxl >/dev/null 2>&1 \
  || echo "session-start: pip install did not finish; run it by hand if tests need it" >&2
exit 0
