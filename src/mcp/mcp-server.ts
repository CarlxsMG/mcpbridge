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
import { isBundleEnabled, getBundleToolKeys, getBundleComposites } from "../admin/tool-composition/bundles.js";
import { config } from "../config.js";
import { SEARCH_TOOL_NAME, searchToolDefinition, runSearchTool, type AdvertisedTool } from "./tool-search.js";
import { hasComposite, getAdvertisedComposite, runComposite } from "../admin/tool-composition/composites.js";
import { resolveSystemRole } from "../security/system-role.js";
import { listSystemTools, runSystemTool } from "./system-tools.js";
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
 * There is no "aggregated, every backend tool flattened" scope any more —
 * that's what /mcp/:clientName (single client) and /mcp-custom/:bundleName
 * (curated cross-client) are for. `"system"` is the /mcp root itself:
 * gateway management + data retrieval (src/mcp/system-tools.ts), never
 * backend tools — see docs/guide/architecture.md for the full split.
 */
export type McpServerScope = { kind: "client"; name: string } | { kind: "bundle"; name: string } | { kind: "system" };

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

type RequestHeaders = Record<string, unknown> | undefined;

/** Reads the raw per-request headers a handler's `extra` carries — the one place every scope reads them from. */
function extraHeaders(extra: { requestInfo?: { headers?: Record<string, unknown> } }): RequestHeaders {
  return extra.requestInfo?.headers;
}

/** Pulls the caller's bearer token out of a request handler's `extra.requestInfo.headers`. */
function callerTokenFromExtra(extra: { requestInfo?: { headers?: Record<string, unknown> } }): string | undefined {
  return extractBearerFromHeader(extraHeaders(extra)?.authorization);
}

/**
 * The tools a session can see for its scope — the single source shared by
 * tools/list and search_tools. For "system" this is role-filtered from
 * `callerToken`, resolved fresh on every call (never cached at session
 * creation), the same "never trust a stale grant" posture proxy.ts already
 * applies to isToolInKeyScope.
 */
function scopedToolList(scope: McpServerScope, callerToken?: string): AdvertisedTool[] {
  if (scope.kind === "client") return registry.getMcpToolsForClient(scope.name);
  if (scope.kind === "bundle") {
    if (!isBundleEnabled(scope.name)) return [];
    const keys = getBundleToolKeys(scope.name);
    const tools = keys ? registry.getMcpToolsForKeys(keys) : [];
    for (const compositeName of getBundleComposites(scope.name) ?? []) {
      const def = getAdvertisedComposite(compositeName);
      if (def) tools.push(def);
    }
    return tools;
  }
  const auth = resolveSystemRole(callerToken);
  return auth ? listSystemTools(auth.role) : [];
}

/**
 * McpConnParams for a client-scoped MCP upstream, or null when the scope isn't a
 * single live MCP-kind client. Resources/prompts are passthrough only for a
 * sharded /mcp/:clientName session pointed at an MCP upstream — bundle/system
 * scopes stay tools-only (cross-client resource-URI namespacing is a later design).
 */
