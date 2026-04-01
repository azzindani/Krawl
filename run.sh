#!/bin/bash
# run.sh
# Usage:
#   bash run.sh                          → run tasks/financial.json
#   bash run.sh tasks/test_100.json      → run specific file
#   bash run.sh tasks/test_100.json --resume   → resume interrupted run

TASKS=${1:-"tasks/financial.json"}
shift || true

npx tsx krawl.ts \
  --tasks "$TASKS" \
  --db krawl.db \
  --output krawl_output.jsonl \
  "$@"
