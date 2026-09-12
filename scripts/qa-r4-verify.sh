#!/bin/bash
# Round-4 live verification (STABLE): R23 range chips, R24 check-attestation,
# R25 styling, R26 BroadcastChannel cross-tab delivery.
# QA-tooling learnings baked in (see worklog round 4):
#  • `agent-browser close --all` — plain `close` sometimes leaves the eval
#    context pointing at a dead tab (empty DOM, 0 scripts — looks exactly
#    like an app bug but isn't);
#  • seed AFTER server readiness (startup DB contention);
#  • poll for hydration instead of fixed sleeps — in dev mode the /payments
#    page STREAMS: the shell + client JS land while turbopack is still
#    compiling API routes, so the actions query can respond seconds after
#    networkidle. Assertions must wait for rendered text, not the clock;
#  • the "Showing N of M" indicator intentionally hides when a filter shows
#    everything — only assert it while rows are actually filtered out.
set -u
cd /home/z/my-project/acp-ai-repo
export MALLOC_ARENA_MAX=2
export NODE_OPTIONS="--max-old-space-size=1024"

node node_modules/.bin/next dev --turbopack -p 3001 > /tmp/acp-r4q.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 45); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/ 2>/dev/null || echo 000)
  [ "$code" = "200" ] && break
  sleep 2
done
echo "=== SERVER READY ==="

node --import tsx scripts/qa-r4-seed.mts seed

agent-browser close --all > /dev/null 2>&1
agent-browser open http://localhost:3001/payments > /dev/null 2>&1

echo "--- poll for the actions view to fully hydrate (up to 60s):"
for i in $(seq 1 30); do
  R=$(agent-browser eval 'document.querySelectorAll(".relative.rounded-xl").length >= 4 ? "READY" : "no"' 2>/dev/null | tail -1)
  [ "$R" = "READY" ] && break
  sleep 2
done
echo "hydration: $R (after ~$((i*2))s)"

echo ""
echo "── R23: range chips ──"
TOTAL='(() => { const el=[...document.querySelectorAll("span")].find(s=>s.textContent.match(/Showing/)); return el?el.textContent:null })()'
CLICK_CHIP='(() => { const g=document.querySelector("[aria-label=\"Time range\"]"); if(!g) return "NO GROUP"; const c=[...g.querySelectorAll("button")].find(b=>b.textContent.includes(arguments[0])); if(!c) return "NO CHIP"; c.click(); return "ok"; })()'

agent-browser eval "(() => { const g=document.querySelector('[aria-label=\"Time range\"]'); const c=[...g.querySelectorAll('button')].find(b=>b.textContent.includes('24')); c.click(); return 'ok'; })()" > /dev/null 2>&1
agent-browser wait 800 > /dev/null 2>&1
echo "after 24h: $(agent-browser eval "$TOTAL" 2>&1 | tail -1)  <-- EXPECTED 'Showing 1 of 4'"

agent-browser eval "(() => { const g=document.querySelector('[aria-label=\"Time range\"]'); const c=[...g.querySelectorAll('button')].find(b=>b.textContent.includes('7')); c.click(); return 'ok'; })()" > /dev/null 2>&1
agent-browser wait 800 > /dev/null 2>&1
echo "after 7d:  $(agent-browser eval "$TOTAL" 2>&1 | tail -1)  <-- EXPECTED 'Showing 3 of 4'"

agent-browser eval "(() => { const g=document.querySelector('[aria-label=\"Time range\"]'); const c=[...g.querySelectorAll('button')].find(b=>b.textContent.includes('30')); c.click(); return 'ok'; })()" > /dev/null 2>&1
agent-browser wait 800 > /dev/null 2>&1
echo "after 30d: rows=$(agent-browser eval 'document.querySelectorAll(".relative.rounded-xl").length' 2>&1 | tail -1)  <-- EXPECTED 5 (indicator hidden when nothing is filtered — by design)"

