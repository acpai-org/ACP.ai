#!/bin/bash
# Round-5 QA: boots ACP.ai on :3001, verifies R27/R28/R29/S10 live via agent-browser, tears down.
# Everything in ONE bash session so the sandbox process reaper can't kill the server mid-sweep.
# NOTE: cold turbopack compile of /payments can take 90s+ — every wait below POLLS for rendered
# content (never fixed sleeps), with generous budgets.
set -u
cd /home/z/my-project/acp-ai-repo

export MALLOC_ARENA_MAX=2
export NODE_OPTIONS="--max-old-space-size=1024"
node node_modules/.bin/next dev --turbopack -p 3001 > /tmp/acp-r5-dev.log 2>&1 &
SERVER_PID=$!

READY=0
for i in $(seq 1 45); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/ 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then READY=1; break; fi
  sleep 2
done
if [ "$READY" != "1" ]; then
  echo "BOOT FAILED"; tail -20 /tmp/acp-r5-dev.log; kill $SERVER_PID 2>/dev/null; exit 1
fi
echo "=== SERVER READY (pid $SERVER_PID) ==="

agent-browser close --all > /dev/null 2>&1
PASS=0; FAIL=0
check() { # name, expected, actual
  if [ "$2" = "$3" ]; then echo "PASS: $1"; PASS=$((PASS+1)); else echo "FAIL: $1 (expected [$2] got [$3])"; FAIL=$((FAIL+1)); fi
}

# ── R29: payments date-range presets ─────────────────────────────────────────
agent-browser open "http://localhost:3001/payments" > /dev/null 2>&1
# Dev-mode streaming: poll for the seeded payment rows to render (up to 150s cold).
ROWS=""
for i in $(seq 1 75); do
  ROWS=$(agent-browser eval "document.querySelectorAll('[data-payment-row]').length" 2>/dev/null | rg -o '[0-9]+' | head -1)
  [ "$ROWS" = "4" ] && break
  sleep 2
done
check "R29 seeded payments render (4 rows)" "4" "$ROWS"

# Range chips visible (payments list spans >24h) — scoped to the payments group
# (the Actions view renders its own R23 chips with a different aria-label).
CHIPS=$(agent-browser eval "document.querySelectorAll('[role=group][aria-label=\"Payments time range\"] button').length" 2>/dev/null | rg -o '[0-9]+' | head -1)
check "R29 payments range chips render (4)" "4" "$CHIPS"

click_chip() { # chip text
  agent-browser eval "(() => { const g = document.querySelector('[role=group][aria-label=\"Payments time range\"]'); if (!g) return 'missing-group'; const b = [...g.querySelectorAll('button')].find(x => x.textContent.trim() === '$1'); if (b) { b.click(); return 'clicked'; } return 'missing'; })()" 2>/dev/null | rg -o 'clicked|missing.*' | head -1
}
count_rows() {
  agent-browser eval "document.querySelectorAll('[data-payment-row]').length" 2>/dev/null | rg -o '[0-9]+' | head -1
}

click_chip "24h" > /dev/null; sleep 1.5
check "R29 24h window narrows to 1 row" "1" "$(count_rows)"
click_chip "7d" > /dev/null; sleep 1.5
check "R29 7d window shows 3 rows" "3" "$(count_rows)"
click_chip "30d" > /dev/null; sleep 1.5
check "R29 30d window shows 4 rows" "4" "$(count_rows)"
click_chip "All time" > /dev/null; sleep 1.5
check "R29 All time restores 4 rows" "4" "$(count_rows)"

# ── R27: attest-root copy on the actions log (rendered on /payments) ────────
# The seeded action row carries attest_root 0x5678… → its ⬡ chip renders with
# a CopyRef button inside the title-carrying span.
ROOTBTN=$(agent-browser eval "(() => { const chip = [...document.querySelectorAll('span[title]')].find(s => s.title.startsWith('0x5678')); return chip ? String(!!chip.querySelector('button')) : 'nochip'; })()" 2>/dev/null | rg -o 'true|false|nochip' | head -1)
check "R27 attest-root chip renders with copy button" "true" "$ROOTBTN"

# Instrument clipboard, click it, verify the full 66-char root lands.
agent-browser eval "navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); }; 'armed'" > /dev/null 2>&1
agent-browser eval "(() => { const chip = [...document.querySelectorAll('span[title]')].find(s => s.title.startsWith('0x5678')); chip.querySelector('button').click(); return 'ok'; })()" > /dev/null 2>&1
sleep 0.6
COPIED=$(agent-browser eval "window.__copied ?? 'none'" 2>/dev/null | rg -o '0x5678[0-9a-f]+' | head -1)
check "R27 copy puts full merkle root on clipboard" "0x5678abcd5678abcd5678abcd5678abcd5678abcd5678abcd5678abcd5678abcd" "$COPIED"

