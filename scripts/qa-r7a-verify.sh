#!/bin/bash
# Round-7 QA part A: S12-a/f (settings), S12-b/c/h + R34 (payments).
# Follows the qa-r6-verify.sh proven patterns. Computed-value checks are
# format-tolerant (Tailwind 4 emits oklab color-mix; Lightning CSS minifies
# rgba to 8-digit hex → 0.043/0.0902 alpha strings).
set -u
cd /home/z/my-project/acp-ai-repo

export MALLOC_ARENA_MAX=2
export NODE_OPTIONS="--max-old-space-size=1024"
node node_modules/.bin/next dev --turbopack -p 3001 > /tmp/acp-qa-dev.log 2>&1 &
SERVER_PID=$!

READY=0
for i in $(seq 1 45); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/ 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then READY=1; break; fi
  sleep 2
done
if [ "$READY" != "1" ]; then
  echo "BOOT FAILED"; tail -20 /tmp/acp-qa-dev.log; kill $SERVER_PID 2>/dev/null; exit 1
fi
echo "=== SERVER READY (pid $SERVER_PID) ==="

PASS=0; FAIL=0
check() {
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS: $1"; else FAIL=$((FAIL+1)); echo "FAIL: $1 (expected [$2] got [$3])"; fi
}
checktrue() {
  if [ "$2" = "true" ]; then PASS=$((PASS+1)); echo "PASS: $1"; else FAIL=$((FAIL+1)); echo "FAIL: $1 (got [$2])"; fi
}

agent-browser close --all > /dev/null 2>&1
agent-browser set media dark

# ── 1. /settings — S12-a theme selector + S12-f description contrast ──
agent-browser open "http://localhost:3001/settings" > /dev/null 2>&1
agent-browser wait --load networkidle --timeout 20000 > /dev/null 2>&1
for i in $(seq 1 30); do
  n=$(agent-browser eval "document.querySelectorAll('[role=radiogroup]').length" 2>/dev/null | tr -dc '0-9')
  [ "${n:-0}" -ge 3 ] && break
  sleep 5
done

# S12-a: the theme radiogroup container uses bg-foreground/10 (oklab white @ 0.1)
V=$(agent-browser eval "(() => { const g = [...document.querySelectorAll('[role=radiogroup]')].find(g => /System|システム/.test(g.textContent)); return g ? getComputedStyle(g).backgroundColor : 'none'; })()" 2>/dev/null)
echo "S12-a theme container bg: $V"
checktrue "S12-a theme-selector bg = foreground@0.1 alpha" "$(agent-browser eval "(() => { const g = [...document.querySelectorAll('[role=radiogroup]')].find(g => /System|システム/.test(g.textContent)); if (!g) return 'none'; const bg = getComputedStyle(g).backgroundColor; return String(bg.includes('/ 0.1)') || bg === 'rgba(255, 255, 255, 0.1)'); })()" 2>/dev/null | rg -o 'true|false|none' | head -1)"
checktrue "S12-a theme-selector inset ring present" "$(agent-browser eval "(() => { const g = [...document.querySelectorAll('[role=radiogroup]')].find(g => /System|システム/.test(g.textContent)); return g ? String(getComputedStyle(g).boxShadow.includes('inset')) : 'none'; })()" 2>/dev/null | rg -o 'true|false|none' | head -1)"

# S12-f: settings description color = muted rgb(154,154,154)
checktrue "S12-f settings description = muted (AA)" "$(agent-browser eval "(() => { const ps = [...document.querySelectorAll('p')]; const d = ps.find(p => getComputedStyle(p).fontSize === '12px' && p.textContent.trim().length > 12 && /theme|Theme|font|appearance|provider|プロバイダ|テーマ|글꼴/i.test(p.textContent)); return d ? String(getComputedStyle(d).color === 'rgb(154, 154, 154)') : 'none'; })()" 2>/dev/null | rg -o 'true|false|none' | head -1)"

