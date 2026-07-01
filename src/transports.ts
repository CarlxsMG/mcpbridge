import type { Express, Request, Response } from "express";
import { randomUUID } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpServer, type McpServerScope } from "./mcp-server.js";
import { originValidator } from "./middleware/origin-validator.js";
import { mcpAuth } from "./middleware/auth.js";
import { rateLimitMcp } from "./middleware/rate-limiter.js";
import { config } from "./config.js";
import { registry } from "./registry.js";
import { getBundleToolKeys } from "./bundles.js";
import { setSessionCountGetter } from "./routes/metrics.js";
import { log } from "./logger.js";

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Returns true only if `s` is a well-formed UUID v4 string. */
function isValidSessionId(s: unknown): s is string {
  return typeof s === "string" && UUID_V4_RE.test(s);
}

// Session maps
const streamableSessions = new Map<string, StreamableHTTPServerTransport>();
const sseSessions = new Map<string, SSEServerTransport>();

// O(1) reverse lookup: transport instance → sessionId (WeakMap; GC cleans up automatically)
const streamableSessionIdByTransport = new WeakMap<StreamableHTTPServerTransport, string>();
const sseSessionIdByTransport = new WeakMap<SSEServerTransport, string>();

/**
 * Which scope a *sharded* (/mcp/:clientName) or *bundle* (/mcp-custom/:bundleName)
 * streamable session is bound to, namespaced as `client:<name>` / `bundle:<name>`
 * so a client and a bundle that happen to share a literal name can never be
 * confused (they live in separate SQL tables with independent uniqueness).
 * Aggregated (/mcp) sessions never get an entry here. Used only to reject a
 * session replayed against a *different* scope's URL (confused-deputy
 * defense) — the aggregated endpoint doesn't consult this map at all, since
 * a session's actual tool scope is bound into its `Server` instance at
 * creation time regardless of which URL later reaches its transport.
 */
const sessionScope = new Map<string, string>();

/** Namespaces a scope into the `sessionScope` map's key format. */
function scopeKey(scope: McpServerScope): string {
  return `${scope.kind}:${scope.name}`;
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
          try { streamable.close(); } catch {}
          streamableSessions.delete(id);
          sessionScope.delete(id);
          activeSessionCount = Math.max(0, activeSessionCount - 1);
        }
        const sse = sseSessions.get(id);
        if (sse) {
          try { sse.close(); } catch {}
          sseSessions.delete(id);
          activeSessionCount = Math.max(0, activeSessionCount - 1);
        }
        sessionActivity.delete(id);
      }
    }
  }, 60_000);
}

/** Returns the current number of active MCP sessions (streamable + SSE). */
export function getActiveSessionCount(): number {
  return activeSessionCount;
}

// ============================================
// Streamable HTTP handlers — shared between the aggregated /mcp endpoint,
// the sharded /mcp/:clientName endpoint, and the bundle /mcp-custom/:bundleName
// endpoint. `scope` is undefined for the aggregated path.
// ============================================

/** True when `scope` names a client or bundle that doesn't currently exist. */
function scopeNotFound(scope: McpServerScope): boolean {
  if (scope.kind === "client") return !registry.getClient(scope.name);
  return getBundleToolKeys(scope.name) === undefined;
}

