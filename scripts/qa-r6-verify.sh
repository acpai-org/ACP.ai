#!/bin/bash
# Round-6 QA: boots ACP.ai on :3001, verifies R30/R31/R32 + S11 live via agent-browser, tears down.
# Everything in ONE bash session; every wait POLLS for rendered content (no fixed sleeps).
set -u
cd /home/z/my-project/acp-ai-repo

export MALLOC_ARENA_MAX=2
export NODE_OPTIONS="--max-old-space-size=1024"
node node_modules/.bin/next dev --turbopack -p 3001 > /tmp/acp-r6-dev.log 2>&1 &
SERVER_PID=$!

READY=0
for i in $(seq 1 45); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/ 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then READY=1; break; fi
  sleep 2
done
if [ "$READY" != "1" ]; then
  echo "BOOT FAILED"; tail -20 /tmp/acp-r6-dev.log; kill $SERVER_PID 2>/dev/null; exit 1
fi
echo "=== SERVER READY (pid $SERVER_PID) ==="

agent-browser close --all > /dev/null 2>&1
PASS=0; FAIL=0
check() {
  if [ "$2" = "$3" ]; then echo "PASS: $1"; PASS=$((PASS+1)); else echo "FAIL: $1 (expected [$2] got [$3])"; FAIL=$((FAIL+1)); fi
}

# ── /payments: rows render (seeded), then R30/R31/R32 ───────────────────────
agent-browser open "http://localhost:3001/payments" > /dev/null 2>&1
ROWS=""
for i in $(seq 1 75); do
  ROWS=$(agent-browser eval "document.querySelectorAll('[data-payment-row]').length" 2>/dev/null | rg -o '[0-9]+' | head -1)
  [ "$ROWS" = "4" ] && break
  sleep 2
done
check "seeded payments render (4 rows)" "4" "$ROWS"

# R32: CSV export — instrument URL.createObjectURL, click, verify content.
CSVBTN=$(agent-browser eval "(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Export CSV'); return b ? 'found' : 'missing'; })()" 2>/dev/null | rg -o 'found|missing' | head -1)
check "R32 Export CSV button renders" "found" "$CSVBTN"
agent-browser eval "window.__blobs = []; window.__bomOk = null; const oc = URL.createObjectURL.bind(URL); URL.createObjectURL = (b) => { if (b && b.text) { b.text().then(t => window.__blobs.push(t)); if (b.arrayBuffer) b.arrayBuffer().then(buf => { const u = new Uint8Array(buf); window.__bomOk = u[0] === 0xEF && u[1] === 0xBB && u[2] === 0xBF; }); } return oc(b); }; 'armed'" > /dev/null 2>&1
agent-browser eval "(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Export CSV'); b.click(); return 'ok'; })()" > /dev/null 2>&1
CSV=""
for i in $(seq 1 10); do
  CSV=$(agent-browser eval "window.__blobs[0] ?? ''" 2>/dev/null | head -8)
  [ -n "$CSV" ] && break
  sleep 1
done
# NOTE: eval JSON-encodes string returns (quotes wrap, BOM/newlines mangled) —
# so byte/text checks are computed INSIDE the browser and returned as
# booleans/numbers. The BOM check reads raw BYTES via arrayBuffer(): blob.text()
# spec-strips a leading BOM during UTF-8 decoding, but the FILE on disk keeps it
# (that's what Excel needs) — arrayBuffer is the honest lens.
CSVBOM=$(agent-browser eval "String(window.__bomOk)" 2>/dev/null | rg -o 'true|false' | head -1)
check "R32 CSV starts with UTF-8 BOM" "true" "$CSVBOM"
CSVHDR=$(agent-browser eval "String((window.__blobs[0] ?? '').includes('time_iso,id,status,recipient,recipient_address,token,amount,chain,chain_id,memo,tx_hash,settled_at,attested_at,attest_root,onchain_verified_at,cc3_tx_hash'))" 2>/dev/null | rg -o 'true|false' | head -1)
check "R32 CSV header has expected columns" "true" "$CSVHDR"
CSVROWS=$(agent-browser eval "String((window.__blobs[0] ?? '').split('\n').filter(l => l.includes('r5qa-pay-')).length)" 2>/dev/null | rg -o '[0-9]+' | head -1)
check "R32 CSV carries all 4 seeded rows" "4" "$CSVROWS"

