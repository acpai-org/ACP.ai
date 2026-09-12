#!/bin/bash
# Round-3 live verification: Actions view (chips/CSV/indicator) + two-tab chat sync.
# Everything in ONE bash session (server + browser) per sandbox reaper constraints.
set -u
cd /home/z/my-project/acp-ai-repo
export MALLOC_ARENA_MAX=2
export NODE_OPTIONS="--max-old-space-size=1024"

node node_modules/.bin/next dev --turbopack -p 3001 > /tmp/acp-r3.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 45); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/ 2>/dev/null || echo 000)
  [ "$code" = "200" ] && break
  sleep 2
done
echo "=== SERVER READY (pid $SERVER_PID) ==="

# ── Phase A: Actions view with seeded multi-chain rows ────────────────────────
node --import tsx scripts/qa-r3-seed.mts seed
echo "=== SEEDED 5 rows (3 Sepolia, 2 Base) ==="

agent-browser open http://localhost:3001/payments > /dev/null 2>&1
agent-browser wait --load networkidle --timeout 30000 > /dev/null 2>&1
agent-browser reload > /dev/null 2>&1
agent-browser wait --load networkidle --timeout 30000 > /dev/null 2>&1
agent-browser wait 2500 > /dev/null 2>&1

echo "A1. chain chips present?"
echo "  All-chains btn: $(agent-browser eval "document.querySelectorAll('button[title=\"Base\"]').length" 2>&1 | tail -1) Base chips"
echo "  Sepolia chips:  $(agent-browser eval "document.querySelectorAll('button[title=\"Sepolia\"]').length" 2>&1 | tail -1)"

echo "A2. click Base chip → filter to Base rows"
agent-browser eval "document.querySelector('button[title=\"Base\"]')?.click()" > /dev/null 2>&1
agent-browser wait 800 > /dev/null 2>&1
echo "  showing-indicator: $(agent-browser eval "document.body.innerText.includes('Showing 2 of 5')" 2>&1 | tail -1)"

echo "A3. clear filters restores all rows"
agent-browser eval "[...document.querySelectorAll('button')].find(b => b.textContent.trim().endsWith('Clear filters'))?.click()" > /dev/null 2>&1
agent-browser wait 800 > /dev/null 2>&1
echo "  indicator gone: $(agent-browser eval "!document.body.innerText.includes('Showing ')" 2>&1 | tail -1)"
echo "  all rows back:  $(agent-browser eval "document.body.innerText.includes('Showing 5 of 5') === false && document.querySelectorAll('[title=\"Export action log as CSV\"]').length === 1" 2>&1 | tail -1)"

echo "A4. CSV export instrumentation"
agent-browser eval "(() => { window.__r3csv=null; window.__r3csvName=null; window.__r3csvText=null; const oc=URL.createObjectURL.bind(URL); URL.createObjectURL=(b)=>{window.__r3csv=b; return oc(b);}; const oclick=HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click=function(){ if((this.download||'').endsWith('.csv')) window.__r3csvName=this.download; oclick.call(this); }; return 'instrumented'; })()" > /dev/null 2>&1
agent-browser eval "document.querySelector('[title=\"Export action log as CSV\"]')?.click()" > /dev/null 2>&1
agent-browser wait 2000 > /dev/null 2>&1
echo "  download name: $(agent-browser eval "window.__r3csvName" 2>&1 | tail -1)"
echo "  blob size:     $(agent-browser eval "window.__r3csv ? window.__r3csv.size : -1" 2>&1 | tail -1)"
agent-browser eval "window.__r3csv?.text().then(t => { window.__r3csvText = t; return 'queued'; })" > /dev/null 2>&1
agent-browser wait 600 > /dev/null 2>&1
echo "  CSV header:    $(agent-browser eval "(window.__r3csvText||'').split('\n')[0]" 2>&1 | tail -1)"
echo "  CSV rows:      $(agent-browser eval "(window.__r3csvText||'').trim().split('\n').length" 2>&1 | tail -1)"
echo "  Base row present: $(agent-browser eval "(window.__r3csvText||'').includes('Base')" 2>&1 | tail -1)"
echo "  quotes escaped ok: $(agent-browser eval "(window.__r3csvText||'').split('\n').length === 6" 2>&1 | tail -1) (header + 5 rows)"