async function handleStreamablePost(req: Request, res: Response, scope: McpServerScope | undefined): Promise<void> {
  let transport: StreamableHTTPServerTransport | undefined;
  let transportInserted = false;
  const rawSessionId = req.headers["mcp-session-id"];
  const sessionId = rawSessionId !== undefined
    ? (isValidSessionId(rawSessionId) ? rawSessionId : null)
    : undefined;

  if (sessionId === null) {
    res.status(400).json({
      error: { code: "INVALID_SESSION_ID", message: "Session ID must be a UUID v4" },
    });
    return;
  }

  try {
    if (sessionId && streamableSessions.has(sessionId)) {
      if (scope && sessionScope.get(sessionId) !== scopeKey(scope)) {
        // Same 404 shape as "unknown session" — don't leak whether the ID
        // exists but belongs to a different shard/bundle.
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
      if (scope && scopeNotFound(scope)) {
        const notFound = scope.kind === "client"
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
        if (scope) sessionScope.set(transport.sessionId, scopeKey(scope));
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
    log("error", scope ? `POST /mcp handler failed (scope=${scopeKey(scope)})` : "POST /mcp failed", { sessionId, err });
    if (transport && !transportInserted) {
      // Release the reservation taken before the failed insert
      activeSessionCount = Math.max(0, activeSessionCount - 1);
      await transport.close().catch(() => {});
    }
    if (res.headersSent) return;
    const id = typeof req.body?.id === "string" || typeof req.body?.id === "number"
      ? req.body.id
      : null;
    res.status(500).json({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal error" },
      id,
    });
  }
}

async function handleStreamableGet(req: Request, res: Response, scope: McpServerScope | undefined): Promise<void> {
  const rawSessionId = req.headers["mcp-session-id"];
  if (!isValidSessionId(rawSessionId)) {
    res.status(400).json({
      error: { code: "INVALID_SESSION_ID", message: "Session ID must be a UUID v4" },
    });
    return;
  }
  const sessionId = rawSessionId;
  if (scope && sessionScope.get(sessionId) !== scopeKey(scope)) {
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

async function handleStreamableDelete(req: Request, res: Response, scope: McpServerScope | undefined): Promise<void> {
  const rawSessionId = req.headers["mcp-session-id"];
  if (!isValidSessionId(rawSessionId)) {
    res.status(400).json({
      error: { code: "INVALID_SESSION_ID", message: "Session ID must be a UUID v4" },
    });
    return;
  }
  const sessionId = rawSessionId;
  if (scope && sessionScope.get(sessionId) !== scopeKey(scope)) {
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
    sse: sseSessions.size,
  }));

  // ============================================
  // Sharded Streamable HTTP transport — one endpoint per registered client.
  // Recommended at scale: keeps each session's tool list bounded to a single
  // client instead of every registered client's tools flattened together.
  // Always mounted (not gated by ENABLE_AGGREGATED_MCP).
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
  // relies on below. Always mounted (not gated by ENABLE_AGGREGATED_MCP).
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
  // Aggregated transports — legacy "everything in one session" behaviour.
  // Togglable via ENABLE_AGGREGATED_MCP; disable it once running at a scale
  // where one flattened tool list stops being useful (thousands of tools).
  // ============================================

  if (config.enableAggregatedMcp) {
    // Origin validation for MCP endpoints (required by MCP spec 2025-06-18)
    app.use("/mcp", originValidator);
    app.use("/mcp", mcpAuth);
    app.use("/mcp", rateLimitMcp(config.rateLimitMcp));

    app.post("/mcp", async (req, res) => {
      await handleStreamablePost(req, res, undefined);
    });
    app.get("/mcp", async (req, res) => {
      await handleStreamableGet(req, res, undefined);
    });
    app.delete("/mcp", async (req, res) => {
      await handleStreamableDelete(req, res, undefined);
    });

    // ============================================
    // Legacy SSE transport (fallback)
    // Two endpoints: GET /sse + POST /messages
    // ============================================

    app.get("/sse", originValidator, mcpAuth, rateLimitMcp(config.rateLimitMcp), async (req, res) => {
      // Atomic check-and-reserve using the module-level counter
      if (activeSessionCount >= config.maxSessions) {
        res.status(503).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Server at capacity, retry later" },
          id: null,
        });
        return;
      }
      activeSessionCount++;

      let transport: SSEServerTransport | undefined;
      let server: ReturnType<typeof createMcpServer> | undefined;
      let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
      let sessionInserted = false;
      let sessionId: string | undefined;

      try {
        transport = new SSEServerTransport("/messages", res);
        sessionId = transport.sessionId;

        // Ensure proper SSE headers for proxy/CDN compatibility
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();
        sseSessions.set(transport.sessionId, transport);
        sseSessionIdByTransport.set(transport, transport.sessionId);
        sessionInserted = true;
        touchSession(transport.sessionId);

        // SSE heartbeat every 15s
        heartbeatInterval = setInterval(() => {
          try {
            res.write(":heartbeat\n\n");
            touchSession(transport!.sessionId);
          } catch {
            clearInterval(heartbeatInterval);
            sseSessions.delete(transport!.sessionId);
            sessionActivity.delete(transport!.sessionId);
            activeSessionCount = Math.max(0, activeSessionCount - 1);
            try { server?.close(); } catch {}
            try { transport!.close(); } catch {}
          }
        }, 15_000);

        req.on("close", () => {
          clearInterval(heartbeatInterval);
          sseSessions.delete(transport!.sessionId);
          sessionActivity.delete(transport!.sessionId);
          activeSessionCount = Math.max(0, activeSessionCount - 1);
          try { server?.close(); } catch {}
          try { transport!.close(); } catch {}
        });

        server = createMcpServer();
        await server.connect(transport);
      } catch (err) {
        log("error", "GET /sse failed", { sessionId, err });
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        if (sessionInserted && transport) {
          sseSessions.delete(transport.sessionId);
          sessionActivity.delete(transport.sessionId);
          activeSessionCount = Math.max(0, activeSessionCount - 1);
        } else {
          // Reservation taken but session never inserted — release it
          activeSessionCount = Math.max(0, activeSessionCount - 1);
        }
        await transport?.close().catch(() => {});
        await server?.close().catch(() => {});
        if (!res.headersSent) {
          res.status(500).json({
            error: { code: "SSE_INIT_FAILED", message: "Failed to establish SSE stream" },
          });
        } else {
          try { res.end(); } catch {}
        }
      }
    });

    app.post("/messages", originValidator, mcpAuth, rateLimitMcp(config.rateLimitMcp), async (req, res) => {
      const rawSessionId = req.query.sessionId;
      if (!isValidSessionId(rawSessionId)) {
        res.status(400).json({
          error: { code: "INVALID_SESSION_ID", message: "Session ID must be a UUID v4" },
        });
        return;
      }
      const sessionId = rawSessionId;
      const transport = sseSessions.get(sessionId);
      if (!transport) {
        res.status(404).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Session not found" },
          id: req.body?.id ?? null,
        });
        return;
      }
      touchSession(sessionId);
      await transport.handlePostMessage(req, res, req.body);
    });
  }

  // Return cleanup function for graceful shutdown
  return () => {
    if (cleanupTimer) clearInterval(cleanupTimer);
    for (const [id, transport] of streamableSessions) {
      try { transport.close(); } catch {}
      streamableSessions.delete(id);
      sessionScope.delete(id);
      activeSessionCount = Math.max(0, activeSessionCount - 1);
    }
    for (const [id, transport] of sseSessions) {
      try { transport.close(); } catch {}
      sseSessions.delete(id);
      activeSessionCount = Math.max(0, activeSessionCount - 1);
    }
  };
}