echo ""
echo "── R24: check-attestation ──"
BTN='(() => [...document.querySelectorAll("button")].filter(b=>b.textContent.trim()==="Check attestation").length)()'
echo "check-attest buttons: $(agent-browser eval "$BTN" 2>&1 | tail -1)  <-- EXPECTED 3"
agent-browser eval '(() => { const rows=[...document.querySelectorAll(".relative.rounded-xl")]; const r=rows.find(x=>x.textContent.includes("0x1111aaab")); const btn=[...r.querySelectorAll("button")].find(b=>b.textContent.trim()==="Check attestation"); btn.click(); return "CLICKED"; })()' > /dev/null 2>&1
echo "--- waiting 25s (live attestcoin builder fetch)..."
agent-browser wait 25000 > /dev/null 2>&1
RESULT='(() => { const rows=[...document.querySelectorAll(".relative.rounded-xl")]; const r=rows.find(x=>x.textContent.includes("0x1111aaab")); return r ? r.textContent.replace(/\\s+/g," ").slice(-90) : "NO ROW"; })()'
echo "row tail: $(agent-browser eval "$RESULT" 2>&1 | tail -1)  <-- EXPECTED pill state + 'now' timestamp"
echo "proof API: $(rg 'attestcoin/proof' /tmp/acp-r4q.log | tail -1 | head -c 110)"

echo ""
echo "── R25: styling screenshot ──"
agent-browser screenshot /tmp/acp-qa-r4/payments-r4.png > /dev/null 2>&1
agent-browser open http://localhost:3001/wallet > /dev/null 2>&1
agent-browser wait 4000 > /dev/null 2>&1
agent-browser screenshot /tmp/acp-qa-r4/wallet-r4.png > /dev/null 2>&1
echo "shots: /tmp/acp-qa-r4/{payments-r4,wallet-r4}.png"

echo ""
echo "── R26: BroadcastChannel cross-tab ──"
agent-browser open http://localhost:3001/ > /dev/null 2>&1
agent-browser wait "#chat-sidebar-list" --timeout 45000 > /dev/null 2>&1
agent-browser wait 3000 > /dev/null 2>&1
ROWS='document.querySelectorAll("#chat-sidebar-list button[title=\"New chat\"]").length'
agent-browser eval "localStorage.removeItem('acp-ai:chat-sessions'); 'cleared'" > /dev/null 2>&1
agent-browser reload > /dev/null 2>&1
agent-browser wait "#chat-sidebar-list" --timeout 45000 > /dev/null 2>&1
agent-browser wait 3000 > /dev/null 2>&1
echo "A after clean: rows=$(agent-browser eval "$ROWS" 2>&1 | tail -1)  <-- EXPECTED 1"

agent-browser tab new http://localhost:3001/ > /dev/null 2>&1
agent-browser wait "#chat-sidebar-list" --timeout 30000 > /dev/null 2>&1
agent-browser wait 2500 > /dev/null 2>&1
echo "B baseline: rows=$(agent-browser eval "$ROWS" 2>&1 | tail -1)  <-- EXPECTED 1"

agent-browser eval "document.querySelector('button svg.lucide-plus')?.closest('button')?.click(); 'ok'" > /dev/null 2>&1
agent-browser wait 4000 > /dev/null 2>&1
echo "B after create: rows=$(agent-browser eval "$ROWS" 2>&1 | tail -1)  <-- EXPECTED 2"

# A stays UNFOCUSED (tab 2 remains active) — the sync channel must deliver
agent-browser wait 3500 > /dev/null 2>&1
A_ROWS=$(agent-browser tab 1 > /dev/null 2>&1; agent-browser eval "$ROWS" 2>&1 | tail -1)
echo "A (background) after sync: rows=$A_ROWS  <-- EXPECTED 2 (cross-tab delivery PROOF)"

echo "page errors: $(agent-browser errors 2>&1 | head -1)"
agent-browser tab close > /dev/null 2>&1
agent-browser close --all > /dev/null 2>&1

node --import tsx scripts/qa-r4-seed.mts cleanup
kill $SERVER_PID 2>/dev/null; sleep 1; pkill -f "next dev.*3001" 2>/dev/null
echo "=== DONE ==="
