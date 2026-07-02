// Hand-mirrored shapes of the backend's /admin-api/* JSON responses.
// Keep in sync with src/registry.ts (ClientSummary/ClientDetail), src/types.ts
// (ToolGuardConfig/ClientGuardConfig), and src/admin/audit.ts (AuditLogEntry).

export type ClientStatus = "healthy" | "degraded" | "unreachable";
export type AdminRole = "admin" | "operator" | "auditor" | "viewer";
export type CircuitBreakerState = "closed" | "open" | "half_open";
export type UpstreamKind = "rest" | "mcp";
export type McpTransport = "streamable-http" | "sse";

export interface ClientSummary {
  name: string;
  enabled: boolean;
  live: boolean;
  status: ClientStatus | null;
  toolsCount: number;
  healthUrl: string;
  baseUrl: string;
  kind: UpstreamKind;
  teamId: number | null;
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
  /** Renames the advertised tool to clientName__displayName. Must match /^[a-z0-9][a-z0-9_-]{0,62}$/. */
  displayName?: string;
}

export interface ToolGuardrails {
  denyPatterns: string[];
  blockSecrets: boolean;
  scanResponses: boolean;
}

export interface ToolDetail {
  name: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  endpoint: string;
  /** Raw upstream tool name for MCP-kind clients (the dispatch target). */
  upstreamName?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  enabled: boolean;
  guards?: ToolGuardConfig;
  override?: ToolOverride;
  tags?: string[];
  sensitive?: boolean | null;
  redactPaths?: string[];
  guardrails?: ToolGuardrails;
  coalesce?: { enabled: boolean };
  approval?: { required: boolean; requiredLevels: number };
  quarantine?: {
    policy: { consecutiveThreshold: number; action: "block" | "force_approval" | "observe"; recoveryMode: "auto" | "manual"; cooldownMs: number | null };
    state: { quarantined: boolean; consecutiveHits: number; quarantinedAt: number | null; reason: string | null; cooldownUntil: number | null };
  };
  ws?: { enabled: boolean; wsUrl: string; persistent: boolean };
  graphql?: { enabled: boolean; query: string };
}

export interface TraceSummary {
  traceId: string;
  spanCount: number;
  startMs: number;
  endMs: number;
  mcpToolName: string | null;
  hasError: boolean;
}

export interface StoredSpan {
  id: number;
  traceId: string;
  spanId: string;
  name: string;
  mcpToolName: string | null;
  startMs: number;
  endMs: number;
  statusCode: number;
  attributes: Record<string, unknown>;
  createdAt: number;
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
  kind: UpstreamKind;
  mcpUrl: string | null;
  mcpTransport: string | null;
  teamId: number | null;
  tools: ToolDetail[];
}

export interface CompositeStep {
  targetClient: string;
  targetTool: string;
  argsTemplate: Record<string, unknown>;
}

export interface CompositeSummary {
  name: string;
  description: string | null;
  enabled: boolean;
  stepsCount: number;
}

export interface CompositeDetail {
  name: string;
  description: string | null;
  enabled: boolean;
  inputSchema: Record<string, unknown>;
  steps: CompositeStep[];
  createdAt: number;
  updatedAt: number;
}

export interface ConfigSnapshotSummary {
  id: number;
  label: string;
  createdAt: number;
  createdBy: string | null;
}

export interface ConfigDiffEntry {
  path: string;
  kind: "added" | "removed" | "changed";
  before: unknown;
  after: unknown;
}

export interface ConfigDiffResult {
  from: ConfigSnapshotSummary;
  to: string;
  entries: ConfigDiffEntry[];
}

export interface Team {
  id: number;
  name: string;
  createdAt: number;
  createdBy: string | null;
}

export interface CanaryConfig {
  secondaryBaseUrl: string;
  secondaryResolvedIp: string;
  mode: "canary" | "failover";
  weight: number;
  enabled: boolean;
}

