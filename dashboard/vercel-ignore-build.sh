#!/bin/bash
# Vercel "Ignored Build Step" (see vercel.json). Runs from the project's root
# directory (dashboard/). Exit 0 = skip this build, exit 1 = build.
#
# 1. A commit message containing "[deploy]" always builds. The daily workflow
#    pushes one after the day's last exchange update (and after manual runs).
# 2. Bot data commits ("📊 NSE update: …", "📈 BSE share analysis: …",
#    "📡 Live update: …") are skipped when everything changed since the last
#    deploy is under data/: the day's data goes out with the "[deploy]" commit.
# 3. Any other commit is skipped only when the live/intraday JSON alone
#    changed: the dashboard reads those through /api/live.
# Anything uncertain (no previous deploy, commit not fetchable) builds.

MSG="${VERCEL_GIT_COMMIT_MESSAGE:-$(git log -1 --format=%B HEAD 2>/dev/null)}"

case "$MSG" in
  *"[deploy]"*)
    echo "Commit asks for a deploy — building"
    exit 1 ;;
  "📊 "[NBM][SC][EX]" update: "* | "📈 "[NBM][SC][EX]" share analysis: "* | \
  "📡 Live update: "* | "📡 "[BM][SC][EX]" Live update: "*)
    BOT=1 ;;
esac

PREV="$VERCEL_GIT_PREVIOUS_SHA"
[ -n "$PREV" ] || exit 1

# Vercel clones shallowly; fetch the last deployed commit if it is not present.
if ! git cat-file -e "$PREV^{commit}" 2>/dev/null; then
  git fetch -q --depth=1000 origin "$PREV" 2>/dev/null || exit 1
fi

if [ -n "$BOT" ]; then
  EXCLUDE=(':(exclude)data/*')
else
  EXCLUDE=(':(exclude)data/*_live.json' ':(exclude)data/*_live_hourly.json' ':(exclude)data/*_hourly_history.json')
fi

if git diff --quiet "$PREV" HEAD -- . "${EXCLUDE[@]}"; then
  if [ -n "$BOT" ]; then
    echo "Bot data commit, only data changed since $PREV — skipping build (deploys with the next [deploy] commit)"
  else
    echo "Only live data changed since $PREV — skipping build"
  fi
  exit 0
fi
exit 1
