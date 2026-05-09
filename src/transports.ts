import type { Express } from "express";
import { randomUUID } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpServer } from "./mcp-server.js";
import { originValidator } from "./middleware/origin-validator.js";
import { mcpAuth } from "./middleware/auth.js";
import { rateLimitMcp } from "./middleware/rate-limiter.js";
import { config } from "./config.js";
import { setSessionCountGetter } from "./routes/metrics.js";
import { log } from "./logger.js";

// Session maps
const streamableSessions = new Map<string, StreamableHTTPServerTransport>();
const sseSessions = new Map<string, SSEServerTransport>();

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
        }
        const sse = sseSessions.get(id);
        if (sse) {
          try { sse.close(); } catch {}
          sseSessions.delete(id);
        }
        sessionActivity.delete(id);
      }
    }
  }, 60_000);
}

export function setupTransports(app: Express): () => void {
  startSessionCleanup();
  setSessionCountGetter(() => ({
    streamable: streamableSessions.size,
    sse: sseSessions.size,
  }));

  // ============================================
  // Streamable HTTP transport (primary)
  // Single endpoint: /mcp (POST + GET + DELETE)
  // ============================================

  // Origin validation for MCP endpoints (required by MCP spec 2025-06-18)
  app.use("/mcp", originValidator);
  app.use("/mcp", mcpAuth);
  app.use("/mcp", rateLimitMcp(config.rateLimitMcp));

  app.post("/mcp", async (req, res) => {
    let transport: StreamableHTTPServerTransport | undefined;
    let transportInserted = false;
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    try {
      if (sessionId && streamableSessions.has(sessionId)) {
        // Existing session
        const existingTransport = streamableSessions.get(sessionId)!;
        await existingTransport.handleRequest(req, res, req.body);
        touchSession(sessionId);
      } else if (!sessionId) {
        // Max sessions cap
        const totalSessions = streamableSessions.size + sseSessions.size;
        if (totalSessions >= config.maxSessions) {
          res.status(503).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Server at capacity, retry later" },
            id: req.body?.id ?? null,
          });
          return;
        }

        // New session — Initialize request
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });

        // When the transport closes, remove it from the map
        transport.onclose = () => {
          for (const [id, t] of streamableSessions) {
            if (t === transport) {
              streamableSessions.delete(id);
              break;
            }
          }
        };

        const server = createMcpServer();
        await server.connect(transport);

        // The session ID is set after handling the initialize request
        await transport.handleRequest(req, res, req.body);

        // Store session after handling (sessionId is now set)
        if (transport.sessionId) {
          streamableSessions.set(transport.sessionId, transport);
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
      log("error", "POST /mcp failed", { sessionId, err });
      if (transport && !transportInserted) {
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
  });

  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string;
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
  });

  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string;
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
  });

  // ============================================
  // Legacy SSE transport (fallback)
  // Two endpoints: GET /sse + POST /messages
  // ============================================

  app.get("/sse", originValidator, mcpAuth, rateLimitMcp(config.rateLimitMcp), async (req, res) => {
    const totalSessions = streamableSessions.size + sseSessions.size;
    if (totalSessions >= config.maxSessions) {
      res.status(503).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Server at capacity, retry later" },
        id: null,
      });
      return;
    }

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
          try { server?.close(); } catch {}
          try { transport!.close(); } catch {}
        }
      }, 15_000);

      req.on("close", () => {
        clearInterval(heartbeatInterval);
        sseSessions.delete(transport!.sessionId);
        sessionActivity.delete(transport!.sessionId);
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
    const sessionId = req.query.sessionId as string;
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

  // Return cleanup function for graceful shutdown
  return () => {
    if (cleanupTimer) clearInterval(cleanupTimer);
    for (const [id, transport] of streamableSessions) {
      try { transport.close(); } catch {}
      streamableSessions.delete(id);
    }
    for (const [id, transport] of sseSessions) {
      try { transport.close(); } catch {}
      sseSessions.delete(id);
    }
  };
}
