import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  type ListResourcesResult,
  type ReadResourceResult,
  type ListPromptsResult,
  type GetPromptResult,
} from "@modelcontextprotocol/sdk/types.js";
import { registry } from "./registry.js";
import { proxyToolCall } from "../proxy/proxy.js";
import { mcpUpstream, type McpConnParams } from "./mcp-upstream.js";
import { getUpstreamAuthHeaders } from "../backend-auth/upstream-auth.js";
import { isBundleEnabled, getBundleToolKeys } from "../admin/tool-composition/bundles.js";
import { config } from "../config.js";
import { SEARCH_TOOL_NAME, searchToolDefinition, runSearchTool, type AdvertisedTool } from "./tool-search.js";
import { hasComposite, listAdvertisedComposites, runComposite } from "../admin/tool-composition/composites.js";
// Bun parses JSON modules at bundle time (like YAML — see docs.ts), so this
// works identically under `bun src/index.ts` and under `bun build --compile`.
// The previous `createRequire(import.meta.url)("../package.json")` approach
// broke in standalone-executable mode: a dynamic require of a path outside
// the bundle graph resolves against the synthetic $bunfs root there, not a
// real on-disk directory, so it always threw "Cannot find module" and
// crashed startup before the server could listen.
import pkg from "../../package.json";

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

/** Extracts a raw (possibly multi-value) X-End-User-Id header value as a plain string. */
function extractEndUserId(value: unknown): string | undefined {
  const header = Array.isArray(value) ? value[0] : value;
  return typeof header === "string" ? header : undefined;
}

/**
 * McpConnParams for a client-scoped MCP upstream, or null when the scope isn't a
 * single live MCP-kind client. Resources/prompts are passthrough only for a
 * sharded /mcp/:clientName session pointed at an MCP upstream — aggregated/bundle
 * scopes stay tools-only (cross-client resource-URI namespacing is a later design).
 */
function mcpParamsForScope(scope?: McpServerScope): McpConnParams | null {
  if (scope?.kind !== "client") return null;
  const client = registry.listClients().find((c) => c.name === scope.name);
  if (!client || client.kind !== "mcp" || !client.enabled) return null;
  return {
    name: client.name,
    url: client.mcpUrl ?? client.base_url,
    transport: client.mcpTransport ?? "streamable-http",
    resolvedIp: client.resolved_ip,
    authHeaders: getUpstreamAuthHeaders(client.name) ?? undefined,
  };
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
    { capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = scopedToolList(scope);
    // Composite (macro) tools are aggregated-only in v1.
    if (!scope) tools.push(...listAdvertisedComposites());
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

    const requestHeaders = (extra as { requestInfo?: { headers?: Record<string, unknown> } } | undefined)?.requestInfo
      ?.headers;
    const callerToken = extractBearerFromHeader(requestHeaders?.authorization);
    const endUserId = extractEndUserId(requestHeaders?.["x-end-user-id"]);

    // Composite (macro) dispatch — aggregated scope only. A composite name never
    // matches a sharded/bundle scope check above, so this is unreachable for
    // scoped sessions. Each step runs through proxyToolCall under the caller's
    // token, so the full guard stack applies per step (no privilege escalation).
    if (!scope && hasComposite(name)) {
      return runComposite(name, (args ?? {}) as Record<string, unknown>, callerToken);
    }

    // Progress/cancellation bridging (MCP-to-MCP upstreams only — a no-op for
    // REST/WS-backed tools, which never read `onProgress`). `signal` is
    // auto-aborted by the SDK when this caller sends notifications/cancelled;
    // `onProgress` is only wired up when the caller itself asked for progress
    // (a _meta.progressToken on its own call) — never invented on its behalf.
    const progressToken = extra._meta?.progressToken;
    const onProgress =
      progressToken !== undefined
        ? (progress: number, total?: number, message?: string) => {
            void extra.sendNotification({
              method: "notifications/progress",
              params: { progressToken, progress, total, message },
            });
          }
        : undefined;

    return proxyToolCall(name, args ?? {}, callerToken, {
      signal: extra.signal,
      onProgress,
      endUserId,
      sessionId: extra.sessionId,
    });
  });

  // Resources & prompts — passthrough for a client-scoped MCP upstream; empty /
  // not-found otherwise. The upstream's own capabilities decide what's returned
  // (listResources/listPrompts degrade to [] when the upstream lacks them).
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const p = mcpParamsForScope(scope);
    return { resources: p ? await mcpUpstream.listResources(p, config.toolCallTimeoutMs) : [] } as ListResourcesResult;
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const p = mcpParamsForScope(scope);
    if (!p) throw new Error(`Resource not available: ${request.params.uri}`);
    return (await mcpUpstream.readResource(p, request.params.uri, config.toolCallTimeoutMs)) as ReadResourceResult;
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const p = mcpParamsForScope(scope);
    return { prompts: p ? await mcpUpstream.listPrompts(p, config.toolCallTimeoutMs) : [] } as ListPromptsResult;
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const p = mcpParamsForScope(scope);
    if (!p) throw new Error(`Prompt not available: ${request.params.name}`);
    const args = (request.params.arguments ?? {}) as Record<string, string>;
    return (await mcpUpstream.getPrompt(p, request.params.name, args, config.toolCallTimeoutMs)) as GetPromptResult;
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