# R31: filter to Pending (1 row) → showing indicator + Clear filters appear.
agent-browser eval "(() => { const g = document.querySelector('[role=group][aria-label=\"Filter payment status\"]'); const b = [...g.querySelectorAll('button')].find(x => x.textContent.includes('Pending')); b.click(); return 'ok'; })()" > /dev/null 2>&1
sleep 1.5
SHOWING=$(agent-browser eval "document.body.textContent.includes('Showing 1 of 4') ? 'yes' : 'no'" 2>/dev/null | rg -o 'yes|no' | head -1)
check "R31 'Showing 1 of 4' indicator renders" "yes" "$SHOWING"
PROWS=$(agent-browser eval "document.querySelectorAll('[data-payment-row]').length" 2>/dev/null | rg -o '[0-9]+' | head -1)
check "R31 Pending lens narrows to 1 row" "1" "$PROWS"
agent-browser eval "(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Clear filters'); if (b) { b.click(); return 'clicked'; } return 'missing'; })()" > /dev/null 2>&1
sleep 1.5
RROWS=$(agent-browser eval "document.querySelectorAll('[data-payment-row]').length" 2>/dev/null | rg -o '[0-9]+' | head -1)
check "R31 Clear filters restores 4 rows" "4" "$RROWS"

# R31 + R29 combined: 24h + failed → showing indicator → clear restores.
agent-browser eval "(() => { const g = document.querySelector('[role=group][aria-label=\"Payments time range\"]'); const b = [...g.querySelectorAll('button')].find(x => x.textContent.trim() === '24h'); b.click(); return 'ok'; })()" > /dev/null 2>&1
sleep 1.5
agent-browser eval "(() => { const g = document.querySelector('[role=group][aria-label=\"Filter payment status\"]'); const b = [...g.querySelectorAll('button')].find(x => x.textContent.includes('Failed')); b.click(); return 'ok'; })()" > /dev/null 2>&1
sleep 1.5
CROWS=$(agent-browser eval "document.querySelectorAll('[data-payment-row]').length" 2>/dev/null | rg -o '[0-9]+' | head -1)
check "R31 combined lenses narrow to 0 rows" "0" "$CROWS"
agent-browser eval "(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Clear filters'); b.click(); return 'ok'; })()" > /dev/null 2>&1
sleep 1.5
ARROWS=$(agent-browser eval "document.querySelectorAll('[data-payment-row]').length" 2>/dev/null | rg -o '[0-9]+' | head -1)
check "R31 clear resets BOTH lenses (4 rows)" "4" "$ARROWS"

# R30: keyboard roving through the payments status chips.
agent-browser eval "(() => { const g = document.querySelector('[role=group][aria-label=\"Filter payment status\"]'); if (!g) return 'nogroup'; g.querySelectorAll('button')[0].focus(); return document.activeElement.textContent.trim(); })()" > /tmp/r6-f1.txt 2>/dev/null
F1=$(cat /tmp/r6-f1.txt | tr -d '"' | head -1)
agent-browser press ArrowRight > /dev/null 2>&1; sleep 0.4
F2=$(agent-browser eval "document.activeElement.textContent.trim()" 2>/dev/null | tr -d '"' | head -1)
agent-browser press End > /dev/null 2>&1; sleep 0.4
F3=$(agent-browser eval "document.activeElement.textContent.trim()" 2>/dev/null | tr -d '"' | head -1)
agent-browser press Home > /dev/null 2>&1; sleep 0.4
F4=$(agent-browser eval "document.activeElement.textContent.trim()" 2>/dev/null | tr -d '"' | head -1)
if [ -n "$F2" ] && [ "$F2" != "$F1" ] && [ "$F3" != "$F2" ] && [ "$F4" = "$F1" ]; then
  echo "PASS: R30 arrows/End/Home move focus through payments chips ($F1 → $F2 → $F3 → Home:$F4)"; PASS=$((PASS+1))
else
  echo "FAIL: R30 focus movement (f1=[$F1] f2=[$F2] f3=[$F3] f4=[$F4])"; FAIL=$((FAIL+1))
fi

# R28 regression: actions status chips still rove (shared module refactor).
agent-browser eval "(() => { const g = document.querySelector('[role=group][aria-label=\"Filter by status\"]'); if (!g) return 'nogroup'; g.querySelectorAll('button')[0].focus(); return document.activeElement.textContent.trim(); })()" > /tmp/r6-af1.txt 2>/dev/null
AF1=$(cat /tmp/r6-af1.txt | tr -d '"' | head -1)
agent-browser press ArrowRight > /dev/null 2>&1; sleep 0.4
AF2=$(agent-browser eval "document.activeElement.textContent.trim()" 2>/dev/null | tr -d '"' | head -1)
if [ -n "$AF2" ] && [ "$AF2" != "$AF1" ]; then
  echo "PASS: R28 regression — actions chips still rove ($AF1 → $AF2)"; PASS=$((PASS+1))
else
  echo "FAIL: R28 regression (af1=[$AF1] af2=[$AF2])"; FAIL=$((FAIL+1))
