#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Krawl container entrypoint — dispatch on KRAWL_MODE.
#
# Modes:
#   mcp      MCP HTTP server on :KRAWL_PORT (Bearer auth, JSON-RPC at /mcp)
#   once     run KRAWL_TASKS once, exit (host-cron / k8s Job)
#   loop     run, sleep KRAWL_INTERVAL_SECONDS, repeat forever
#   query    one-shot SQL: --query "$KRAWL_QUERY"
#   stats    one-shot --stats
#   export   one-shot --export "$KRAWL_EXPORT_TARGET" (default: all)
#   shell    drop to bash (debug)
#
# All file paths default into the mounted volumes (/data, /exports, /tasks).
# tsx runs the TypeScript directly with no separate build step. We tried Bun
# but better-sqlite3 ships V8-ABI prebuilds that crash under Bun's JSC engine.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

MODE="${KRAWL_MODE:-mcp}"
DATA_DIR="${KRAWL_DATA_DIR:-/data}"
EXPORTS_DIR="${KRAWL_EXPORTS_DIR:-/exports}"
TASKS="${KRAWL_TASKS:-/tasks/financial.json}"
INTERVAL="${KRAWL_INTERVAL_SECONDS:-21600}"
CONCURRENCY="${KRAWL_HTTP_CONCURRENCY:-5}"
BROWSERS="${KRAWL_BROWSER_CONTEXTS:-3}"

DB_PATH="${DATA_DIR}/krawl.db"
JSONL_PATH="${DATA_DIR}/krawl_output.jsonl"

# Export so the MCP server picks them up — http-server.ts reads these to
# resolve default paths for the krawl_* tools.
export KRAWL_DB_PATH="$DB_PATH"
export KRAWL_JSONL_PATH="$JSONL_PATH"
export KRAWL_EXPORTS_DIR

mkdir -p "$DATA_DIR" "$EXPORTS_DIR"
cd /app

run_once() {
  echo "[krawl] $(date -Iseconds) — starting run (tasks=${TASKS})"
  npx tsx krawl.ts \
    --tasks "$TASKS" \
    --db "$DB_PATH" \
    --output "$JSONL_PATH" \
    --concurrency "$CONCURRENCY" \
    --browsers "$BROWSERS" \
    "$@"
  echo "[krawl] $(date -Iseconds) — run complete"
}

case "$MODE" in
  mcp)
    echo "[krawl] starting MCP HTTP server on :${KRAWL_PORT:-3333}"
    exec npx tsx src/mcp/http-server.ts
    ;;

  once)
    run_once "$@"
    ;;

  loop)
    # Trap SIGTERM so `docker stop` finishes the current run before exiting
    # instead of leaving a half-written SQLite WAL.
    trap 'echo "[krawl] received SIGTERM, finishing current iteration"; exit 0' TERM INT
    while true; do
      # --resume picks up any checkpoint left by a prior crash/SIGKILL.
      run_once --resume || echo "[krawl] iteration failed (exit=$?), continuing"
      echo "[krawl] sleeping ${INTERVAL}s until next run"
      sleep "$INTERVAL" &
      wait $!
    done
    ;;

  query)
    : "${KRAWL_QUERY:?KRAWL_QUERY must be set in query mode}"
    npx tsx krawl.ts --db "$DB_PATH" --query "$KRAWL_QUERY"
    ;;

  stats)
    npx tsx krawl.ts --db "$DB_PATH" --stats
    ;;

  export)
    TARGET="${KRAWL_EXPORT_TARGET:-all}"
    npx tsx krawl.ts --db "$DB_PATH" --export "$TARGET" --out "$EXPORTS_DIR"
    ;;

  shell)
    exec bash
    ;;

  *)
    echo "[krawl] unknown KRAWL_MODE=$MODE (expected: mcp|once|loop|query|stats|export|shell)" >&2
    exit 2
    ;;
esac
