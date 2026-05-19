# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# Krawl — Knowledge Retrieval and Web Logic Engine — production container.
#
# Two-stage build on mcr.microsoft.com/playwright (Jammy). The Playwright
# base ships Chromium + every libnss/libxkb/libgbm system dep already
# wired up. Runtime is Node (via tsx for direct TypeScript execution) —
# not Bun, because better-sqlite3 ships V8-ABI prebuilds that crash under
# Bun's JSC engine, and the rest of Krawl (db/schema.ts, db/query.ts,
# db/indexer.ts) is built on better-sqlite3.
#
#   build    → npm install (compiles better-sqlite3 native bindings) +
#              tsc typecheck
#   runtime  → /app source + node_modules + Chromium browsers,
#              entrypoint dispatch via KRAWL_MODE
#
# Entrypoints (scripts/docker-entrypoint.sh):
#   KRAWL_MODE=mcp      run MCP HTTP server on :3333 (default for the public deploy)
#   KRAWL_MODE=loop     run KRAWL_TASKS, sleep KRAWL_INTERVAL_SECONDS, repeat
#   KRAWL_MODE=once     run KRAWL_TASKS once, exit (good for host-cron / k8s Job)
#   KRAWL_MODE=query    one-shot --query "$KRAWL_QUERY"
#   KRAWL_MODE=stats    one-shot --stats
#   KRAWL_MODE=export   one-shot --export $KRAWL_EXPORT_TARGET
#   KRAWL_MODE=shell    drop to bash for debugging
#
# Build:                docker build -t krawl:latest .
# Skip tests (faster):  docker build --build-arg SKIP_TESTS=1 -t krawl:latest .
# Run MCP locally:      docker run --rm -p 3333:3333 \
#                                  -v $PWD/data:/data \
#                                  -e KRAWL_MODE=mcp \
#                                  -e KRAWL_API_KEY=sk-dev \
#                                  krawl:latest
# Run scheduler:        docker run -d --name krawl -v $PWD/data:/data \
#                                  -v $PWD/tasks:/tasks:ro \
#                                  -e KRAWL_MODE=loop \
#                                  -e KRAWL_INTERVAL_SECONDS=21600 \
#                                  -e KRAWL_TASKS=/tasks/financial.json \
#                                  krawl:latest
#
# Persistence:
#   -v $PWD/data:/data        SQLite DB, JSONL output, checkpoints, router cache
#   -v $PWD/tasks:/tasks:ro   task JSON/TXT inputs (read-only)
#   -v $PWD/exports:/exports  CSV exports written by --export
#
# Recommended public deployment: docker-compose.yml with --profile tls brings
# up a Caddy sidecar that terminates HTTPS for KRAWL_DOMAIN and forwards
# /mcp to the MCP HTTP server with Bearer auth preserved end-to-end.
# (On this VPS we use the shared caddy-router at /root/caddy-router instead.)
# ─────────────────────────────────────────────────────────────────────────────

ARG PLAYWRIGHT_VERSION=v1.49.0-jammy
ARG SKIP_TESTS=0

# ── Stage 1: builder ─────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:${PLAYWRIGHT_VERSION} AS builder

WORKDIR /app

# better-sqlite3 needs python + a C++ toolchain to compile its native bindings.
# The Playwright image already has node/npm.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Lockfile-first: cache deps independently of source changes.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Project sources + configs needed for typecheck + tests.
COPY tsconfig.json eslint.config.js vitest.config.ts ./
COPY krawl.ts ./
COPY config ./config
COPY core ./core
COPY db ./db
COPY output ./output
COPY resilience ./resilience
COPY selectors ./selectors
COPY workers ./workers
COPY src ./src
COPY tests ./tests
COPY tasks ./tasks

# Typecheck always; full test suite optional (Playwright e2e tests need network).
RUN npx tsc --noEmit
ARG SKIP_TESTS
RUN if [ "${SKIP_TESTS:-0}" = "1" ]; then \
      echo "[docker] SKIP_TESTS=1 — skipping vitest"; \
    else \
      npm run test:unit; \
    fi

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:${PLAYWRIGHT_VERSION} AS runtime

ENV NODE_ENV=production
# Defaults — override per `docker run -e ...` / compose env.
ENV KRAWL_MODE=mcp
ENV KRAWL_INTERVAL_SECONDS=21600
ENV KRAWL_DATA_DIR=/data
ENV KRAWL_EXPORTS_DIR=/exports
ENV KRAWL_TASKS=/tasks/financial.json
ENV KRAWL_HTTP_CONCURRENCY=5
ENV KRAWL_BROWSER_CONTEXTS=3
ENV KRAWL_PORT=3333
ENV KRAWL_HOST=0.0.0.0

# tini for proper PID 1 (reaps zombie chromium processes on long runs),
# curl for HEALTHCHECK against the MCP /health endpoint.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini curl \
 && rm -rf /var/lib/apt/lists/*

# Unprivileged user. The Playwright image ships a `pwuser` (uid 1000) we reuse —
# Chromium's sandbox refuses to run as root, and pwuser already has the right
# perms on /ms-playwright (the browser cache).
WORKDIR /app

COPY --from=builder --chown=pwuser:pwuser /app/node_modules ./node_modules
COPY --from=builder --chown=pwuser:pwuser /app/package.json ./package.json
COPY --from=builder --chown=pwuser:pwuser /app/package-lock.json ./package-lock.json
COPY --from=builder --chown=pwuser:pwuser /app/tsconfig.json ./tsconfig.json
COPY --from=builder --chown=pwuser:pwuser /app/krawl.ts ./krawl.ts
COPY --from=builder --chown=pwuser:pwuser /app/config ./config
COPY --from=builder --chown=pwuser:pwuser /app/core ./core
COPY --from=builder --chown=pwuser:pwuser /app/db ./db
COPY --from=builder --chown=pwuser:pwuser /app/output ./output
COPY --from=builder --chown=pwuser:pwuser /app/resilience ./resilience
COPY --from=builder --chown=pwuser:pwuser /app/selectors ./selectors
COPY --from=builder --chown=pwuser:pwuser /app/workers ./workers
COPY --from=builder --chown=pwuser:pwuser /app/src ./src

COPY --chown=pwuser:pwuser scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
 && chmod +x /usr/local/bin/docker-entrypoint.sh

# Pre-create mount points so an unmounted run still works.
RUN mkdir -p "${KRAWL_DATA_DIR}" "${KRAWL_EXPORTS_DIR}" /tasks \
 && chown -R pwuser:pwuser "${KRAWL_DATA_DIR}" "${KRAWL_EXPORTS_DIR}" /tasks /app

USER pwuser
EXPOSE 3333
VOLUME ["/data", "/exports"]

# Healthcheck: MCP /health when running in mcp mode; falls back to a process
# probe for the long-running loop mode (no HTTP endpoint there).
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${KRAWL_PORT}/health" >/dev/null 2>&1 \
   || pgrep -f "tsx.*krawl" >/dev/null \
   || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
