#!/bin/bash
# Round-3 launcher: ACP.ai dev server on :3001, memory-capped for sandbox coexistence
cd /home/z/my-project/acp-ai-repo
export MALLOC_ARENA_MAX=2
export NODE_OPTIONS="--max-old-space-size=1024"
exec node node_modules/.bin/next dev --turbopack -p 3001