# S12-h (root-cause): the finder input's border (border color utilities now win).
# The finder form uses ring, but the S12-h check is on /payments below.
E=$(agent-browser errors 2>&1)
{ [ -z "$E" ] || [ "$E" = "No page errors" ]; } && { PASS=$((PASS+1)); echo "PASS: 0 page errors on /settings"; } || { FAIL=$((FAIL+1)); echo "FAIL: page errors on /settings: $E"; }

# ── 2. /payments — S12-b/h chips, S12-c finder ring, R34 roving ──
node --import tsx scripts/qa-r5-seed.mts seed
agent-browser open "http://localhost:3001/payments" > /dev/null 2>&1
agent-browser wait --load networkidle --timeout 20000 > /dev/null 2>&1
for i in $(seq 1 30); do
  n=$(agent-browser eval "document.querySelectorAll('[data-payment-row]').length" 2>/dev/null | tr -dc '0-9')
  [ "${n:-0}" = "4" ] && break
  sleep 5
done
ROWS=$(agent-browser eval "document.querySelectorAll('[data-payment-row]').length" 2>/dev/null | tr -dc '0-9')
check "seeded payments render (4 rows)" "4" "$ROWS"

# S12-h THE root-cause check: secondary Button (glass-tight) now renders its
# DESIGNED border (var(--glass-border) = white@0.06) — before the fix every
# layered border lost to the unlayered reset (#1c1c1c).
V=$(agent-browser eval "(() => { const b = [...document.querySelectorAll('button')].find(x => /Export CSV|Verify certificate|Most recent/i.test(x.textContent)); return b ? getComputedStyle(b).borderColor : 'none'; })()" 2>/dev/null)
echo "S12-h secondary Button borderColor: $V"
checktrue "S12-h glass-tight border wins (was rgb(28,28,28))" "$(agent-browser eval "(() => { const b = [...document.querySelectorAll('button')].find(x => /Export CSV|Verify certificate|Most recent/i.test(x.textContent)); if (!b) return 'none'; const bd = getComputedStyle(b).borderColor; return String(bd.includes('255, 255, 255, 0.06') || bd.includes('/ 0.06')); })()" 2>/dev/null | rg -o 'true|false|none' | head -1)"

# S12-h: contact chip via deep link — border-primary/25 must compute cyan-tinted
agent-browser open "http://localhost:3001/payments?contact=0x1111111111111111111111111111111111111111" > /dev/null 2>&1
for i in $(seq 1 12); do
  sleep 2
  C=$(agent-browser eval "(() => { const el = [...document.querySelectorAll('div')].find(d => String(d.className).includes('border-primary/25')); return el ? getComputedStyle(el).borderColor : 'missing'; })()" 2>/dev/null)
  [ "$C" != "missing" ] && [ -n "$C" ] && break
done
echo "S12-h contact chip borderColor: $C"
checktrue "S12-h border-primary/25 utility wins (was rgb(28,28,28))" "$(agent-browser eval "(() => { const el = [...document.querySelectorAll('div')].find(d => String(d.className).includes('border-primary/25')); if (!el) return 'none'; const bd = getComputedStyle(el).borderColor; return String(bd.includes('34, 211, 238') || bd.includes('0.25')); })()" 2>/dev/null | rg -o 'true|false|none' | head -1)"

