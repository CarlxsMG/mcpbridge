/**
 * RegistryPersistence — owns every SQLite interaction the registry does.
 *
 * Splitting this out of the live Registry class is the structural equivalent
 * of the AliasIndex / ToolIndex extractions: a god-class with N concerns
 * becomes an orchestrator + small dedicated modules. Persistence is by far
 * the largest single concern (~500 LOC of SQL + row-mapping), so it gets
 * its own file even though it still lives inside the same package.
 *
 * What lives here:
 *   - SQLite row shapes (ClientGuardRow / ToolGuardRow / ToolOverrideRow)
 *   - row-to-DTO converters (rowToClientGuards / rowToToolGuards / rowToToolOverride)
 *   - RegistryPersistence class with three methods:
 *       persistRestRegistration(): REST-kind register/refresh
 *       persistMcpRegistration():  MCP-kind register/refresh (mirror)
 *       buildPersistedClientFromDb(): read-only hydration from SQLite
 *
 * What does NOT live here:
 *   - The live in-memory `clients` map and its lifecycle.
 *   - Runtime-only fields (`status`, `consecutive_failures`) — those are
 *     combined by the caller with whatever the persistence layer returned,
 *     keeping the read path aware that adding/removing in-memory state is
 *     a Registry concern, not a Storage concern.
 *   - Locking — the caller (Registry) wraps mutating calls in `withLock`.
 */
import { getDb } from "../db/connection.js";
import type {
  ClientGuardConfig,
  ToolGuardConfig,
  ToolOverride,
  RegisteredTool,
  McpTransport,
  UpstreamKind,
} from "./types.js";
import type { RestToolDefinition } from "./types.js";
import type { DiscoveredMcpTool } from "./mcp-discovery.js";

export interface ClientGuardRow {
  cb_failure_threshold: number | null;
  cb_reset_timeout_ms: number | null;
  cb_half_open_timeout_ms: number | null;
  cb_window_ms: number | null;
  extra_json: string | null;
}

export interface ToolGuardRow {
  rate_limit_per_min: number | null;
  timeout_ms: number | null;
  allowed_key_hashes: string | null;
  extra_json: string | null;
}

export interface ToolOverrideRow {
  description: string | null;
  param_overrides_json: string | null;
  display_name: string | null;
  drift_note: string | null;
}

export function rowToClientGuards(row: ClientGuardRow | null): ClientGuardConfig | undefined {
  if (!row) return undefined;
  const cb: Record<string, number> = {};
  if (row.cb_failure_threshold !== null) cb.failureThreshold = row.cb_failure_threshold;
  if (row.cb_reset_timeout_ms !== null) cb.resetTimeoutMs = row.cb_reset_timeout_ms;
  if (row.cb_half_open_timeout_ms !== null) cb.halfOpenTimeoutMs = row.cb_half_open_timeout_ms;
  if (row.cb_window_ms !== null) cb.windowMs = row.cb_window_ms;
  return {
    circuitBreaker: Object.keys(cb).length > 0 ? (cb as ClientGuardConfig["circuitBreaker"]) : undefined,
    extra: row.extra_json ? (JSON.parse(row.extra_json) as Record<string, unknown>) : undefined,
  };
}

export function rowToToolGuards(row: ToolGuardRow | null): ToolGuardConfig | undefined {
  if (!row) return undefined;
  return {
    rateLimitPerMin: row.rate_limit_per_min ?? undefined,
    timeoutMs: row.timeout_ms ?? undefined,
    allowedKeyHashes: row.allowed_key_hashes ? (JSON.parse(row.allowed_key_hashes) as string[]) : undefined,
    extra: row.extra_json ? (JSON.parse(row.extra_json) as Record<string, unknown>) : undefined,
  };
}

