/** Canonical status values for a registered client. */
export type ClientStatus = "healthy" | "degraded" | "unreachable";

/** Upstream kind: a REST backend (bridged via HTTP) or a native MCP server proxied through this bridge. */
export type UpstreamKind = "rest" | "mcp";

/** Transport used to reach an MCP-kind upstream. */
export type McpTransport = "streamable-http" | "sse";

export interface RegistrationPayload {
  name: string;
  health_url: string;
  base_url?: string;
  // Manual mode
  tools?: RestToolDefinition[];
  // OpenAPI auto-discovery mode
  openapi_url?: string;
  include_tags?: string[];
  exclude_operations?: string[];
}

export interface RestToolDefinition {
  name: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  endpoint: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Per-tool admin-configurable overrides. All fields optional — absent means "use the global default". */
export interface ToolGuardConfig {
  rateLimitPerMin?: number;
  timeoutMs?: number;
  /** SHA-256 hex digests of the mcpApiKeys allowed to call this tool. Absent/empty = no restriction. */
  allowedKeyHashes?: string[];
  extra?: Record<string, unknown>;
}

/** Per-client admin-configurable overrides. */
export interface ClientGuardConfig {
  circuitBreaker?: Partial<{
    failureThreshold: number;
    resetTimeoutMs: number;
    halfOpenTimeoutMs: number;
    windowMs: number;
  }>;
  extra?: Record<string, unknown>;
}

/**
 * Admin-authored presentation overrides applied to what tools/list advertises,
 * without mutating the upstream-registered definition. Improves LLM tool
 * selection (better descriptions) without a re-registration.
 */
export interface ToolOverride {
  /** Replacement tool description. Absent = use the registered description. */
  description?: string;
  /** Per-parameter description overrides, keyed by property name. */
  params?: Record<string, { description?: string }>;
  /**
   * Replacement for the *tool segment* of the advertised MCP name, so the tool
   * is exposed as `clientName__displayName` instead of `clientName__toolName`.
   * The `clientName__` prefix is always preserved (keeps the sharded-scope and
   * bundle-membership invariants intact and prevents cross-client collisions),
   * so this cleans up ugly upstream tool names without changing which client a
   * tool belongs to. Must match /^[a-z0-9][a-z0-9_-]{0,62}$/. The original
   * canonical name stays callable as a backstop for stale client caches.
   */
  displayName?: string;
}

/** Per-tool content guardrails (input deny/secret gate + response injection scan). */
export interface ToolGuardrails {
  /** Admin regex deny-list. A call whose JSON-serialized args match any pattern is rejected. */
  denyPatterns: string[];
  /** When true, reject a call whose args appear to contain a high-signal secret. */
  blockSecrets: boolean;
  /** When true, scan the tool's response for prompt-injection and wrap flagged output. */
  scanResponses: boolean;
}

/** A tool as tracked internally by the registry — adds admin state on top of the wire shape. */
export interface RegisteredTool extends RestToolDefinition {
  enabled: boolean;
  guards?: ToolGuardConfig;
  override?: ToolOverride;
  /** Admin-assigned organizational tags (populated on read, not stored on the tool row). */
  tags?: string[];
  /** Explicit destructive-gating flag (populated on read): true/false when set by an admin, null = use the auto-gate default. */
  sensitive?: boolean | null;
  /** Response redaction dot-paths (populated on read). */
  redactPaths?: string[];
  /** Content guardrails (populated on read): input deny/secret gate + response scan. */
  guardrails?: ToolGuardrails;
  /** Raw upstream MCP tool name used for dispatch (only when the client is kind "mcp"). Absent for REST tools. */
  upstreamName?: string;
}

export interface RegisteredClient {
  name: string;
  ip: string;
  tools: RegisteredTool[];
  health_url: string;
  base_url: string;
  resolved_ip: string;
  status: ClientStatus;
  consecutive_failures: number;
  /** When true, DELETE and PUT are retried on failure (same as GET/HEAD/OPTIONS). Default: false. */
  retry_non_safe_methods?: boolean;
  /** Admin-controlled kill switch — disabled clients are excluded from tools/list and rejected in proxyToolCall. */
  enabled: boolean;
  guards?: ClientGuardConfig;
  /** Upstream kind: "rest" (default) or a native MCP server proxied through this bridge. */
  kind: UpstreamKind;
  /** MCP upstream endpoint URL (only when kind === "mcp"). */
  mcpUrl?: string;
  /** MCP upstream transport (only when kind === "mcp"). */
  mcpTransport?: McpTransport;
}

export interface ResolvedTool {
  client: RegisteredClient;
  tool: RegisteredTool;
}
