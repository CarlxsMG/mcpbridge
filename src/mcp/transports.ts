import type { Express, Request, Response } from "express";
import { randomUUID } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer, type McpServerScope } from "./mcp-server.js";
import { originValidator } from "../middleware/origin-validator.js";
import { mcpAuth, rootMcpAuth } from "../middleware/auth.js";
import { rateLimitMcp } from "../middleware/rate-limiter.js";
import { config } from "../config.js";
import { registry } from "./registry.js";
import { getBundleToolKeys } from "../admin/tool-composition/bundles.js";
import { setSessionCountGetter } from "../observability/metrics.js";
import { log } from "../logger.js";

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Returns true only if `s` is a well-formed UUID v4 string. */
function isValidSessionId(s: unknown): s is string {
  return typeof s === "string" && UUID_V4_RE.test(s);
}

// Session map — Streamable HTTP is now the only inbound MCP transport (the
// legacy SSE fallback, GET /sse + POST /messages, was removed alongside the
// aggregated-data /mcp scope it was tied to; see docs/guide/architecture.md).
const streamableSessions = new Map<string, StreamableHTTPServerTransport>();

// O(1) reverse lookup: transport instance → sessionId (WeakMap; GC cleans up automatically)
const streamableSessionIdByTransport = new WeakMap<StreamableHTTPServerTransport, string>();

/**
 * Which scope a session is bound to, namespaced as `client:<name>` /
 * `bundle:<name>` / `system` so a client and a bundle that happen to share a
 * literal name can never be confused (they live in separate SQL tables with
 * independent uniqueness). Every scope gets an entry — used to reject a
 * session replayed against a *different* scope's URL (confused-deputy
 * defense). This is a clarity/honesty backstop, not the actual security
 * boundary: a session's tool scope is bound into its `Server` instance at
 * creation time regardless of which URL later reaches its transport, so a
 * mismatch here can never grant access beyond what the session already has —
 * it only turns a confusing cross-scope reuse into an honest 404.
 */
const sessionScope = new Map<string, string>();

/** Namespaces a scope into the `sessionScope` map's key format. */
function scopeKey(scope: McpServerScope): string {
  return scope.kind === "system" ? "system" : `${scope.kind}:${scope.name}`;
}

// Atomic session counter — incremented as a reservation BEFORE map insert,
// decremented on every cleanup path (onclose, TTL eviction, error rollback,
// explicit DELETE, graceful shutdown). Because Node/Bun is single-threaded,
// ++ and -- between awaits are atomic at the JS level; no lock is needed.
let activeSessionCount = 0;

// Session activity tracking for TTL cleanup
const sessionActivity = new Map<string, number>();

function touchSession(sessionId: string): void {
  sessionActivity.set(sessionId, Date.now());
}

// Session cleanup loop — removes zombie sessions
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function startSessionCleanup(): void {
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, lastActivity] of sessionActivity) {
      if (now - lastActivity > config.sessionTtlMs) {
        const streamable = streamableSessions.get(id);
        if (streamable) {
          try {
            streamable.close();
          } catch {}
          streamableSessions.delete(id);
          sessionScope.delete(id);
          activeSessionCount = Math.max(0, activeSessionCount - 1);
        }
        sessionActivity.delete(id);
      }
    }
  }, 60_000);
}

/** Returns the current number of active MCP (Streamable HTTP) sessions. */
export function getActiveSessionCount(): number {
  return activeSessionCount;
}

// ============================================
// Streamable HTTP handlers — shared between the /mcp system root, the
// sharded /mcp/:clientName endpoint, and the bundle /mcp-custom/:bundleName
// endpoint.
// ============================================

/** True when `scope` names a client or bundle that doesn't currently exist. The system scope always exists (auth already gated it). */
function scopeNotFound(scope: McpServerScope): boolean {
  if (scope.kind === "client") return !registry.getClient(scope.name);
  if (scope.kind === "bundle") return getBundleToolKeys(scope.name) === undefined;
  return false;
}

