#!/bin/bash
# dev-watchdog.sh — keep the Next.js dev server alive inside the 4GB sandbox.
#
# Why this exists: this app's dev SSR graph (wagmi + Reown AppKit + cdp-sdk,
# evaluated for every route) legitimately peaks around 2.0–2.5GB RSS in
# next-server. With a browser previewing the app on a 4GB box, the kernel
# OOM-killer occasionally kills next-server. Rather than silently dying
# ("This site can't be reached" until a human restarts it), this watchdog
# recycles the dev server automatically. The Turbopack persistent cache makes
# restarts cheap (~seconds for warm routes).
#
# Safety properties:
#   - Never stacks a second server: it only starts `bun run dev` after
#     confirming nothing is listening on :3000 and killing stragglers.
#   - Distinguishes "connection refused" (server gone) from "timeout"
#     (server busy compiling — GET / blocks up to ~50s during compiles):
#     only two consecutive REFUSED checks trigger a recycle.
#   - Single instance: checks for an existing watchdog before looping.
#
# Run it:   nohup bash scripts/dev-watchdog.sh >/dev/null 2>&1 &
# Watch it: tail -f dev-watchdog.log

cd /home/z/my-project || exit 1

LOCK_FILE="/tmp/acp-ai-dev-watchdog.pid"

if [ -f "$LOCK_FILE" ] && kill -0 "$(cat "$LOCK_FILE")" 2>/dev/null; then
  echo "watchdog already running (pid $(cat "$LOCK_FILE"))" >&2
  exit 0
fi
echo $$ >"$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT INT TERM

refused=0

log() {
  echo "[watchdog $(date '+%F %T')] $*" >>/home/z/my-project/dev-watchdog.log
}

log "watchdog started (pid $$)"

while true; do
  sleep 10

  # A healthy server (even mid-compile: GET blocks, then answers) returns 0.
  # NOTE: capture curl's rc DIRECTLY — after `if curl …; then …; fi` with no
  # else branch, $? is the if-statement's exit status (0), never curl's.
  curl -s --max-time 8 -o /dev/null http://localhost:3000/ 2>/dev/null
  rc=$?

  # rc=7 → connection refused: the listener itself is gone (process died).
  # rc=28 → timeout: server alive but compiling; keep waiting.
  if [ "$rc" -eq 0 ]; then
    refused=0
    continue
  elif [ "$rc" -ne 7 ]; then
    refused=0
    continue
  fi

  refused=$((refused + 1))

  if [ "$refused" -lt 2 ]; then
    continue
  fi

  log "port 3000 refused x${refused} — recycling dev server"
  pkill -f "next dev" 2>/dev/null
  pkill -f "next-server" 2>/dev/null
  sleep 2
  # Belt and braces: never start on top of a live listener.
  if curl -s --max-time 3 -o /dev/null http://localhost:3000/ 2>/dev/null; then
    log "port came back before restart — skipping"
    refused=0
    continue
  fi
  (nohup bun run dev >>/home/z/my-project/dev.log 2>&1 &)
  log "restarted 'bun run dev'"
  refused=0
done
