#!/bin/bash
# Vercel "Ignored Build Step" (see vercel.json). Runs from the project's root
# directory (dashboard/). Exit 0 = skip this build, exit 1 = build.
#
# Skips deployments whose only changes since the last successful deploy are
# the live/intraday JSON the pollers commit every 5 minutes — the dashboard
# reads those through /api/live, so they need no deploy. Anything uncertain
# (no previous deploy, commit not fetchable) builds.

PREV="$VERCEL_GIT_PREVIOUS_SHA"
[ -n "$PREV" ] || exit 1

# Vercel clones shallowly; fetch the last deployed commit if it is not present.
if ! git cat-file -e "$PREV^{commit}" 2>/dev/null; then
  git fetch -q --depth=1000 origin "$PREV" 2>/dev/null || exit 1
fi

if git diff --quiet "$PREV" HEAD -- . \
     ':(exclude)data/*_live.json' \
     ':(exclude)data/*_live_hourly.json' \
     ':(exclude)data/*_hourly_history.json'; then
  echo "Only live data changed since $PREV — skipping build"
  exit 0
fi
exit 1
