#!/bin/bash
# DEFINITIVE two-tab sync test — real product paths only (UI clicks), correct selectors.
# Proves: (1) create-in-B visible-in-A, (2) delete-in-A disappears-in-B (tombstone path).
set -u
cd /home/z/my-project/acp-ai-repo
export MALLOC_ARENA_MAX=2
export NODE_OPTIONS="--max-old-space-size=1024"

node node_modules/.bin/next dev --turbopack -p 3001 > /tmp/acp-r3d.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 45); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/ 2>/dev/null || echo 000)
  [ "$code" = "200" ] && break
  sleep 2
done
echo "=== SERVER READY ==="
agent-browser close > /dev/null 2>&1

ROWS='document.querySelectorAll("#chat-sidebar-list button[title=\"New chat\"]").length'
ORDER='JSON.parse(localStorage.getItem("acp-ai:chat-sessions")||"{}").order.length'

# Tab A — clean slate (drain pending persist, then remove + reload)
agent-browser open http://localhost:3001/ > /dev/null 2>&1
agent-browser wait --load networkidle --timeout 30000 > /dev/null 2>&1
agent-browser wait 2600 > /dev/null 2>&1
agent-browser eval "localStorage.removeItem('acp-ai:chat-sessions'); 'cleared'" > /dev/null 2>&1
agent-browser reload > /dev/null 2>&1
agent-browser wait --load networkidle --timeout 30000 > /dev/null 2>&1
agent-browser wait 2000 > /dev/null 2>&1
echo "A baseline: rows=$(agent-browser eval "$ROWS" 2>&1 | tail -1) order=$(agent-browser eval "$ORDER" 2>&1 | tail -1)"

# Tab B
agent-browser tab new http://localhost:3001/ > /dev/null 2>&1
agent-browser wait --load networkidle --timeout 30000 > /dev/null 2>&1
agent-browser wait 2000 > /dev/null 2>&1
echo "B baseline: rows=$(agent-browser eval "$ROWS" 2>&1 | tail -1)"

# B creates two chats via the REAL UI path
agent-browser eval "document.querySelector('button svg.lucide-plus')?.closest('button')?.click(); 'ok'" > /dev/null 2>&1
agent-browser wait 2200 > /dev/null 2>&1
agent-browser eval "document.querySelector('button svg.lucide-plus')?.closest('button')?.click(); 'ok'" > /dev/null 2>&1
agent-browser wait 4000 > /dev/null 2>&1
echo "B after 2 creates: rows=$(agent-browser eval "$ROWS" 2>&1 | tail -1) order=$(agent-browser eval "$ORDER" 2>&1 | tail -1)  <-- EXPECTED rows=3"

# A observes the creates
agent-browser tab 1 > /dev/null 2>&1
agent-browser wait 3000 > /dev/null 2>&1
A_ROWS=$(agent-browser eval "$ROWS" 2>&1 | tail -1)
echo "A after sync:     rows=$A_ROWS  <-- EXPECTED 3 (create-sync PROOF)"

# A deletes one chat via the REAL UI path (deleteChat -> tombstone -> persist -> storage event)
agent-browser eval "(() => { const rows=[...document.querySelectorAll('#chat-sidebar-list button[title=\"New chat\"]')]; const row=rows[rows.length-1].closest('div'); const del=row.querySelector('button[aria-label=\"Delete chat\"]'); if(!del) return 'NO DELETE BUTTON'; del.click(); return 'delete clicked'; })()" 2>&1 | tail -1
agent-browser wait 3500 > /dev/null 2>&1
echo "A after delete:   rows=$(agent-browser eval "$ROWS" 2>&1 | tail -1) order=$(agent-browser eval "$ORDER" 2>&1 | tail -1)  <-- EXPECTED 2"

# B observes the delete
agent-browser tab 2 > /dev/null 2>&1
agent-browser wait 3000 > /dev/null 2>&1
B_ROWS=$(agent-browser eval "$ROWS" 2>&1 | tail -1)
echo "B after delete:   rows=$B_ROWS  <-- EXPECTED 2 (delete-sync PROOF)"

agent-browser errors 2>&1 | head -3
agent-browser tab close > /dev/null 2>&1
agent-browser close > /dev/null 2>&1
kill $SERVER_PID 2>/dev/null; sleep 1; pkill -f "next dev.*3001" 2>/dev/null
echo "=== DONE ==="