export function rowToToolOverride(row: ToolOverrideRow | null): ToolOverride | undefined {
  if (!row) return undefined;
  const params = row.param_overrides_json
    ? (JSON.parse(row.param_overrides_json) as ToolOverride["params"])
    : undefined;
  const displayName = row.display_name ?? undefined;
  const driftNote = row.drift_note ?? undefined;
  if (!row.description && !displayName && !driftNote && (!params || Object.keys(params).length === 0)) {
    return undefined;
  }
  return { description: row.description ?? undefined, params, displayName, driftNote };
}

/** Persistent-side view of a client as returned by every persist/load method. */
export interface PersistedClient {
  name: string;
  ip: string;
  health_url: string;
  base_url: string;
  resolved_ip: string;
  retry_non_safe_methods: boolean;
  enabled: boolean;
  guards?: ClientGuardConfig;
  kind: UpstreamKind;
  mcpUrl?: string;
  mcpTransport?: McpTransport;
  tools: RegisteredTool[];
}

export interface PersistedRestRegistration {
  enabled: boolean;
  guards?: ClientGuardConfig;
  tools: RegisteredTool[];
}

export interface PersistedMcpRegistration extends PersistedRestRegistration {}

export class RegistryPersistence {
  /**
   * Upserts the client + tool rows for a REST registration and returns the
   * durable `enabled`/`guards` state to fold into the in-memory objects.
   *
   * The `enabled` column is deliberately omitted from every
   * `ON CONFLICT DO UPDATE SET` clause below — re-registration (which
   * backends do on every boot) must never silently re-enable something an
   * admin disabled.
   */
  persistRestRegistration(
    name: string,
    tools: RestToolDefinition[],
    healthUrl: string,
    ip: string,
    baseUrl: string,
    resolvedIp: string,
    retryNonSafeMethods: boolean,
  ): PersistedRestRegistration {
    const db = getDb();
    const now = Date.now();

    const txn = db.transaction(() => {
      const clientRow = db
        .query(
          `INSERT INTO clients (name, ip, health_url, base_url, resolved_ip, retry_non_safe_methods, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(name) DO UPDATE SET
             ip = excluded.ip,
             health_url = excluded.health_url,
             base_url = excluded.base_url,
             resolved_ip = excluded.resolved_ip,
             retry_non_safe_methods = excluded.retry_non_safe_methods,
             updated_at = excluded.updated_at
           RETURNING enabled`,
        )
        .get(name, ip, healthUrl, baseUrl, resolvedIp, retryNonSafeMethods ? 1 : 0, now, now) as { enabled: number };

      const clientGuardRow = db
        .query(
          `SELECT cb_failure_threshold, cb_reset_timeout_ms, cb_half_open_timeout_ms, cb_window_ms, extra_json FROM client_guards WHERE client_name = ?`,
        )
        .get(name) as ClientGuardRow | null;

      // Full-replace semantics for tools, mirroring the in-memory toolIndex rebuild below:
      // tools missing from this registration are deleted (cascades to tool_guards).
      const existingToolNames = new Set(
        (db.query(`SELECT name FROM tools WHERE client_name = ?`).all(name) as { name: string }[]).map((r) => r.name),
      );
      const newToolNames = new Set(tools.map((t) => t.name));
      for (const staleName of existingToolNames) {
        if (!newToolNames.has(staleName)) {
          db.query(`DELETE FROM tools WHERE client_name = ? AND name = ?`).run(name, staleName);
        }
      }

      const registeredTools: RegisteredTool[] = [];
      for (const tool of tools) {
        const toolRow = db
          .query(
            `INSERT INTO tools (client_name, name, method, endpoint, description, input_schema, enabled, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
             ON CONFLICT(client_name, name) DO UPDATE SET
               method = excluded.method,
               endpoint = excluded.endpoint,
               description = excluded.description,
               input_schema = excluded.input_schema,
               updated_at = excluded.updated_at
             RETURNING enabled`,
          )
          .get(
            name,
            tool.name,
            tool.method,
            tool.endpoint,
            tool.description,
            JSON.stringify(tool.inputSchema),
            now,
            now,
          ) as {
          enabled: number;
        };

        const toolGuardRow = db
          .query(
            `SELECT rate_limit_per_min, timeout_ms, allowed_key_hashes, extra_json FROM tool_guards WHERE client_name = ? AND tool_name = ?`,
          )
          .get(name, tool.name) as ToolGuardRow | null;

        const toolOverrideRow = db
          .query(
            `SELECT description, param_overrides_json, display_name, drift_note FROM tool_overrides WHERE client_name = ? AND tool_name = ?`,
          )
          .get(name, tool.name) as ToolOverrideRow | null;

        registeredTools.push({
          ...tool,
          enabled: toolRow.enabled === 1,
          guards: rowToToolGuards(toolGuardRow),
          override: rowToToolOverride(toolOverrideRow),
        });
      }

      return { enabled: clientRow.enabled === 1, guards: rowToClientGuards(clientGuardRow), tools: registeredTools };
    });

    return txn();
  }

