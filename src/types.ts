/** Canonical status values for a registered client. */
export type ClientStatus = "healthy" | "degraded" | "unreachable";

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
}

/** A tool as tracked internally by the registry — adds admin state on top of the wire shape. */
export interface RegisteredTool extends RestToolDefinition {
  enabled: boolean;
  guards?: ToolGuardConfig;
  override?: ToolOverride;
  /** Admin-assigned organizational tags (populated on read, not stored on the tool row). */
  tags?: string[];
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
}

export interface ResolvedTool {
  client: RegisteredClient;
  tool: RegisteredTool;
}
