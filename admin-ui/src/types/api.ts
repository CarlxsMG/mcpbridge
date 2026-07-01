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

export interface ToolDetail {
  name: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  endpoint: string;
  description: string;
  inputSchema: Record<string, unknown>;
  enabled: boolean;
  guards?: ToolGuardConfig;
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

export interface ApiErrorBody {
  error: { code: string; message: string; request_id?: string | null };
}