  /**
   * MCP-upstream counterpart of `persistRestRegistration`. Writes kind='mcp' +
   * the connection columns on `clients`, and tool rows carrying the raw
   * `upstream_name` for dispatch plus inert method/endpoint sentinels (never
   * read on the MCP path). Same enabled/guards/override read-back and the
   * same "omit enabled from ON CONFLICT" rule (re-discovery must not re-enable).
   */
  persistMcpRegistration(
    name: string,
    tools: DiscoveredMcpTool[],
    mcpUrl: string,
    transport: McpTransport,
    ip: string,
    resolvedIp: string,
  ): PersistedMcpRegistration {
    const db = getDb();
    const now = Date.now();

    const txn = db.transaction(() => {
      const clientRow = db
        .query(
          `INSERT INTO clients (name, ip, health_url, base_url, resolved_ip, retry_non_safe_methods, enabled, kind, mcp_url, mcp_transport, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, 1, 'mcp', ?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET
             ip = excluded.ip,
             health_url = excluded.health_url,
             base_url = excluded.base_url,
             resolved_ip = excluded.resolved_ip,
             kind = excluded.kind,
             mcp_url = excluded.mcp_url,
             mcp_transport = excluded.mcp_transport,
             updated_at = excluded.updated_at
           RETURNING enabled`,
        )
        .get(name, ip, mcpUrl, mcpUrl, resolvedIp, mcpUrl, transport, now, now) as { enabled: number };

      const existingToolNames = new Set(
        (db.query(`SELECT name FROM tools WHERE client_name = ?`).all(name) as { name: string }[]).map((r) => r.name),
      );
      const newToolNames = new Set(tools.map((t) => t.name));
      for (const staleName of existingToolNames) {
        if (!newToolNames.has(staleName)) {
          db.query(`DELETE FROM tools WHERE client_name = ? AND name = ?`).run(name, staleName);
        }
      }

      const registeredTools: RegisteredTool[] = [];
      for (const tool of tools) {
        const toolRow = db
          .query(
            `INSERT INTO tools (client_name, name, method, endpoint, description, input_schema, upstream_name, enabled, created_at, updated_at)
             VALUES (?, ?, 'POST', '', ?, ?, ?, 1, ?, ?)
             ON CONFLICT(client_name, name) DO UPDATE SET
               method = excluded.method,
               endpoint = excluded.endpoint,
               description = excluded.description,
               input_schema = excluded.input_schema,
               upstream_name = excluded.upstream_name,
               updated_at = excluded.updated_at
             RETURNING enabled`,
          )
          .get(name, tool.name, tool.description, JSON.stringify(tool.inputSchema), tool.upstreamName, now, now) as {
          enabled: number;
        };

        const toolGuardRow = db
          .query(
            `SELECT rate_limit_per_min, timeout_ms, allowed_key_hashes, extra_json FROM tool_guards WHERE client_name = ? AND tool_name = ?`,
          )
          .get(name, tool.name) as ToolGuardRow | null;
        const toolOverrideRow = db
          .query(
            `SELECT description, param_overrides_json, display_name, drift_note FROM tool_overrides WHERE client_name = ? AND tool_name = ?`,
          )
          .get(name, tool.name) as ToolOverrideRow | null;

        registeredTools.push({
          name: tool.name,
          method: "POST",
          endpoint: "",
          upstreamName: tool.upstreamName,
          description: tool.description,
          inputSchema: tool.inputSchema,
          enabled: toolRow.enabled === 1,
          guards: rowToToolGuards(toolGuardRow),
          override: rowToToolOverride(toolOverrideRow),
        });
      }

      const clientGuardRow = db
        .query(
          `SELECT cb_failure_threshold, cb_reset_timeout_ms, cb_half_open_timeout_ms, cb_window_ms, extra_json FROM client_guards WHERE client_name = ?`,
        )
        .get(name) as ClientGuardRow | null;

      return { enabled: clientRow.enabled === 1, guards: rowToClientGuards(clientGuardRow), tools: registeredTools };
    });

    return txn();
  }

