#!/bin/bash
# Round-3 QA sweep: boots ACP.ai on :3001, sweeps all pages via agent-browser, tears down.
# Everything in ONE bash session so the sandbox process reaper can't kill the server mid-sweep.
set -u
cd /home/z/my-project/acp-ai-repo

export MALLOC_ARENA_MAX=2
export NODE_OPTIONS="--max-old-space-size=1024"
node node_modules/.bin/next dev --turbopack -p 3001 > /tmp/acp-qa-dev.log 2>&1 &
SERVER_PID=$!

# Wait for readiness (max 90s)
READY=0
for i in $(seq 1 45); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/ 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then READY=1; break; fi
  sleep 2
done
if [ "$READY" != "1" ]; then
  echo "BOOT FAILED — server never answered 200"; tail -20 /tmp/acp-qa-dev.log; kill $SERVER_PID 2>/dev/null; exit 1
fi
echo "=== SERVER READY (pid $SERVER_PID) ==="
free -m | head -2

PAGES=("/" "/payments" "/recurring" "/contacts" "/wallet" "/settings" "/notifications" "/security")
mkdir -p /tmp/acp-qa

for p in "${PAGES[@]}"; do
  slug=$(echo "$p" | tr '/' '_' | sed 's/^_$//' | sed 's/_$//'); [ -z "$slug" ] && slug="home"
  echo ""
  echo "=== PAGE $p ==="
  agent-browser open "http://localhost:3001$p" > /dev/null 2>&1
  agent-browser wait --load networkidle --timeout 20000 > /dev/null 2>&1
  sleep 1
  echo "TITLE: $(agent-browser get title 2>&1)"
  ERRS=$(agent-browser errors 2>&1)
  if [ -n "$ERRS" ] && [ "$ERRS" != "No page errors" ]; then echo "PAGE-ERRORS: $ERRS"; else echo "PAGE-ERRORS: none"; fi
  CONSOLE=$(agent-browser console 2>&1 | rg -i "error|unhandled" | head -5)
  if [ -n "$CONSOLE" ]; then echo "CONSOLE-ISSUES:"; echo "$CONSOLE"; else echo "CONSOLE: clean"; fi
  agent-browser screenshot "/tmp/acp-qa/${slug}.png" > /dev/null 2>&1
  echo "SHOT: /tmp/acp-qa/${slug}.png"
  free -m | awk 'NR==2{print "MEM-AVAIL: "$7" MB"}'
done

echo ""
echo "=== SWEEP DONE — killing server ==="
kill $SERVER_PID 2>/dev/null
sleep 2
pkill -f "next dev.*3001" 2>/dev/null
echo "=== tail of server log ==="
tail -10 /tmp/acp-qa-dev.log
