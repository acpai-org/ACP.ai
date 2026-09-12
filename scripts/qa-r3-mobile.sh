#!/bin/bash
# Round-3 mobile responsive check: seeded multi-chain Actions view at 390x844.
set -u
cd /home/z/my-project/acp-ai-repo
export MALLOC_ARENA_MAX=2
export NODE_OPTIONS="--max-old-space-size=1024"

node node_modules/.bin/next dev --turbopack -p 3001 > /tmp/acp-r3m.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 45); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/ 2>/dev/null || echo 000)
  [ "$code" = "200" ] && break
  sleep 2
done
echo "=== SERVER READY ==="
node --import tsx scripts/qa-r3-seed.mts seed

agent-browser set viewport 390 844 > /dev/null 2>&1
agent-browser open http://localhost:3001/payments > /dev/null 2>&1
agent-browser wait --load networkidle --timeout 30000 > /dev/null 2>&1
agent-browser reload > /dev/null 2>&1
agent-browser wait --load networkidle --timeout 30000 > /dev/null 2>&1
agent-browser wait 2500 > /dev/null 2>&1

echo "mobile: Base chip visible: $(agent-browser eval "!!document.querySelector('button[title=\"Base\"]') && document.querySelector('button[title=\"Base\"]').getBoundingClientRect().width" 2>&1 | tail -1)"
echo "mobile: Sepolia chip visible: $(agent-browser eval "document.querySelector('button[title*=\"Sepolia\"]')?.getBoundingClientRect().width ?? 'not-found'" 2>&1 | tail -1)"
echo "mobile: no horizontal overflow: $(agent-browser eval "document.documentElement.scrollWidth <= 390" 2>&1 | tail -1)"
echo "mobile: export group present: $(agent-browser eval "document.querySelectorAll('[aria-label=\"Export action log as CSV\"]').length" 2>&1 | tail -1)"
agent-browser screenshot /tmp/acp-qa/mobile-payments.png > /dev/null 2>&1
echo "shot saved"

# Tap the Base chip on touch viewport and verify filter narrows
agent-browser eval "document.querySelector('button[title=\"Base\"]')?.click(); 'ok'" > /dev/null 2>&1
agent-browser wait 800 > /dev/null 2>&1
echo "mobile: filter narrows (Showing 2 of 5): $(agent-browser eval "document.body.innerText.includes('Showing 2 of 5')" 2>&1 | tail -1)"
agent-browser screenshot /tmp/acp-qa/mobile-payments-filtered.png > /dev/null 2>&1

agent-browser errors 2>&1 | head -3
agent-browser close > /dev/null 2>&1
node --import tsx scripts/qa-r3-seed.mts cleanup
kill $SERVER_PID 2>/dev/null; sleep 1; pkill -f "next dev.*3001" 2>/dev/null
echo "=== DONE ==="