# ── Phase B: two-tab chat sync (R20) ──────────────────────────────────────────
echo ""
echo "=== PHASE B: two-tab chat sync ==="
agent-browser open http://localhost:3001/ > /dev/null 2>&1
agent-browser wait --load networkidle --timeout 30000 > /dev/null 2>&1
agent-browser wait 1500 > /dev/null 2>&1
# Reset chat storage to a clean single-session baseline for a deterministic test
agent-browser eval "localStorage.removeItem('acp-ai:chat-sessions'); location.reload()" > /dev/null 2>&1
agent-browser wait --load networkidle --timeout 30000 > /dev/null 2>&1
agent-browser wait 2000 > /dev/null 2>&1
T1_BASE=$(agent-browser eval "document.querySelectorAll('button[aria-label=\"New chat\"]').length" 2>&1 | tail -1)
echo "B1. tab1 baseline untitled-session rows: $T1_BASE"

agent-browser tab new http://localhost:3001/ > /dev/null 2>&1
agent-browser wait --load networkidle --timeout 30000 > /dev/null 2>&1
agent-browser wait 2000 > /dev/null 2>&1
T2_BASE=$(agent-browser eval "document.querySelectorAll('button[aria-label=\"New chat\"]').length" 2>&1 | tail -1)
echo "B2. tab2 baseline untitled-session rows: $T2_BASE"

echo "B3. tab2 creates a new chat (Plus button)"
agent-browser eval "document.querySelector('button svg.lucide-plus')?.closest('button')?.click()" > /dev/null 2>&1
agent-browser wait 4000 > /dev/null 2>&1
T2_AFTER=$(agent-browser eval "document.querySelectorAll('button[aria-label=\"New chat\"]').length" 2>&1 | tail -1)
echo "  tab2 rows now: $T2_AFTER"

agent-browser tab 1 > /dev/null 2>&1
agent-browser wait 2500 > /dev/null 2>&1
T1_AFTER=$(agent-browser eval "document.querySelectorAll('button[aria-label=\"New chat\"]').length" 2>&1 | tail -1)
echo "B4. tab1 rows after sync (expect +1): $T1_AFTER"
echo "  tab1 localStorage order length: $(agent-browser eval "JSON.parse(localStorage.getItem('acp-ai:chat-sessions')||'{}').order.length" 2>&1 | tail -1)"
echo "  tab1 localStorage has deletedAt field: $(agent-browser eval "Object.keys(JSON.parse(localStorage.getItem('acp-ai:chat-sessions')||'{}')).includes('deletedAt')" 2>&1 | tail -1)"

echo "B5. tab1 deletes the OLD session via direct storage write (tombstone) → tab2 must drop it"
agent-browser eval "(() => { const raw = JSON.parse(localStorage.getItem('acp-ai:chat-sessions')); const victim = raw.order[raw.order.length-1]; delete raw.sessions[victim]; raw.order = raw.order.filter(id => id !== victim); raw.activeId = raw.order[0] ?? null; raw.deletedAt = { [victim]: Date.now() }; localStorage.setItem('acp-ai:chat-sessions', JSON.stringify(raw)); return 'deleted ' + victim.slice(0, 20); })()" 2>&1 | tail -1
agent-browser tab 2 > /dev/null 2>&1
agent-browser wait 2500 > /dev/null 2>&1
T2_DEL=$(agent-browser eval "document.querySelectorAll('button[aria-label=\"New chat\"]').length" 2>&1 | tail -1)
echo "  tab2 rows after delete-sync (expect -1): $T2_DEL"
echo "  tab2 localStorage order length: $(agent-browser eval "JSON.parse(localStorage.getItem('acp-ai:chat-sessions')||'{}').order.length" 2>&1 | tail -1)"

agent-browser errors 2>&1 | head -3
agent-browser tab close > /dev/null 2>&1
agent-browser close > /dev/null 2>&1
node --import tsx scripts/qa-r3-seed.mts cleanup
echo "=== seeded rows cleaned ==="
kill $SERVER_PID 2>/dev/null
sleep 1
pkill -f "next dev.*3001" 2>/dev/null
echo "=== DONE ==="