# ── R28: keyboard roving through the status filter chips ────────────────────
agent-browser eval "(() => { const g = document.querySelector('[role=group][aria-label=\"Filter by status\"]'); if (!g) return 'nogroup'; const b = g.querySelectorAll('button'); b[0].focus(); return document.activeElement.textContent.trim(); })()" > /tmp/r5-f1.txt 2>/dev/null
F1=$(cat /tmp/r5-f1.txt | tr -d '"' | sed 's/|.*//' | head -1)
agent-browser press ArrowRight > /dev/null 2>&1; sleep 0.4
F2=$(agent-browser eval "document.activeElement.textContent.trim()" 2>/dev/null | tr -d '"' | head -1)
agent-browser press ArrowRight > /dev/null 2>&1; sleep 0.4
F3=$(agent-browser eval "document.activeElement.textContent.trim()" 2>/dev/null | tr -d '"' | head -1)
agent-browser press End > /dev/null 2>&1; sleep 0.4
F4=$(agent-browser eval "document.activeElement.textContent.trim()" 2>/dev/null | tr -d '"' | head -1)
agent-browser press Home > /dev/null 2>&1; sleep 0.4
F5=$(agent-browser eval "document.activeElement.textContent.trim()" 2>/dev/null | tr -d '"' | head -1)
if [ -n "$F2" ] && [ "$F2" != "$F1" ] && [ "$F3" != "$F2" ] && [ "$F4" != "$F3" ] && [ "$F5" = "$F1" ]; then
  echo "PASS: R28 arrows/End/Home move focus through chips ($F1 → $F2 → $F3 → $F4 → Home:$F5)"; PASS=$((PASS+1))
else
  echo "FAIL: R28 focus movement (f1=[$F1] f2=[$F2] f3=[$F3] f4=[$F4] f5=[$F5])"; FAIL=$((FAIL+1))
fi

ERRS=$(agent-browser errors 2>&1)
if [ -n "$ERRS" ] && [ "$ERRS" != "No page errors" ]; then echo "PAGE-ERRORS(/payments): $ERRS"; FAIL=$((FAIL+1)); else echo "PASS: /payments no page errors"; PASS=$((PASS+1)); fi
agent-browser screenshot /tmp/acp-qa/r5-payments.png > /dev/null 2>&1

# ── S10-a: chat composer affordance (home) ───────────────────────────────────
agent-browser open "http://localhost:3001/" > /dev/null 2>&1
COMPOSER=""
for i in $(seq 1 45); do
  COMPOSER=$(agent-browser eval "(() => { const el = document.querySelector('[data-chat-composer]')?.closest('div.glass-tight'); if (!el) return 'missing'; const cs = getComputedStyle(el); return cs.boxShadow !== 'none' && cs.boxShadow !== '' ? 'shadow' : 'noshadow'; })()" 2>/dev/null | rg -o 'shadow|missing' | head -1)
  [ "$COMPOSER" = "shadow" ] && break
  sleep 2
done
check "S10-a composer resting shadow renders" "shadow" "$COMPOSER"

# ── S10-b: header wallet button reads primary-tinted ─────────────────────────
WALLET_COLOR=""
for i in $(seq 1 30); do
  WALLET_COLOR=$(agent-browser eval "(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('Connect Wallet')); if (!b) return 'missing'; const c = getComputedStyle(b).color; const m = c.match(/[0-9]+/g)?.map(Number) ?? [0,0,0]; return (m[1] > m[0] + 40 && m[2] > m[0] + 40) ? 'primary' : 'gray'; })()" 2>/dev/null | rg -o 'primary|gray|missing' | head -1)
  [ "$WALLET_COLOR" = "primary" ] && break
  sleep 2
done
check "S10-b header wallet button is primary-tinted" "primary" "$WALLET_COLOR"

ERRS2=$(agent-browser errors 2>&1)
if [ -n "$ERRS2" ] && [ "$ERRS2" != "No page errors" ]; then echo "PAGE-ERRORS(/): $ERRS2"; FAIL=$((FAIL+1)); else echo "PASS: / no page errors"; PASS=$((PASS+1)); fi
agent-browser screenshot /tmp/acp-qa/r5-home.png > /dev/null 2>&1

# ── S10-d: contacts zero-state hides search/favorites card ──────────────────
agent-browser open "http://localhost:3001/contacts" > /dev/null 2>&1
CONTACT_EMPTY=""
for i in $(seq 1 45); do
  CONTACT_EMPTY=$(agent-browser eval "(() => { const t = document.body.textContent; return t.includes('No contacts') || t.includes('no contacts') ? 'empty' : 'notyet'; })()" 2>/dev/null | rg -o 'empty|notyet' | head -1)
  [ "$CONTACT_EMPTY" = "empty" ] && break
  sleep 2
done
check "S10-d contacts empty state renders" "empty" "$CONTACT_EMPTY"
NOSEARCH=$(agent-browser eval "(() => { const inputs = [...document.querySelectorAll('input')]; return inputs.length === 0 ? 'nosearch' : 'has'; })()" 2>/dev/null | rg -o 'nosearch|has' | head -1)
check "S10-d zero contacts: no search/favorites card" "nosearch" "$NOSEARCH"
agent-browser screenshot /tmp/acp-qa/r5-contacts.png > /dev/null 2>&1

echo ""
echo "=== RESULT: $PASS pass / $FAIL fail ==="
agent-browser close --all > /dev/null 2>&1
kill $SERVER_PID 2>/dev/null
sleep 2
pkill -f "next dev.*3001" 2>/dev/null
echo "=== tail of server log ==="
tail -5 /tmp/acp-r5-dev.log
