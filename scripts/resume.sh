#!/usr/bin/env bash
# Resume the bookmark downloads after a restart or crash.
#
#   scripts/resume.sh status   progress, scheduler state, next slots (default)
#   scripts/resume.sh check    update deps, run tests, report, verify the folder
#   scripts/resume.sh start    check, then start the scheduler in the background
#   scripts/resume.sh stop     stop the background scheduler
#
# Settings come from resume.local.env (git-ignored; copy resume.local.env.example).
# The Anna's Archive key is never stored: `start` takes it from $ANNAS_KEY or
# asks for it (input hidden).
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f resume.local.env ]]; then
  echo "Missing resume.local.env — copy resume.local.env.example and fill it in." >&2
  exit 1
fi
# shellcheck source=/dev/null
source resume.local.env
: "${BOOKMARKS:?set BOOKMARKS in resume.local.env}"
: "${DOWNLOAD_DIR:?set DOWNLOAD_DIR in resume.local.env}"
: "${SLOTS:?set SLOTS in resume.local.env}"
EVERY="${EVERY:-18}"
TLD="${TLD:-}"

# macOS ships bash 3.2: with `set -u` an empty array can't be expanded plainly,
# hence the ${arr[@]+"${arr[@]}"} form below.
tld_args=()
if [[ -n "$TLD" ]]; then tld_args=(--tld "$TLD"); fi

running_pid() {
  [[ -f scheduler.pid ]] || return 1
  local pid
  pid="$(cat scheduler.pid)"
  kill -0 "$pid" 2>/dev/null && echo "$pid"
}

check() {
  echo "== Dependencies"; npm install --silent --no-audit --no-fund
  echo "== Tests"; npm test --silent 2>&1 | grep -E "^# (pass|fail)"
  echo "== Status"; node scripts/queue-bookmarks.mjs --status
  echo "== Verifying $DOWNLOAD_DIR"; node scripts/queue-bookmarks.mjs --verify "$DOWNLOAD_DIR"
}

case "${1:-status}" in
  status)
    node scripts/queue-bookmarks.mjs --status
    ;;
  check)
    check
    ;;
  start)
    if pid="$(running_pid)"; then
      echo "Scheduler already running (pid $pid) — nothing to do."
      exit 0
    fi
    check
    if [[ -z "${ANNAS_KEY:-}" ]]; then
      read -rsp "Anna's Archive key (input hidden): " ANNAS_KEY; echo
    fi
    export ANNAS_KEY
    at_args=()
    for slot in $SLOTS; do at_args+=(--at "$slot"); done
    # nohup + background: keeps running after this terminal or agent session ends.
    nohup node scripts/scheduler.mjs "$BOOKMARKS" --dir "$DOWNLOAD_DIR" \
      "${at_args[@]}" --every "$EVERY" ${tld_args[@]+"${tld_args[@]}"} >> scheduler.out 2>&1 &
    sleep 3
    if pid="$(running_pid)"; then
      echo "== Scheduler started (pid $pid). Follow it with: tail -f scheduler.log"
      tail -n 5 scheduler.log
    else
      echo "Scheduler did not start — see scheduler.out:" >&2
      tail -n 20 scheduler.out >&2
      exit 1
    fi
    ;;
  stop)
    if pid="$(running_pid)"; then kill "$pid" && echo "Stopped scheduler (pid $pid)."; else echo "Scheduler is not running."; fi
    ;;
  *)
    echo "Usage: scripts/resume.sh [status|check|start|stop]" >&2
    exit 1
    ;;
esac