async function handleStreamablePost(req: Request, res: Response, scope: McpServerScope): Promise<void> {
  let transport: StreamableHTTPServerTransport | undefined;
  let transportInserted = false;
  const rawSessionId = req.headers["mcp-session-id"];
  const sessionId = rawSessionId !== undefined ? (isValidSessionId(rawSessionId) ? rawSessionId : null) : undefined;

  if (sessionId === null) {
    res.status(400).json({
      error: { code: "INVALID_SESSION_ID", message: "Session ID must be a UUID v4" },
    });
    return;
  }

  try {
    if (sessionId && streamableSessions.has(sessionId)) {
      if (sessionScope.get(sessionId) !== scopeKey(scope)) {
        // Same 404 shape as "unknown session" — don't leak whether the ID
        // exists but belongs to a different shard/bundle/root.
        res.status(404).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Session not found or expired" },
          id: req.body?.id ?? null,
        });
        return;
      }
      // Existing session
      const existingTransport = streamableSessions.get(sessionId)!;
      await existingTransport.handleRequest(req, res, req.body);
      touchSession(sessionId);
    } else if (!sessionId) {
      if (scopeNotFound(scope)) {
        const notFound =
          scope.kind === "client"
            ? { code: "CLIENT_NOT_FOUND", message: "Client not found" }
            : { code: "BUNDLE_NOT_FOUND", message: "Bundle not found" };
        res.status(404).json({ error: notFound });
        return;
      }

      // Max sessions cap — check-and-reserve atomically (counter is the
      // reservation; increment happens BEFORE the map insert so concurrent
      // requests cannot both read the same under-cap count).
      if (activeSessionCount >= config.maxSessions) {
        res.status(503).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Server at capacity, retry later" },
          id: req.body?.id ?? null,
        });
        return;
      }
      activeSessionCount++;

      // New session — Initialize request
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      // When the transport closes, remove it from the map and release reservation
      transport.onclose = () => {
        const sid = streamableSessionIdByTransport.get(transport!);
        if (sid !== undefined) {
          streamableSessions.delete(sid);
          sessionActivity.delete(sid);
          sessionScope.delete(sid);
          activeSessionCount = Math.max(0, activeSessionCount - 1);
        }
      };

      const server = createMcpServer(scope);
      await server.connect(transport);

      // The session ID is set after handling the initialize request
      await transport.handleRequest(req, res, req.body);

      // Store session after handling (sessionId is now set)
      if (transport.sessionId) {
        streamableSessions.set(transport.sessionId, transport);
        streamableSessionIdByTransport.set(transport, transport.sessionId);
        sessionScope.set(transport.sessionId, scopeKey(scope));
        transportInserted = true;
        touchSession(transport.sessionId);
      }
    } else {
      // Session ID provided but not found — expired
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Session not found or expired" },
        id: req.body?.id ?? null,
      });
    }
  } catch (err) {
    log("error", `POST handler failed (scope=${scopeKey(scope)})`, {
      sessionId,
      err,
    });
    if (transport && !transportInserted) {
      // Release the reservation taken before the failed insert
      activeSessionCount = Math.max(0, activeSessionCount - 1);
      await transport.close().catch(() => {});
    }
    if (res.headersSent) return;
    const id = typeof req.body?.id === "string" || typeof req.body?.id === "number" ? req.body.id : null;
    res.status(500).json({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal error" },
      id,
    });
  }
}

async function handleStreamableGet(req: Request, res: Response, scope: McpServerScope): Promise<void> {
  const rawSessionId = req.headers["mcp-session-id"];
  if (!isValidSessionId(rawSessionId)) {
    res.status(400).json({
      error: { code: "INVALID_SESSION_ID", message: "Session ID must be a UUID v4" },
    });
    return;
  }
  const sessionId = rawSessionId;
  if (sessionScope.get(sessionId) !== scopeKey(scope)) {
    res.status(404).json({ jsonrpc: "2.0", error: { code: -32000, message: "Session not found" }, id: null });
    return;
  }
  const transport = streamableSessions.get(sessionId);
  if (!transport) {
    res.status(404).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Session not found" },
      id: null,
    });
    return;
  }
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  await transport.handleRequest(req, res);
}

async function handleStreamableDelete(req: Request, res: Response, scope: McpServerScope): Promise<void> {
  const rawSessionId = req.headers["mcp-session-id"];
  if (!isValidSessionId(rawSessionId)) {
    res.status(400).json({
      error: { code: "INVALID_SESSION_ID", message: "Session ID must be a UUID v4" },
    });
    return;
  }
  const sessionId = rawSessionId;
  if (sessionScope.get(sessionId) !== scopeKey(scope)) {
    res.status(404).json({ jsonrpc: "2.0", error: { code: -32000, message: "Session not found" }, id: null });
    return;
  }
  const transport = streamableSessions.get(sessionId);
  if (!transport) {
    res.status(404).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Session not found" },
      id: null,
    });
    return;
  }
  await transport.handleRequest(req, res);
  streamableSessions.delete(sessionId);
  sessionScope.delete(sessionId);
  activeSessionCount = Math.max(0, activeSessionCount - 1);
}