fi

ERRS=$(agent-browser errors 2>&1)
if [ -n "$ERRS" ] && [ "$ERRS" != "No page errors" ]; then echo "PAGE-ERRORS(/payments): $ERRS"; FAIL=$((FAIL+1)); else echo "PASS: /payments no page errors"; PASS=$((PASS+1)); fi
agent-browser screenshot /tmp/acp-qa/r6-payments.png > /dev/null 2>&1

# ── S11-a: security toggle off-track visible ────────────────────────────────
agent-browser open "http://localhost:3001/security" > /dev/null 2>&1
TOGGLE=""
for i in $(seq 1 45); do
  TOGGLE=$(agent-browser eval "(() => { const t = document.querySelector('[role=switch]'); if (!t) return 'missing'; const cs = getComputedStyle(t); const hasTrack = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent'; const hasRing = cs.boxShadow !== 'none'; return hasTrack && hasRing ? 'visible' : 'invisible'; })()" 2>/dev/null | rg -o 'visible|invisible|missing' | head -1)
  [ "$TOGGLE" = "visible" ] && break
  sleep 2
done
check "S11-a toggle off-track + ring visible" "visible" "$TOGGLE"
ERRS=$(agent-browser errors 2>&1)
if [ -n "$ERRS" ] && [ "$ERRS" != "No page errors" ]; then echo "PAGE-ERRORS(/security): $ERRS"; FAIL=$((FAIL+1)); else echo "PASS: /security no page errors"; PASS=$((PASS+1)); fi
agent-browser screenshot /tmp/acp-qa/r6-security.png > /dev/null 2>&1

# ── S11-b: settings font selector segmented track visible ───────────────────
agent-browser open "http://localhost:3001/settings" > /dev/null 2>&1
FONTSEL=""
for i in $(seq 1 45); do
  FONTSEL=$(agent-browser eval "(() => { const g = [...document.querySelectorAll('[role=radiogroup]')].find(r => r.getAttribute('aria-label') && r.textContent.includes('M')); if (!g) return 'missing'; const cs = getComputedStyle(g); const hasBorder = cs.borderColor !== 'rgba(0, 0, 0, 0)' && cs.borderColor !== 'transparent'; return hasBorder ? 'visible' : 'invisible'; })()" 2>/dev/null | rg -o 'visible|invisible|missing' | head -1)
  [ "$FONTSEL" = "visible" ] && break
  sleep 2
done
check "S11-b font segmented control track visible" "visible" "$FONTSEL"

# ── S11-c: notifications stat cards all carry icons ─────────────────────────
agent-browser open "http://localhost:3001/notifications" > /dev/null 2>&1
STATS=""
for i in $(seq 1 45); do
  STATS=$(agent-browser eval "(() => { const cards = [...document.querySelectorAll('.glass-item')].filter(el => el.querySelector('p.text-2xl')); return String(cards.filter(c => c.querySelector('svg')).length + '/' + cards.length); })()" 2>/dev/null | rg -o '[0-9]+/[0-9]+' | head -1)
  [ "$STATS" = "3/3" ] && break
  sleep 2
done
check "S11-c all 3 notification stat cards have icons" "3/3" "$STATS"
agent-browser screenshot /tmp/acp-qa/r6-notifications.png > /dev/null 2>&1

# ── S11-d: zero-contact empty chip reads primary (on /recurring — its empty
# state renders deterministically with 0 schedules + 0 contacts; the payments
# empty state only appears with 0 payments, which conflicts with the seed) ────
agent-browser open "http://localhost:3001/recurring" > /dev/null 2>&1
CHIP=""
for i in $(seq 1 45); do
  CHIP=$(agent-browser eval "(() => { const a = [...document.querySelectorAll('a')].find(x => x.getAttribute('href') === '/contacts' && x.textContent.includes('contact')); if (!a) return 'missing'; const c = getComputedStyle(a).color; const m = c.match(/[0-9]+/g)?.map(Number) ?? [0,0,0]; return (m[1] > m[0] + 40 && m[2] > m[0] + 40) ? 'primary' : 'gray'; })()" 2>/dev/null | rg -o 'primary|gray|missing' | head -1)
  [ "$CHIP" = "primary" ] && break
  sleep 2
done
check "S11-d zero-contact chip is primary-tinted" "primary" "$CHIP"

echo ""
echo "=== RESULT: $PASS pass / $FAIL fail ==="
agent-browser close --all > /dev/null 2>&1
kill $SERVER_PID 2>/dev/null
sleep 2
pkill -f "next dev.*3001" 2>/dev/null
echo "=== tail of server log ==="
tail -5 /tmp/acp-r6-dev.log
