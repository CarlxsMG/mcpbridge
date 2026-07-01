import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "module";
import { registry } from "./registry.js";
import { proxyToolCall } from "./proxy.js";
import { isBundleEnabled, getBundleToolKeys } from "./bundles.js";
import { config } from "./config.js";
import { SEARCH_TOOL_NAME, searchToolDefinition, runSearchTool, type AdvertisedTool } from "./tool-search.js";

const _require = createRequire(import.meta.url);
const pkg = _require("../package.json") as { version: string };

const activeServers = new Set<Server>();

/**
 * Which subset of the registry a server instance's session can see and call.
 * Undefined (the aggregated /mcp endpoint) means every enabled client's
 * tools flattened together — the legacy behaviour.
 */
export type McpServerScope = { kind: "client"; name: string } | { kind: "bundle"; name: string };

/** The tools a session can see for its scope — the single source shared by tools/list and search_tools. */
function scopedToolList(scope?: McpServerScope): AdvertisedTool[] {
  if (scope?.kind === "client") return registry.getMcpToolsForClient(scope.name);
  if (scope?.kind === "bundle") {
    if (!isBundleEnabled(scope.name)) return [];
    const keys = getBundleToolKeys(scope.name);
    return keys ? registry.getMcpToolsForKeys(keys) : [];
  }
  return registry.getAllMcpTools();
}

/** Extracts a bearer token from a raw (possibly multi-value) Authorization header value. */
function extractBearerFromHeader(value: unknown): string | undefined {
  const header = Array.isArray(value) ? value[0] : value;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return undefined;
  return header.slice(7).trim();
}

/**
 * Creates an MCP server instance. When `scope` is set, the server is bound
 * to a single registered client (sharded /mcp/:clientName) or a single
 * admin-curated bundle (/mcp-custom/:bundleName) — a session only ever sees
 * (and can call) that scope's tools. Bundle-scope resolution is a pure
 * narrowing filter in front of the unchanged proxyToolCall() authorization
 * chain (guards, circuit breaker, SSRF-safe fetch) — never a bypass.
 */
export function createMcpServer(scope?: McpServerScope): Server {
  const server = new Server(
    { name: "mcp-rest-bridge", version: pkg.version },
    { capabilities: { tools: { listChanged: true } } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = scopedToolList(scope);
    // Advertise the discovery meta-tool alongside the real tools (only when
    // there is something to search).
    if (config.enableSearchTool && tools.length > 0) tools.push(searchToolDefinition());
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name: advertisedName, arguments: args } = request.params;
    // Translate a display-name alias to its canonical clientName__toolName up
    // front, so every downstream check (scope prefix, bundle membership,
    // proxyToolCall) operates on the canonical identity. A non-alias name is
    // returned unchanged.
    const name = registry.resolveAdvertisedName(advertisedName);

    // The discovery meta-tool is handled directly (never enters proxyToolCall)
    // and ranks only over the caller's current scope.
    if (config.enableSearchTool && name === SEARCH_TOOL_NAME) {
      return runSearchTool((args ?? {}) as Record<string, unknown>, scopedToolList(scope));
    }

    if (scope?.kind === "client" && !name.startsWith(`${scope.name}__`)) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
    }

    if (scope?.kind === "bundle") {
      const keys = getBundleToolKeys(scope.name);
      if (!isBundleEnabled(scope.name) || !keys?.has(name)) {
        return {
          isError: true,
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
        };
      }
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
