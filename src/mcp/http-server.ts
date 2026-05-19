// src/mcp/http-server.ts
// Minimal MCP server over plain HTTP. JSON-RPC 2.0 at POST /mcp,
// public liveness at GET /health. Bearer-token auth.
//
// Runs on Node via tsx: `npx tsx src/mcp/http-server.ts`. We use the
// stdlib `node:http` rather than Bun.serve because better-sqlite3 ships
// V8-ABI prebuilds that crash under Bun's JSC engine — the rest of Krawl
// (db/schema.ts, db/query.ts, db/indexer.ts) depends on better-sqlite3, so
// the MCP server must run on Node too.
//
// Auth: pick ONE. tokens.json (file) wins if multiple are set.
//   KRAWL_TOKENS_FILE=/run/secrets/tokens.json   { "claude-desktop": "sk-..." }
//   KRAWL_TOKENS=claude:sk-aaa,hermes:sk-bbb
//   KRAWL_API_KEY=sk-single-shared-token
// With none of the three set, the server starts in UNAUTHENTICATED mode
// and logs a warning — only safe behind a firewall / private network.

import fs from "fs";
import http from "http";
import { TOOLS, TOOL_BY_NAME } from "./tools.js";

const PORT = parseInt(process.env["KRAWL_PORT"] ?? "3333", 10);
const HOST = process.env["KRAWL_HOST"] ?? "0.0.0.0";

// ── Auth ─────────────────────────────────────────────────────────────────────

type TokenMap = Record<string, string>;  // name → secret

function loadTokens(): TokenMap | null {
  const file = process.env["KRAWL_TOKENS_FILE"];
  if (file && fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as TokenMap;
      if (Object.keys(raw).length > 0) return raw;
    } catch (e) {
      console.error(`[mcp] KRAWL_TOKENS_FILE invalid JSON at ${file}:`, e);
    }
  }
  const inline = process.env["KRAWL_TOKENS"];
  if (inline) {
    const map: TokenMap = {};
    for (const pair of inline.split(",")) {
      const [name, secret] = pair.split(":");
      if (name && secret) map[name.trim()] = secret.trim();
    }
    if (Object.keys(map).length > 0) return map;
  }
  const single = process.env["KRAWL_API_KEY"];
  if (single) return { default: single };
  return null;
}

const TOKENS = loadTokens();
if (!TOKENS) {
  console.warn("[mcp] no auth configured — set KRAWL_API_KEY or KRAWL_TOKENS_FILE for production");
}

const TOKEN_REVERSE: Map<string, string> = new Map(
  TOKENS ? Object.entries(TOKENS).map(([n, s]) => [s, n]) : [],
);

function authenticate(authHeader: string | undefined):
  | { ok: true; client: string }
  | { ok: false; reason: string }
{
  if (!TOKENS) return { ok: true, client: "anonymous" };
  const match = authHeader ? /^Bearer\s+(.+)$/i.exec(authHeader) : null;
  if (!match) return { ok: false, reason: "missing Bearer token" };
  const name = TOKEN_REVERSE.get(match[1]);
  if (!name) return { ok: false, reason: "unknown token" };
  return { ok: true, client: name };
}

// ── JSON-RPC framing ─────────────────────────────────────────────────────────

interface JsonRpcReq {
  jsonrpc: "2.0";
  id     : number | string | null;
  method : string;
  params?: Record<string, unknown>;
}

function rpcResult(id: number | string | null, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function rpcError(
  id     : number | string | null,
  code   : number,
  message: string,
  data  ?: unknown,
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    error  : { code, message, ...(data === undefined ? {} : { data }) },
  });
}

// ── Method handlers ──────────────────────────────────────────────────────────

async function dispatch(req: JsonRpcReq): Promise<string> {
  switch (req.method) {
    case "initialize": {
      return rpcResult(req.id, {
        protocolVersion: "2024-11-05",
        capabilities   : { tools: {} },
        serverInfo     : { name: "krawl", version: "1.0.0" },
      });
    }

    case "tools/list": {
      return rpcResult(req.id, {
        tools: TOOLS.map(t => ({
          name        : t.name,
          description : t.description,
          inputSchema : t.inputSchema,
        })),
      });
    }

    case "tools/call": {
      const name = String(req.params?.["name"] ?? "");
      const args = (req.params?.["arguments"] ?? {}) as Record<string, unknown>;
      const tool = TOOL_BY_NAME[name];
      if (!tool) {
        return rpcError(req.id, -32601, `unknown tool: ${name}`);
      }
      try {
        const result = await tool.handler(args);
        return rpcResult(req.id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return rpcError(req.id, -32603, `tool '${name}' failed: ${msg}`);
      }
    }

    case "ping":
      return rpcResult(req.id, {});

    default:
      return rpcError(req.id, -32601, `method not found: ${req.method}`);
  }
}

// ── HTTP server ──────────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  // Liveness — unauthenticated, used by Caddy + Docker healthcheck.
  if (url.pathname === "/health") {
    return send(res, 200, JSON.stringify({
      status : "ok",
      tools  : TOOLS.length,
      authed : TOKENS !== null,
    }));
  }

  // MCP JSON-RPC.
  if (url.pathname === "/mcp") {
    if (req.method !== "POST") {
      return send(res, 405, JSON.stringify({ error: "method not allowed" }));
    }
    const auth = authenticate(req.headers["authorization"]);
    if (!auth.ok) {
      return send(res, 401, JSON.stringify({ error: auth.reason }), {
        "www-authenticate": 'Bearer realm="krawl"',
      });
    }
    let body: JsonRpcReq;
    try {
      body = JSON.parse(await readBody(req)) as JsonRpcReq;
    } catch {
      return send(res, 200, rpcError(null, -32700, "parse error"));
    }
    if (body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      return send(res, 200, rpcError(body?.id ?? null, -32600, "invalid request"));
    }
    try {
      const out = await dispatch(body);
      return send(res, 200, out);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return send(res, 200, rpcError(body?.id ?? null, -32603, `internal error: ${msg}`));
    }
  }

  send(res, 404, JSON.stringify({ error: "not found" }));
});

server.listen(PORT, HOST, () => {
  console.log(`[mcp] krawl MCP server listening on http://${HOST}:${PORT}`);
  console.log(`[mcp] tools: ${TOOLS.map(t => t.name).join(", ")}`);
  console.log(`[mcp] auth: ${TOKENS ? `${Object.keys(TOKENS).length} token(s)` : "DISABLED"}`);
});
