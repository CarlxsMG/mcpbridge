// Hand-mirrored shapes of the backend's /admin-api/* JSON responses.
// Keep in sync with src/registry.ts (ClientSummary/ClientDetail), src/types.ts
// (ToolGuardConfig/ClientGuardConfig), and src/admin/audit.ts (AuditLogEntry).

export type ClientStatus = "healthy" | "degraded" | "unreachable";
export type AdminRole = "admin" | "viewer";
export type CircuitBreakerState = "closed" | "open" | "half_open";

export interface ClientSummary {
  name: string;
  enabled: boolean;
  live: boolean;
  status: ClientStatus | null;
  toolsCount: number;
  healthUrl: string;
  baseUrl: string;
}

export interface ToolGuardConfig {
  rateLimitPerMin?: number;
  timeoutMs?: number;
  allowedKeyHashes?: string[];
}

export interface ClientGuardConfig {
  circuitBreaker?: {
    failureThreshold?: number;
    resetTimeoutMs?: number;
    halfOpenTimeoutMs?: number;
    windowMs?: number;
  };
}

export interface ToolOverride {
  description?: string;
  params?: Record<string, { description?: string }>;
}

export interface ToolDetail {
  name: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  endpoint: string;
  description: string;
  inputSchema: Record<string, unknown>;
  enabled: boolean;
  guards?: ToolGuardConfig;
  override?: ToolOverride;
  tags?: string[];
}

export interface ClientDetail {
  name: string;
  enabled: boolean;
  live: boolean;
  status: ClientStatus | null;
  ip: string | null;
  healthUrl: string;
  baseUrl: string;
  resolvedIp: string | null;
  retryNonSafeMethods: boolean;
  consecutiveFailures: number | null;
  guards?: ClientGuardConfig;
  circuitBreakerState: CircuitBreakerState | null;
  tools: ToolDetail[];
}

export interface PaginatedResult<T> {
  items: T[];
  nextCursor?: string;
}

export interface AdminUserSummary {
  username: string;
  role: AdminRole;
  is_active: boolean;
  created_at: number;
  last_login_at: number | null;
}

export interface AuditLogEntry {
  id: number;
  actor: string;
  action: string;
  target: string;
  detail: Record<string, unknown> | null;
  createdAt: number;
}

export interface OverviewStats {
  clients: { live: number; disabled: number; healthy: number; degraded: number; unreachable: number };
  tools: { total: number; disabled: number };
  circuit_breakers: { open: number; half_open: number };
  admin_users: number;
}

export interface CurrentUser {
  authenticated: true;
  auth_method: "bearer" | "session";
  user?: { username: string; role: AdminRole };
}

export interface BundleToolRef {
  client: string;
  tool: string;
}

export interface BundleSummary {
  name: string;
  description: string | null;
  enabled: boolean;
  toolsCount: number;
}

export interface BundleDetail {
  name: string;
  description: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  tools: BundleToolRef[];
}

/** One row of GET /admin-api/tools — the flat cross-client listing that powers the bundle tool picker. */
export interface ToolListItem {
  client: string;
  tool: string;
  description: string;
  enabled: boolean;
  clientEnabled: boolean;
  tags: string[];
}

export interface ApiErrorBody {
  error: { code: string; message: string; request_id?: string | null };
}

export interface McpKeyScopes {
  clients?: string[];
  tools?: string[];
}

/** GET /admin-api/mcp-keys item — never carries the raw secret. */
export interface McpApiKey {
  id: number;
  label: string;
  keyPrefix: string;
  scopes: McpKeyScopes | null;
  enabled: boolean;
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
  createdBy: string | null;
}

/** POST /admin-api/mcp-keys response — the raw `key` is returned exactly once. */
export interface McpApiKeyWithSecret extends McpApiKey {
  key: string;
}

/** GET /admin-api/clients/:name/upstream-auth — non-secret view of the upstream credential. */
export interface UpstreamAuthInfo {
  configured: boolean;
  type?: "bearer" | "basic" | "header";
  headerName?: string | null;
  updatedAt?: number;
}

export interface DiscoveredTool {
  name: string;
  method: string;
  endpoint: string;
  description: string;
}

/** POST /admin-api/discovery/preview response. */
export interface DiscoveryPreview {
  count: number;
  tools: DiscoveredTool[];
}

export interface UsageSummary {
  from: number;
  calls: number;
  errors: number;
  errorRate: number;
  avgMs: number;
  maxMs: number;
  tools: number;
  keys: number;
}

export interface TopToolRow {
  client: string;
  tool: string;
  calls: number;
  errors: number;
  errorRate: number;
  avgMs: number;
  maxMs: number;
}

export interface UsageByKeyRow {
  keyId: number | null;
  label: string;
  calls: number;
  errors: number;
}

export interface GuardPolicy {
  id: number;
  name: string;
  rateLimitPerMin: number | null;
  timeoutMs: number | null;
  createdAt: number;
  updatedAt: number;
  createdBy: string | null;
}

export interface ConfigImportResult {
  dryRun: boolean;
  applied: { bundles: number; alertRules: number; clientsConfigured: number; toolsConfigured: number };
  skipped: { type: string; id: string; reason: string }[];
}

export type AlertEventType = "circuit_breaker_open" | "client_unreachable" | "error_rate";

export interface AlertRule {
  id: number;
  name: string;
  eventType: AlertEventType;
  enabled: boolean;
  webhookUrl: string;
  threshold: number | null;
  minCalls: number | null;
  lastFiredAt: number | null;
  createdAt: number;
  updatedAt: number;
  createdBy: string | null;
}
