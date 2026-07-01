import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "module";
import { registry } from "./registry.js";
import { proxyToolCall } from "./proxy.js";

const _require = createRequire(import.meta.url);
const pkg = _require("../package.json") as { version: string };

const activeServers = new Set<Server>();

/** Extracts a bearer token from a raw (possibly multi-value) Authorization header value. */
function extractBearerFromHeader(value: unknown): string | undefined {
  const header = Array.isArray(value) ? value[0] : value;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return undefined;
  return header.slice(7).trim();
}

/**
 * Creates an MCP server instance. When `clientScope` is set, the server is
 * bound to a single registered client — used by the sharded /mcp/:clientName
 * endpoint so a session only ever sees (and can call) that one client's tools.
 */
export function createMcpServer(clientScope?: string): Server {
  const server = new Server(
    { name: "mcp-rest-bridge", version: pkg.version },
    { capabilities: { tools: { listChanged: true } } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: clientScope ? registry.getMcpToolsForClient(clientScope) : registry.getAllMcpTools() };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;

    if (clientScope && !name.startsWith(`${clientScope}__`)) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
    }

    const callerToken = extractBearerFromHeader(
      (extra as { requestInfo?: { headers?: Record<string, unknown> } } | undefined)?.requestInfo?.headers?.authorization
    );
    return proxyToolCall(name, args ?? {}, callerToken);
  });

  activeServers.add(server);

  server.onclose = () => {
    activeServers.delete(server);
  };

  return server;
}

export function notifyToolsChanged(): void {
  for (const server of activeServers) {
    try {
      server.notification({ method: "notifications/tools/list_changed" });
    } catch {
      // ignore failures for individual servers
    }
  }
}