export interface Schedule {
  id: number;
  targetType: "client" | "tool";
  clientName: string;
  toolName: string | null;
  action: "enable" | "disable";
  cron: string;
  enabled: boolean;
  lastRunMinute: number | null;
  createdAt: number;
  createdBy: string | null;
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
  hash?: string | null;
}

export interface OverviewStats {
  clients: { live: number; disabled: number; healthy: number; degraded: number; unreachable: number };
  tools: { total: number; disabled: number };
  circuit_breakers: { open: number; half_open: number; closed: number };
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

/** GET /admin-api/ws-proxy-targets item — a live WebSocket passthrough target (see src/ws-proxy.ts). */
export interface WsProxyTarget {
  name: string;
  backendWsUrl: string;
  resolvedIp: string;
  maxConnections: number;
  maxMessageBytes: number;
  idleTimeoutMs: number;
  enabled: boolean;
  activeConnections: number;
  createdAt: number;
  updatedAt: number;
}

/** GET /admin-api/catalog item — merges the static builtin gallery with admin-authored custom entries. */
export interface CatalogEntry {
  id: string; // "builtin:<slug>" or "custom:<row id>"
  source: "builtin" | "custom";
  slug: string;
  name: string;
  description: string | null;
  kind: "rest" | "mcp";
  category: string | null;
  tags: string[];
  icon: string | null;
  openapiUrl?: string | null;
  healthUrl?: string | null;
  baseUrl?: string | null;
  includeTags?: string[] | null;
  excludeOperations?: string[] | null;
  mcpUrl?: string | null;
  mcpTransport?: "streamable-http" | "sse" | null;
  featured: boolean;
}

export interface McpKeyScopes {
  clients?: string[];
  tools?: string[];
}

export interface Consumer {
  id: number;
  name: string;
  monthlyQuota: number | null;
  endUserRateLimitPerMin: number | null;
  createdAt: number;
  updatedAt: number;
  createdBy: string | null;
}

export interface ConsumerWithUsage extends Consumer {
  usedThisMonth: number;
}

/** GET /admin-api/mcp-keys item — never carries the raw secret. */
export interface McpApiKey {
  id: number;
  label: string;
  keyPrefix: string;
  consumerId: number | null;
  elevated: boolean;
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

export interface UsageTimeseriesPoint {
  t: number;
  calls: number;
  errors: number;
  avgMs: number;
}

export interface UsageTimeseries {
  bucketMs: number;
  points: UsageTimeseriesPoint[];
}

/** GET /admin-api/traffic item — only populated when TRAFFIC_CAPTURE=true is set on the server. */
export interface TrafficRecord {
  id: number;
  mcpToolName: string;
  clientName: string | null;
  toolName: string | null;
  keyId: number | null;
  argsJson: string;
  preview: string;
  isError: boolean;
  durationMs: number;
  createdAt: number;
}

export type MonitorStatus = "ok" | "fail";

/** GET /admin-api/monitors item — status and drift are independent axes, not a combined tri-state. */
export interface MonitorRecord {
  clientName: string;
  toolName: string;
  exampleId: number;
  intervalMinutes: number;
  enabled: boolean;
  driftDetected: boolean;
  lastStatus: MonitorStatus | null;
  lastError: string | null;
  lastCheckedAt: number | null;
}

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface ApprovalDecision {
  id: number;
  approvalId: number;
  decidedBy: string;
  decision: "approved" | "rejected";
  note: string | null;
  decidedAt: number;
}

export interface ApprovalRecord {
  id: number;
  clientName: string;
  toolName: string;
  argsHash: string;
  argsJson: string;
  status: ApprovalStatus;
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  note: string | null;
  consumedAt: number | null;
  requestedBy: number | null;
  requiredLevels: number;
  decisions: ApprovalDecision[];
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
  applied: { bundles: number; alertRules: number; clientsConfigured: number; toolsConfigured: number; guardrails: number; consumers: number };
  skipped: { type: string; id: string; reason: string }[];
}

export type AlertEventType = "circuit_breaker_open" | "client_unreachable" | "error_rate" | "usage_spike" | "schema_drift";

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