# S12-b: inactive glass-item chips carry the new fill + edge
V=$(agent-browser eval "(() => { const g = document.querySelector('[aria-label=\"Filter payment status\"]'); if (!g) return 'none'; const c = [...g.querySelectorAll('button')].find(c => getComputedStyle(c).backgroundColor.startsWith('rgba(255')); return c ? getComputedStyle(c).backgroundColor : 'none'; })()" 2>/dev/null)
echo "S12-b inactive chip bg: $V"
checktrue "S12-b inactive chip bg ≈ white@0.045" "$(agent-browser eval "(() => { const g = document.querySelector('[aria-label=\"Filter payment status\"]'); if (!g) return 'none'; const c = [...g.querySelectorAll('button')].find(c => getComputedStyle(c).backgroundColor.startsWith('rgba(255') || getComputedStyle(c).backgroundColor.startsWith('#ffffff')); if (!c) return 'false'; return String(/0\.04|#ffffff0/i.test(getComputedStyle(c).backgroundColor)); })()" 2>/dev/null | rg -o 'true|false|none' | head -1)"
checktrue "S12-b inactive chip border ≈ white@0.09 (NOT the #1c1c1c override)" "$(agent-browser eval "(() => { const g = document.querySelector('[aria-label=\"Filter payment status\"]'); if (!g) return 'none'; const c = [...g.querySelectorAll('button')].find(c => { const bd = getComputedStyle(c).borderColor; return bd.startsWith('rgba(255') || bd.startsWith('#ffffff') || bd.includes('oklab'); }); return String(!!c); })()" 2>/dev/null | rg -o 'true|false|none' | head -1)"

# S12-c: FinderSearch resting inset ring
checktrue "S12-c finder search has resting box-shadow ring" "$(agent-browser eval "(() => { const f = document.querySelector('form[role=search]'); return f ? String(getComputedStyle(f).boxShadow !== 'none') : 'none'; })()" 2>/dev/null | rg -o 'true|false|none' | head -1)"

# R34-a: status+attest row — 7 chips in ONE roving row. NOTE: the contact
# deep-link above persists in the URL (lens active) — navigate back to the
# plain page so the census counts all 4 seeded rows.
agent-browser open "http://localhost:3001/payments" > /dev/null 2>&1
for i in $(seq 1 15); do
  n=$(agent-browser eval "document.querySelectorAll('[data-payment-row]').length" 2>/dev/null | tr -dc '0-9')
  [ "${n:-0}" = "4" ] && break; sleep 2
done
N7=$(agent-browser eval "(() => { const g = document.querySelector('[aria-label=\"Filter payment status\"]'); return g ? g.querySelectorAll('button').length : 0; })()" 2>/dev/null | tr -dc '0-9')
check "R34-a status row carries 7 roving chips (4 status + 3 attest)" "7" "$N7"
T1=$(agent-browser eval "(() => { const g = document.querySelector('[aria-label=\"Filter payment status\"]'); g.querySelectorAll('button')[0].focus(); return document.activeElement.textContent.trim().slice(0,10); })()" 2>/dev/null | tr -d '"' | head -1)
agent-browser press ArrowRight > /dev/null 2>&1; sleep 0.4
agent-browser press ArrowRight > /dev/null 2>&1; sleep 0.4
agent-browser press ArrowRight > /dev/null 2>&1; sleep 0.4
agent-browser press ArrowRight > /dev/null 2>&1; sleep 0.4
F5=$(agent-browser eval "document.activeElement.textContent.trim()" 2>/dev/null | tr -d '"' | head -1)
echo "R34-a: after 4×ArrowRight from [$T1] → [$F5]"
if echo "$F5" | rg -qi 'attest'; then PASS=$((PASS+1)); echo "PASS: R34-a arrows cross the divider into attest chips"; else FAIL=$((FAIL+1)); echo "FAIL: R34-a attest focus (got [$F5])"; fi
agent-browser press End > /dev/null 2>&1; sleep 0.4
FEND=$(agent-browser eval "document.activeElement.textContent.trim()" 2>/dev/null | tr -d '"' | head -1)
if echo "$FEND" | rg -qi 'verified|on.?chain'; then PASS=$((PASS+1)); echo "PASS: R34-a End jumps to last attest chip ($FEND)"; else FAIL=$((FAIL+1)); echo "FAIL: R34-a End focus (got [$FEND])"; fi
agent-browser press Home > /dev/null 2>&1; sleep 0.4
FH=$(agent-browser eval "document.activeElement.textContent.trim()" 2>/dev/null | tr -d '"' | head -1)
if echo "$FH" | rg -qi '^All|^すべて|^전체|^全部'; then PASS=$((PASS+1)); echo "PASS: R34-a Home returns to All"; else FAIL=$((FAIL+1)); echo "FAIL: R34-a Home focus (got [$FH])"; fi
# Enter activates the focused attest chip. No seeded row carries attested_at,
# so the honest result is the activated chip (aria-pressed) + 0 rows + the
# attested empty state — the LENS switching is what's under test.
agent-browser press ArrowRight > /dev/null 2>&1; sleep 0.4
agent-browser press ArrowRight > /dev/null 2>&1; sleep 0.4
agent-browser press ArrowRight > /dev/null 2>&1; sleep 0.4
agent-browser press ArrowRight > /dev/null 2>&1; sleep 0.4
agent-browser press Enter > /dev/null 2>&1; sleep 1
APRESSED=$(agent-browser eval "(() => { const g = document.querySelector('[aria-label=\"Filter payment status\"]'); const c = [...g.querySelectorAll('button')].find(b => /Attested/i.test(b.textContent)); return String(c.getAttribute('aria-pressed')); })()" 2>/dev/null | rg -o 'true|false' | head -1)
check "R34-a Enter on attest chip activates the lens (aria-pressed)" "true" "$APRESSED"
AROWS=$(agent-browser eval "document.querySelectorAll('[data-payment-row]').length" 2>/dev/null | tr -dc '0-9')
check "R34-a attested lens shows 0 rows (no attested_at in seed — honest)" "0" "$AROWS"

# R34-b: the range row roves on its own (navigate back to All first via URL)
agent-browser open "http://localhost:3001/payments" > /dev/null 2>&1
for i in $(seq 1 15); do
  n=$(agent-browser eval "document.querySelectorAll('[data-payment-row]').length" 2>/dev/null | tr -dc '0-9')
  [ "${n:-0}" = "4" ] && break; sleep 2
done
RN=$(agent-browser eval "(() => { const g = document.querySelector('[aria-label=\"Payments time range\"]'); return g ? g.querySelectorAll('button').length : 0; })()" 2>/dev/null | tr -dc '0-9')
check "R34-b range row renders 4 chips (seeded rows span >24h)" "4" "$RN"
R1=$(agent-browser eval "(() => { const g = document.querySelector('[aria-label=\"Payments time range\"]'); g.querySelectorAll('button')[0].focus(); return document.activeElement.textContent.trim().slice(0,8); })()" 2>/dev/null | tr -d '"' | head -1)
agent-browser press ArrowRight > /dev/null 2>&1; sleep 0.4
RF2=$(agent-browser eval "document.activeElement.textContent.trim()" 2>/dev/null | tr -d '"' | head -1)
echo "R34-b: range focus [$R1] → [$RF2]"
if echo "$RF2" | rg -qi '24'; then PASS=$((PASS+1)); echo "PASS: R34-b range row arrows move focus (→ 24h)"; else FAIL=$((FAIL+1)); echo "FAIL: R34-b range focus (got [$RF2])"; fi

E=$(agent-browser errors 2>&1)
{ [ -z "$E" ] || [ "$E" = "No page errors" ]; } && { PASS=$((PASS+1)); echo "PASS: 0 page errors on /payments"; } || { FAIL=$((FAIL+1)); echo "FAIL: page errors: $E"; }

# Cleanup
node --import tsx scripts/qa-r5-seed.mts cleanup
agent-browser close --all > /dev/null 2>&1
kill $SERVER_PID 2>/dev/null
sleep 2
pkill -f "next dev.*3001" 2>/dev/null
echo ""
echo "=== PART A RESULT: $PASS PASS / $FAIL FAIL ==="