function mcpParamsForScope(scope: McpServerScope): McpConnParams | null {
  if (scope.kind !== "client") return null;
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
 * Creates an MCP server instance bound to exactly one scope: a single
 * registered client (sharded /mcp/:clientName), a single admin-curated
 * bundle (/mcp-custom/:bundleName), or the system control-plane (/mcp root).
 * Client/bundle scope resolution is a pure narrowing filter in front of the
 * unchanged proxyToolCall() authorization chain (guards, circuit breaker,
 * SSRF-safe fetch) — never a bypass. System-scope calls never reach
 * proxyToolCall at all; they dispatch through runSystemTool()'s own
 * role/step-up gate instead (see system-tools.ts).
 */
export function createMcpServer(scope: McpServerScope): Server {
  const server = new Server(
    { name: "mcp-rest-bridge", version: pkg.version },
    { capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    const callerToken = callerTokenFromExtra(extra);
    const tools = scopedToolList(scope, callerToken);
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
    const callerToken = callerTokenFromExtra(extra);

    // The discovery meta-tool is handled directly (never enters proxyToolCall)
    // and ranks only over the caller's current scope.
    if (config.enableSearchTool && name === SEARCH_TOOL_NAME) {
      return runSearchTool((args ?? {}) as Record<string, unknown>, scopedToolList(scope, callerToken));
    }

    if (scope.kind === "system") {
      // Deliberately resolve auth BEFORE looking at `name` at all: a caller
      // with no system role gets the exact same "no system role" error
      // whether `name` is a real sys_* tool or complete garbage. Checking
      // tool-name existence first (and only then falling back to this
      // message) would let an unauthenticated/under-privileged caller
      // distinguish "tool exists but I lack permission" from "tool doesn't
      // exist" — an enumeration oracle for the sys_* tool surface. Once a
      // role IS resolved, runSystemTool()'s own lookup below reports
      // "Unknown tool: <name>" for a bad name, same as any other scope.
      const auth = resolveSystemRole(callerToken);
      if (!auth) {
        return { isError: true, content: [{ type: "text", text: "This credential has no system role" }] };
      }
      return runSystemTool(name, (args ?? {}) as Record<string, unknown>, auth);
    }

    if (scope.kind === "client") {
      // Exact membership, not a name-prefix test: a `startsWith` check would
      // wrongly admit a *different* client whose name happens to extend this
      // one across the `__` separator (e.g. scope "acme" and an unrelated,
      // independently-registered client "acme__evil" both satisfy
      // `name.startsWith("acme__")`) — the same confused-deputy class the
      // bundle branch below already closes via exact Set membership.
      const resolved = registry.resolveTool(name);
      if (!resolved || resolved.client.name !== scope.name) {
        return {
          isError: true,
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
        };
      }
    }

    if (scope.kind === "bundle") {
      const keys = getBundleToolKeys(scope.name);
      const isBundleComposite = hasComposite(name) && (getBundleComposites(scope.name)?.has(name) ?? false);
      if (!isBundleEnabled(scope.name) || (!keys?.has(name) && !isBundleComposite)) {
        return {
          isError: true,
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
        };
      }
      // Composite (macro) dispatch — each step runs through proxyToolCall
      // under the caller's own token, so the full guard stack applies per
      // step exactly as if the caller had invoked it directly. A composite
      // therefore grants no new capability beyond what the caller's
      // credential already has; it only orchestrates.
      if (isBundleComposite) {
        return runComposite(name, (args ?? {}) as Record<string, unknown>, callerToken);
      }
    }

    const endUserId = extractEndUserId(extraHeaders(extra)?.["x-end-user-id"]);

    // Progress/cancellation bridging (MCP-to-MCP upstreams only — a no-op for
    // REST/WS-backed tools, which never read `onProgress`). `signal` is
    // auto-aborted by the SDK when this caller sends notifications/cancelled;
    // `onProgress` is only wired up when the caller itself asked for progress
    // (a _meta.progressToken on its own call) — never invented on its behalf.
    const progressToken = extra._meta?.progressToken;
    const onProgress =
      progressToken !== undefined
        ? (progress: number, total?: number, message?: string) => {
            // Best-effort: if the caller disconnected mid-call the transport is
            // closed and the send rejects — swallow it rather than surface an
            // unhandled rejection (same discipline as notifyToolsChanged).
            void extra
              .sendNotification({
                method: "notifications/progress",
                params: { progressToken, progress, total, message },
              })
              .catch(() => {});
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
    // server.notification is async — a synchronous try/catch cannot catch its
    // rejection (e.g. a target session whose transport closed mid-stream after
    // the client disconnected). Swallow it explicitly so it never escapes as an
    // unhandled rejection, matching the onProgress sendNotification discipline
    // in the tool-call handler above.
    void server.notification({ method: "notifications/tools/list_changed" }).catch(() => {});
  }
}
