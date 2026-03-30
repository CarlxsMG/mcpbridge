import type { Express } from "express";
import { randomUUID } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpServer } from "./mcp-server.js";

// Session maps
const streamableSessions = new Map<string, StreamableHTTPServerTransport>();
const sseSessions = new Map<string, SSEServerTransport>();

export function setupTransports(app: Express): void {
  // ============================================
  // Streamable HTTP transport (primary)
  // Single endpoint: /mcp (POST + GET + DELETE)
  // ============================================

  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && streamableSessions.has(sessionId)) {
      // Existing session
      const transport = streamableSessions.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
    } else if (!sessionId) {
      // New session — Initialize request
      const transport = new StreamableHTTPServerTransport({
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
      }
    } else {
      // Session ID provided but not found — expired
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Session not found or expired" },
        id: null,
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

  app.get("/sse", async (req, res) => {
    const transport = new SSEServerTransport("/messages", res);
    sseSessions.set(transport.sessionId, transport);

    req.on("close", () => {
      sseSessions.delete(transport.sessionId);
    });

    const server = createMcpServer();
    await server.connect(transport);
  });

  app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = sseSessions.get(sessionId);
    if (!transport) {
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Session not found" },
        id: null,
      });
      return;
    }
    await transport.handlePostMessage(req, res, req.body);
  });
}