export function setupTransports(app: Express): () => void {
  startSessionCleanup();
  setSessionCountGetter(() => ({
    streamable: streamableSessions.size,
  }));

  // ============================================
  // Sharded Streamable HTTP transport — one endpoint per registered client.
  // The only place a client's backend tools are served; there is no
  // "everything flattened together" endpoint any more (see the system root
  // below for what /mcp itself now serves).
  // ============================================

  app.use("/mcp/:clientName", originValidator);
  app.use("/mcp/:clientName", mcpAuth);
  app.use("/mcp/:clientName", rateLimitMcp(config.rateLimitMcp));

  app.post("/mcp/:clientName", async (req, res) => {
    await handleStreamablePost(req, res, { kind: "client", name: req.params.clientName });
  });
  app.get("/mcp/:clientName", async (req, res) => {
    await handleStreamableGet(req, res, { kind: "client", name: req.params.clientName });
  });
  app.delete("/mcp/:clientName", async (req, res) => {
    await handleStreamableDelete(req, res, { kind: "client", name: req.params.clientName });
  });

  // ============================================
  // Bundle Streamable HTTP transport — one endpoint per admin-curated bundle
  // (a named cross-client tool selection, see src/bundles.ts). Deliberately a
  // sibling top-level path ("/mcp-custom", not "/mcp/custom") rather than
  // nested under /mcp: Express's app.use() prefix-matches on path segments,
  // so a nested path would still traverse the /mcp/:clientName and /mcp
  // middleware chains above (double/triple-running origin/auth/rate-limit
  // checks — confirmed empirically to under-deliver the rate limit budget).
  // A distinct first segment has zero prefix overlap with either, regardless
  // of registration order — the same reasoning /admin vs /admin-api already
  // relies on below.
  // ============================================

  app.use("/mcp-custom/:bundleName", originValidator);
  app.use("/mcp-custom/:bundleName", mcpAuth);
  app.use("/mcp-custom/:bundleName", rateLimitMcp(config.rateLimitMcp));

  app.post("/mcp-custom/:bundleName", async (req, res) => {
    await handleStreamablePost(req, res, { kind: "bundle", name: req.params.bundleName });
  });
  app.get("/mcp-custom/:bundleName", async (req, res) => {
    await handleStreamableGet(req, res, { kind: "bundle", name: req.params.bundleName });
  });
  app.delete("/mcp-custom/:bundleName", async (req, res) => {
    await handleStreamableDelete(req, res, { kind: "bundle", name: req.params.bundleName });
  });

  // ============================================
  // System root — /mcp is the gateway's own control plane: management +
  // data-retrieval tools over the gateway itself (src/mcp/system-tools.ts),
  // never backend tools (that's what the two shards above are for). Guarded
  // by rootMcpAuth, not mcpAuth: unlike the data-plane shards, this endpoint
  // has NO "no auth material configured => allow all" fallback — a caller
  // must resolve to a real system role or be rejected outright. Always
  // mounted; there is no flag to disable it (the surface itself is the
  // access control — see resolveSystemRole/rootMcpAuth).
  // ============================================

  app.use("/mcp", originValidator);
  app.use("/mcp", rootMcpAuth);
  app.use("/mcp", rateLimitMcp(config.rateLimitMcp));

  app.post("/mcp", async (req, res) => {
    await handleStreamablePost(req, res, { kind: "system" });
  });
  app.get("/mcp", async (req, res) => {
    await handleStreamableGet(req, res, { kind: "system" });
  });
  app.delete("/mcp", async (req, res) => {
    await handleStreamableDelete(req, res, { kind: "system" });
  });

  // Return cleanup function for graceful shutdown
  return () => {
    if (cleanupTimer) clearInterval(cleanupTimer);
    for (const [id, transport] of streamableSessions) {
      try {
        transport.close();
      } catch {}
      streamableSessions.delete(id);
      sessionScope.delete(id);
      activeSessionCount = Math.max(0, activeSessionCount - 1);
    }
  };
}