  /**
   * Reads a client's full persistent state straight from SQLite. Does NOT
   * combine any in-memory runtime fields — the caller composes those (status,
   * consecutive_failures) with whatever already lives in the live map.
   * Returns undefined when no row exists.
   */
  buildPersistedClientFromDb(name: string): PersistedClient | undefined {
    const db = getDb();
    const row = db
      .query(
        `SELECT ip, health_url, base_url, resolved_ip, retry_non_safe_methods, enabled, kind, mcp_url, mcp_transport FROM clients WHERE name = ?`,
      )
      .get(name) as {
      ip: string;
      health_url: string;
      base_url: string;
      resolved_ip: string;
      retry_non_safe_methods: number;
      enabled: number;
      kind: string;
      mcp_url: string | null;
      mcp_transport: string | null;
    } | null;
    if (!row) return undefined;

    const toolRows = db
      .query(
        `SELECT name, method, endpoint, description, input_schema, enabled, upstream_name FROM tools WHERE client_name = ?`,
      )
      .all(name) as {
      name: string;
      method: string;
      endpoint: string;
      description: string;
      input_schema: string;
      enabled: number;
      upstream_name: string | null;
    }[];
    const tools: RegisteredTool[] = toolRows.map((t) => {
      const tg = db
        .query(
          `SELECT rate_limit_per_min, timeout_ms, allowed_key_hashes, extra_json FROM tool_guards WHERE client_name = ? AND tool_name = ?`,
        )
        .get(name, t.name) as ToolGuardRow | null;
      const to = db
        .query(
          `SELECT description, param_overrides_json, display_name, drift_note FROM tool_overrides WHERE client_name = ? AND tool_name = ?`,
        )
        .get(name, t.name) as ToolOverrideRow | null;
      return {
        name: t.name,
        method: t.method as RegisteredTool["method"],
        endpoint: t.endpoint,
        upstreamName: t.upstream_name ?? undefined,
        description: t.description,
        inputSchema: JSON.parse(t.input_schema) as Record<string, unknown>,
        enabled: t.enabled === 1,
        guards: rowToToolGuards(tg),
        override: rowToToolOverride(to),
      };
    });

    const guardRow = db
      .query(
        `SELECT cb_failure_threshold, cb_reset_timeout_ms, cb_half_open_timeout_ms, cb_window_ms, extra_json FROM client_guards WHERE client_name = ?`,
      )
      .get(name) as ClientGuardRow | null;
    return {
      name,
      ip: row.ip,
      tools,
      health_url: row.health_url,
      base_url: row.base_url,
      resolved_ip: row.resolved_ip,
      retry_non_safe_methods: row.retry_non_safe_methods === 1,
      enabled: row.enabled === 1,
      guards: rowToClientGuards(guardRow),
      kind: row.kind as UpstreamKind,
      mcpUrl: row.mcp_url ?? undefined,
      mcpTransport: (row.mcp_transport as McpTransport | null) ?? undefined,
    };
  }
}
