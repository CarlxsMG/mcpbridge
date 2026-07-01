import type {
  RegisteredClient,
  RegisteredTool,
  RestToolDefinition,
  ResolvedTool,
  ClientStatus,
  ClientGuardConfig,
  ToolGuardConfig,
  ToolOverride,
} from "./types.js";
import { sanitizeToolDescription } from "./sanitize.js";
import { abortClientRequests } from "./proxy.js";
import { removeCircuitBreaker, updateCircuitBreakerConfig, getAllCircuitStates } from "./circuit-breaker.js";
import { notifyToolsChanged } from "./mcp-server.js";
import { getDb } from "./db/connection.js";
import { getTagsForClient, getAllToolTags } from "./tool-tags.js";

export interface ClientSummary {
  name: string;
  enabled: boolean;
  live: boolean;
  status: ClientStatus | null;
  toolsCount: number;
  healthUrl: string;
  baseUrl: string;
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
  circuitBreakerState: string | null;
  tools: RegisteredTool[];
}

const VALID_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

interface ClientGuardRow {
  cb_failure_threshold: number | null;
  cb_reset_timeout_ms: number | null;
  cb_half_open_timeout_ms: number | null;
  cb_window_ms: number | null;
  extra_json: string | null;
}

interface ToolGuardRow {
  rate_limit_per_min: number | null;
  timeout_ms: number | null;
  allowed_key_hashes: string | null;
  extra_json: string | null;
}

interface ToolOverrideRow {
  description: string | null;
  param_overrides_json: string | null;
}

function rowToClientGuards(row: ClientGuardRow | null): ClientGuardConfig | undefined {
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

function rowToToolGuards(row: ToolGuardRow | null): ToolGuardConfig | undefined {
  if (!row) return undefined;
  return {
    rateLimitPerMin: row.rate_limit_per_min ?? undefined,
    timeoutMs: row.timeout_ms ?? undefined,
    allowedKeyHashes: row.allowed_key_hashes ? (JSON.parse(row.allowed_key_hashes) as string[]) : undefined,
    extra: row.extra_json ? (JSON.parse(row.extra_json) as Record<string, unknown>) : undefined,
  };
}

function rowToToolOverride(row: ToolOverrideRow | null): ToolOverride | undefined {
  if (!row) return undefined;
  const params = row.param_overrides_json ? (JSON.parse(row.param_overrides_json) as ToolOverride["params"]) : undefined;
  if (!row.description && (!params || Object.keys(params).length === 0)) return undefined;
  return { description: row.description ?? undefined, params };
}

/** Tracks clients currently being unregistered to close the proxy race window. */
const deletingClients = new Set<string>();

/** Returns true when `name` is currently being unregistered. */
export function isDeleting(name: string): boolean {
  return deletingClients.has(name);
}

/** Separator between client name and tool name in composite tool keys. */
export const TOOL_KEY_SEPARATOR = "__";

/**
 * Validates an endpoint template for path-traversal segments.
 *
 * Substitutes :param placeholders with "x", splits on "/", and checks each
 * literal segment. Returns an error message string if invalid, or null when valid.
 *
 * Used by the HTTP /register route to reject bad endpoints before they enter
 * the registry. Also exported so it can be unit-tested independently.
 */
export function validateEndpointPath(endpoint: string): string | null {
  const probe = endpoint.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "x");
  const segments = probe.split("/").filter(Boolean);
  if (segments.some((s) => s === ".." || s === "." || s.includes(".."))) {
    return `Endpoint contains invalid path segment: ${endpoint}`;
  }
  return null;
}

class Registry {
  private clients: Map<string, RegisteredClient> = new Map();
  private toolIndex: Map<string, { clientName: string; toolName: string }> = new Map();

  // -------------------------------------------------------------------------
  // Async mutex — per-client name serialisation
  // -------------------------------------------------------------------------

  private locks = new Map<string, Promise<unknown>>();

  private async withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(name) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => { release = r; });
    const lockEntry = prev.then(() => next);
    this.locks.set(name, lockEntry);
    try {
      await prev;
      return await fn();
    } finally {
      release();
      // Only delete when no later waiter has replaced the entry
      if (this.locks.get(name) === lockEntry) {
        this.locks.delete(name);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Public accessors
  // -------------------------------------------------------------------------

  /** Returns the registered client for the given name, or undefined. */
  getClient(name: string): RegisteredClient | undefined {
    return this.clients.get(name);
  }

  /** Returns a defensive snapshot of all registered clients. */
  listClients(): readonly RegisteredClient[] {
    return Array.from(this.clients.values());
  }

  /**
   * Updates the health status of a client by name.
   * No-op when the client does not exist.
   */
  markClientStatus(name: string, status: ClientStatus): void {
    const client = this.clients.get(name);
    if (client) {
      client.status = status;
    }
  }

  /**
   * Increments the consecutive_failures counter for a client and returns
   * the new count. Returns 0 when the client does not exist.
   */
  incrementConsecutiveFailures(name: string): number {
    const client = this.clients.get(name);
    if (!client) return 0;
    client.consecutive_failures += 1;
    return client.consecutive_failures;
  }

  /** Resets the consecutive_failures counter to zero. No-op when client not found. */
  resetConsecutiveFailures(name: string): void {
    const client = this.clients.get(name);
    if (client) {
      client.consecutive_failures = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Serviceability (enabled/disabled) filtering
  // -------------------------------------------------------------------------

  private isServable(client: RegisteredClient, tool: RegisteredTool): boolean {
    return client.enabled && tool.enabled;
  }

  // -------------------------------------------------------------------------
  // Persistence helpers (SQLite is the source of truth for enabled/guards)
  // -------------------------------------------------------------------------

  /**
   * Upserts the client + tool rows for a registration and returns the
   * durable `enabled`/`guards` state to fold into the in-memory objects.
   *
   * The `enabled` column is deliberately omitted from every `ON CONFLICT DO
   * UPDATE SET` clause below — re-registration (which backends do on every
   * boot) must never silently re-enable something an admin disabled.
   */
  private persistRegistration(
    name: string,
    tools: RestToolDefinition[],
    healthUrl: string,
    ip: string,
    baseUrl: string,
    resolvedIp: string,
    retryNonSafeMethods: boolean
  ): { enabled: boolean; guards?: ClientGuardConfig; tools: RegisteredTool[] } {
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
           RETURNING enabled`
        )
        .get(name, ip, healthUrl, baseUrl, resolvedIp, retryNonSafeMethods ? 1 : 0, now, now) as { enabled: number };

      const clientGuardRow = db
        .query(`SELECT cb_failure_threshold, cb_reset_timeout_ms, cb_half_open_timeout_ms, cb_window_ms, extra_json FROM client_guards WHERE client_name = ?`)
        .get(name) as ClientGuardRow | null;

      // Full-replace semantics for tools, mirroring the in-memory toolIndex rebuild below:
      // tools missing from this registration are deleted (cascades to tool_guards).
      const existingToolNames = new Set(
        (db.query(`SELECT name FROM tools WHERE client_name = ?`).all(name) as { name: string }[]).map((r) => r.name)
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
             RETURNING enabled`
          )
          .get(name, tool.name, tool.method, tool.endpoint, tool.description, JSON.stringify(tool.inputSchema), now, now) as {
          enabled: number;
        };

        const toolGuardRow = db
          .query(`SELECT rate_limit_per_min, timeout_ms, allowed_key_hashes, extra_json FROM tool_guards WHERE client_name = ? AND tool_name = ?`)
          .get(name, tool.name) as ToolGuardRow | null;

        const toolOverrideRow = db
          .query(`SELECT description, param_overrides_json FROM tool_overrides WHERE client_name = ? AND tool_name = ?`)
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

  // -------------------------------------------------------------------------
  // Register / unregister
  // -------------------------------------------------------------------------

  async register(
    name: string,
    tools: RestToolDefinition[],
    healthUrl: string,
    ip: string,
    baseUrl: string,
    resolvedIp: string,
    retryNonSafeMethods: boolean = false
  ): Promise<void> {
    if (!name || typeof name !== "string") {
      throw new Error("Client name is required and must be a non-empty string");
    }

    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)) {
      throw new Error("Client name must match /^[a-z0-9][a-z0-9_-]{0,62}$/");
    }

    const seenToolNames = new Set<string>();

    for (const tool of tools) {
      if (!tool.name || typeof tool.name !== "string") {
        throw new Error("Tool name is required and must be a non-empty string");
      }

      if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(tool.name)) {
        throw new Error(
          `Tool '${tool.name}': name must be lowercase alphanumeric with hyphens/underscores, 1-63 chars`
        );
      }

      if (seenToolNames.has(tool.name)) {
        throw new Error(
          `Duplicate tool name "${tool.name}" found for client "${name}"`
        );
      }
      seenToolNames.add(tool.name);

      if (!tool.method || !VALID_METHODS.has(tool.method)) {
        throw new Error(
          `Tool "${tool.name}" has missing or invalid method "${tool.method}"`
        );
      }

      if (!tool.endpoint || typeof tool.endpoint !== "string") {
        throw new Error(`Tool "${tool.name}" is missing a valid endpoint`);
      }

      // Reject endpoint templates with path-traversal segments at registration time.
      // Mirrors the runtime check in proxy.ts so bad endpoints never enter the registry.
      const endpointError = validateEndpointPath(tool.endpoint);
      if (endpointError) {
        throw new Error(`Tool "${tool.name}" ${endpointError}`);
      }

      if (!tool.description || typeof tool.description !== "string") {
        throw new Error(`Tool "${tool.name}" is missing a valid description`);
      }

      if (!tool.inputSchema || typeof tool.inputSchema !== "object") {
        throw new Error(`Tool "${tool.name}" is missing a valid inputSchema`);
      }

      if (tool.inputSchema["type"] !== "object") {
        throw new Error(
          `Tool "${tool.name}" inputSchema must have type: "object"`
        );
      }

      if (JSON.stringify(tool.inputSchema).length > 10240) {
        throw new Error(
          `Tool '${tool.name}': inputSchema exceeds 10KB size limit`
        );
      }
    }

    // Sanitize tool descriptions and inputSchema property descriptions
    for (const tool of tools) {
      tool.description = sanitizeToolDescription(tool.description);

      if (tool.inputSchema?.properties && typeof tool.inputSchema.properties === "object") {
        for (const key of Object.keys(tool.inputSchema.properties as Record<string, unknown>)) {
          const prop = (tool.inputSchema.properties as Record<string, Record<string, unknown>>)[key];
          if (prop && typeof prop.description === "string") {
            prop.description = sanitizeToolDescription(prop.description);
          }
        }
      }
    }

    await this.withLock(name, async () => {
      // Remove existing tool index entries for this client before rebuilding
      if (this.clients.has(name)) {
        const existing = this.clients.get(name)!;
        for (const tool of existing.tools) {
          this.toolIndex.delete(`${name}${TOOL_KEY_SEPARATOR}${tool.name}`);
        }
      }

      const persisted = this.persistRegistration(name, tools, healthUrl, ip, baseUrl, resolvedIp, retryNonSafeMethods);

      const client: RegisteredClient = {
        name,
        ip,
        tools: persisted.tools,
        health_url: healthUrl,
        base_url: baseUrl,
        resolved_ip: resolvedIp,
        status: "healthy",
        consecutive_failures: 0,
        retry_non_safe_methods: retryNonSafeMethods,
        enabled: persisted.enabled,
        guards: persisted.guards,
      };

      this.clients.set(name, client);

      for (const tool of persisted.tools) {
        this.toolIndex.set(`${name}${TOOL_KEY_SEPARATOR}${tool.name}`, {
          clientName: name,
          toolName: tool.name,
        });
      }

      // Broadcast tool-list change to all connected MCP sessions.
      notifyToolsChanged();
    });
  }

  /**
   * Tears down a client's in-memory (live) state only — no SQLite writes.
   * Shared by `unregister()` (explicit removal + automatic health-eviction,
   * neither of which should touch durable admin config) and `forgetClient()`
   * (which additionally purges SQLite). Caller must already hold the
   * per-name lock.
   */
  private teardownLiveClient(name: string): boolean {
    deletingClients.add(name);
    try {
      const client = this.clients.get(name);
      if (!client) {
        return false;
      }

      // 1. Abort any in-flight requests so they don't land against a removed client
      abortClientRequests(name);

      // 2. Clean up circuit-breaker state
      removeCircuitBreaker(name);

      // 3. Remove all toolIndex entries for this client
      for (const tool of client.tools) {
        this.toolIndex.delete(`${name}${TOOL_KEY_SEPARATOR}${tool.name}`);
      }

      // 4. Remove the client record
      this.clients.delete(name);

      // 5. Broadcast tool-list change to all connected MCP sessions
      notifyToolsChanged();

      return true;
    } finally {
      deletingClients.delete(name);
    }
  }

  async unregister(name: string): Promise<boolean> {
    return this.withLock(name, async () => this.teardownLiveClient(name));
  }

  /**
   * Fully forgets a client: tears down in-memory state (if live) AND purges
   * its SQLite rows (cascades to tools/client_guards/tool_guards). Unlike
   * `unregister()`, this destroys any admin-configured enabled/guards state —
   * use it only for explicit "forget this client entirely" admin actions,
   * never for health-driven auto-eviction.
   */
  async forgetClient(name: string): Promise<boolean> {
    return this.withLock(name, async () => {
      const removedLive = this.teardownLiveClient(name);
      const db = getDb();
      const result = db.query(`DELETE FROM clients WHERE name = ?`).run(name);
      return removedLive || result.changes > 0;
    });
  }

  // -------------------------------------------------------------------------
  // Admin mutations — enable/disable
  // -------------------------------------------------------------------------

  /** Persists and (if live) applies a client-level enable/disable toggle. Returns false for an unknown client. */
  async setClientEnabled(name: string, enabled: boolean): Promise<boolean> {
    return this.withLock(name, async () => {
      const db = getDb();
      const result = db
        .query(`UPDATE clients SET enabled = ?, updated_at = ? WHERE name = ?`)
        .run(enabled ? 1 : 0, Date.now(), name);
      if (result.changes === 0) {
        return false;
      }

      const client = this.clients.get(name);
      if (client) {
        const changed = client.enabled !== enabled;
        client.enabled = enabled;
        if (changed) {
          notifyToolsChanged();
        }
      }
      return true;
    });
  }

  /** Persists and (if live) applies a tool-level enable/disable toggle. Returns false for an unknown client/tool. */
  async setToolEnabled(clientName: string, toolName: string, enabled: boolean): Promise<boolean> {
    return this.withLock(clientName, async () => {
      const db = getDb();
      const result = db
        .query(`UPDATE tools SET enabled = ?, updated_at = ? WHERE client_name = ? AND name = ?`)
        .run(enabled ? 1 : 0, Date.now(), clientName, toolName);
      if (result.changes === 0) {
        return false;
      }

      const client = this.clients.get(clientName);
      const tool = client?.tools.find((t) => t.name === toolName);
      if (client && tool) {
        const changed = tool.enabled !== enabled;
        tool.enabled = enabled;
        if (changed) {
          notifyToolsChanged();
        }
      }
      return true;
    });
  }

  // -------------------------------------------------------------------------
  // Admin mutations — dynamic guards
  // -------------------------------------------------------------------------

  /**
   * Persists and (if live) applies a client-level guard config. Pass `null`
   * to clear it back to "use global defaults". Returns false for an unknown
   * client. Does not call notifyToolsChanged — guards don't change what
   * tools/list advertises, only how calls to already-advertised tools behave.
   */
  async setClientGuards(clientName: string, guards: ClientGuardConfig | null): Promise<boolean> {
    return this.withLock(clientName, async () => {
      const db = getDb();
      const exists = db.query(`SELECT 1 FROM clients WHERE name = ?`).get(clientName);
      if (!exists) return false;

      if (guards === null) {
        db.query(`DELETE FROM client_guards WHERE client_name = ?`).run(clientName);
      } else {
        const cb = guards.circuitBreaker;
        db.query(
          `INSERT INTO client_guards (client_name, cb_failure_threshold, cb_reset_timeout_ms, cb_half_open_timeout_ms, cb_window_ms, extra_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(client_name) DO UPDATE SET
             cb_failure_threshold = excluded.cb_failure_threshold,
             cb_reset_timeout_ms = excluded.cb_reset_timeout_ms,
             cb_half_open_timeout_ms = excluded.cb_half_open_timeout_ms,
             cb_window_ms = excluded.cb_window_ms,
             extra_json = excluded.extra_json,
             updated_at = excluded.updated_at`
        ).run(
          clientName,
          cb?.failureThreshold ?? null,
          cb?.resetTimeoutMs ?? null,
          cb?.halfOpenTimeoutMs ?? null,
          cb?.windowMs ?? null,
          guards.extra ? JSON.stringify(guards.extra) : null,
          Date.now()
        );
      }

      const client = this.clients.get(clientName);
      if (client) {
        client.guards = guards ?? undefined;
        if (guards?.circuitBreaker) {
          updateCircuitBreakerConfig(clientName, guards.circuitBreaker);
        }
      }
      return true;
    });
  }

  /**
   * Persists and (if live) applies a tool-level guard config. Pass `null` to
   * clear it. Returns false for an unknown client/tool.
   */
  async setToolGuards(clientName: string, toolName: string, guards: ToolGuardConfig | null): Promise<boolean> {
    return this.withLock(clientName, async () => {
      const db = getDb();
      const exists = db.query(`SELECT 1 FROM tools WHERE client_name = ? AND name = ?`).get(clientName, toolName);
      if (!exists) return false;

      if (guards === null) {
        db.query(`DELETE FROM tool_guards WHERE client_name = ? AND tool_name = ?`).run(clientName, toolName);
      } else {
        db.query(
          `INSERT INTO tool_guards (client_name, tool_name, rate_limit_per_min, timeout_ms, allowed_key_hashes, extra_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(client_name, tool_name) DO UPDATE SET
             rate_limit_per_min = excluded.rate_limit_per_min,
             timeout_ms = excluded.timeout_ms,
             allowed_key_hashes = excluded.allowed_key_hashes,
             extra_json = excluded.extra_json,
             updated_at = excluded.updated_at`
        ).run(
          clientName,
          toolName,
          guards.rateLimitPerMin ?? null,
          guards.timeoutMs ?? null,
          guards.allowedKeyHashes ? JSON.stringify(guards.allowedKeyHashes) : null,
          guards.extra ? JSON.stringify(guards.extra) : null,
          Date.now()
        );
      }

      const client = this.clients.get(clientName);
      const tool = client?.tools.find((t) => t.name === toolName);
      if (tool) {
        tool.guards = guards ?? undefined;
      }
      return true;
    });
  }

  /**
   * Persists and (if live) applies a tool presentation override. Pass null to
   * clear. Admin-provided text is sanitized the same way registration
   * descriptions are, then a tools/list change is broadcast (overrides alter
   * what's advertised).
   */
  async setToolOverride(clientName: string, toolName: string, override: ToolOverride | null): Promise<boolean> {
    return this.withLock(clientName, async () => {
      const db = getDb();
      const exists = db.query(`SELECT 1 FROM tools WHERE client_name = ? AND name = ?`).get(clientName, toolName);
      if (!exists) return false;

      let normalized: ToolOverride | null = null;
      if (override) {
        const description = override.description ? sanitizeToolDescription(override.description) : undefined;
        let params: ToolOverride["params"] | undefined;
        if (override.params) {
          params = {};
          for (const [p, o] of Object.entries(override.params)) {
            if (o?.description) params[p] = { description: sanitizeToolDescription(o.description) };
          }
          if (Object.keys(params).length === 0) params = undefined;
        }
        if (description || params) normalized = { description, params };
      }

      if (!normalized) {
        db.query(`DELETE FROM tool_overrides WHERE client_name = ? AND tool_name = ?`).run(clientName, toolName);
      } else {
        db.query(
          `INSERT INTO tool_overrides (client_name, tool_name, description, param_overrides_json, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(client_name, tool_name) DO UPDATE SET
             description = excluded.description,
             param_overrides_json = excluded.param_overrides_json,
             updated_at = excluded.updated_at`
        ).run(clientName, toolName, normalized.description ?? null, normalized.params ? JSON.stringify(normalized.params) : null, Date.now());
      }

      const client = this.clients.get(clientName);
      const tool = client?.tools.find((t) => t.name === toolName);
      if (tool) tool.override = normalized ?? undefined;
      notifyToolsChanged();
      return true;
    });
  }

  /**
   * Merges a rate-limit / timeout patch into a tool's existing guards
   * (preserving its API-key allow-list) and persists. Used to apply named
   * guard policies in bulk. A null patch field clears that guard. Returns
   * false for an unknown client/tool.
   */
  async applyGuardPolicy(
    clientName: string,
    toolName: string,
    patch: { rateLimitPerMin?: number | null; timeoutMs?: number | null }
  ): Promise<boolean> {
    const db = getDb();
    if (!db.query(`SELECT 1 FROM tools WHERE client_name = ? AND name = ?`).get(clientName, toolName)) return false;
    const row = db
      .query(`SELECT rate_limit_per_min, timeout_ms, allowed_key_hashes, extra_json FROM tool_guards WHERE client_name = ? AND tool_name = ?`)
      .get(clientName, toolName) as ToolGuardRow | null;
    const merged: ToolGuardConfig = { ...(rowToToolGuards(row) ?? {}) };
    if (patch.rateLimitPerMin !== undefined) merged.rateLimitPerMin = patch.rateLimitPerMin ?? undefined;
    if (patch.timeoutMs !== undefined) merged.timeoutMs = patch.timeoutMs ?? undefined;
    // setToolGuards takes the per-name lock itself — do not wrap this in withLock.
    return this.setToolGuards(clientName, toolName, merged);
  }

  // -------------------------------------------------------------------------
  // Resolution / listing
  // -------------------------------------------------------------------------

  resolveTool(mcpToolName: string): ResolvedTool | undefined {
    const entry = this.toolIndex.get(mcpToolName);
    if (!entry) {
      return undefined;
    }

    const client = this.clients.get(entry.clientName);
    if (!client) {
      return undefined;
    }

    const tool = client.tools.find((t) => t.name === entry.toolName);
    if (!tool) {
      return undefined;
    }

    return { client, tool };
  }

  /**
   * Advertised (tools/list) shape for a tool, applying any admin presentation
   * override (description + per-param descriptions) without mutating the stored
   * definition. Only clones the schema when param overrides are present.
   */
  private effectiveAdvertised(
    clientName: string,
    tool: RegisteredTool
  ): { name: string; description: string; inputSchema: Record<string, unknown> } {
    const name = `${clientName}${TOOL_KEY_SEPARATOR}${tool.name}`;
    const ov = tool.override;
    if (!ov) return { name, description: tool.description, inputSchema: tool.inputSchema };
    const description = ov.description ?? tool.description;
    let inputSchema = tool.inputSchema;
    if (ov.params && Object.keys(ov.params).length > 0 && inputSchema && typeof inputSchema === "object") {
      const clone = JSON.parse(JSON.stringify(inputSchema)) as Record<string, unknown>;
      const props = clone.properties as Record<string, Record<string, unknown>> | undefined;
      if (props) {
        for (const [p, o] of Object.entries(ov.params)) {
          if (props[p] && o.description !== undefined) props[p].description = o.description;
        }
      }
      inputSchema = clone;
    }
    return { name, description, inputSchema };
  }

  /** All servable (enabled) tools across every enabled client, for the aggregated MCP endpoint. */
  getAllMcpTools(): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
    const result: { name: string; description: string; inputSchema: Record<string, unknown> }[] = [];

    for (const [clientName, client] of this.clients) {
      for (const tool of client.tools) {
        if (!this.isServable(client, tool)) continue;
        result.push(this.effectiveAdvertised(clientName, tool));
      }
    }

    return result;
  }

  /** Servable (enabled) tools for a single client, for the sharded /mcp/:clientName endpoint. */
  getMcpToolsForClient(clientName: string): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
    const client = this.clients.get(clientName);
    if (!client) return [];

    const result: { name: string; description: string; inputSchema: Record<string, unknown> }[] = [];
    for (const tool of client.tools) {
      if (!this.isServable(client, tool)) continue;
      result.push(this.effectiveAdvertised(clientName, tool));
    }
    return result;
  }

  getClientTools(name: string): RegisteredTool[] | undefined {
    return this.clients.get(name)?.tools;
  }

  /**
   * Servable (enabled) tools whose composite `clientName__toolName` key is
   * in `keys`, for the bundle-scoped /mcp-custom/:bundleName endpoint. Same
   * isServable filtering as getAllMcpTools/getMcpToolsForClient, so a bundle
   * automatically reflects live enabled/disabled state of its member tools
   * without the caller needing to duplicate that logic.
   */
  getMcpToolsForKeys(keys: Set<string>): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
    const result: { name: string; description: string; inputSchema: Record<string, unknown> }[] = [];

    for (const [clientName, client] of this.clients) {
      for (const tool of client.tools) {
        const key = `${clientName}${TOOL_KEY_SEPARATOR}${tool.name}`;
        if (!keys.has(key) || !this.isServable(client, tool)) continue;
        result.push(this.effectiveAdvertised(clientName, tool));
      }
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Admin read models — SQL-backed so they include clients that have
  // registered before but aren't currently live (e.g. temporarily down),
  // merged with in-memory data (health status, breaker state) where available.
  // -------------------------------------------------------------------------

  /** Forces a live client's circuit breaker back to closed. Returns false if the client isn't live. */
  resetCircuitBreaker(clientName: string): boolean {
    if (!this.clients.has(clientName)) return false;
    removeCircuitBreaker(clientName);
    return true;
  }

  /**
   * Paginated (keyset, by name), searchable client listing for the admin UI.
   * `status` is applied as a post-filter over the returned page (health status
   * is in-memory-only/ephemeral, not a SQL column), so a status-filtered page
   * may return fewer than `limit` items — acceptable for an admin list view.
   */
  listClientsSummary(
    opts: { q?: string; enabled?: boolean; status?: ClientStatus; cursor?: string; limit?: number } = {}
  ): { items: ClientSummary[]; nextCursor?: string } {
    const db = getDb();
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (opts.cursor) {
      conditions.push("c.name > ?");
      params.push(opts.cursor);
    }
    if (opts.q) {
      conditions.push("c.name LIKE ?");
      params.push(`%${opts.q}%`);
    }
    if (opts.enabled !== undefined) {
      conditions.push("c.enabled = ?");
      params.push(opts.enabled ? 1 : 0);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = db
      .query(
        `SELECT c.name, c.enabled, c.health_url, c.base_url, COUNT(t.name) as tools_count
         FROM clients c LEFT JOIN tools t ON t.client_name = c.name
         ${whereClause}
         GROUP BY c.name
         ORDER BY c.name
         LIMIT ?`
      )
      .all(...params, limit + 1) as { name: string; enabled: number; health_url: string; base_url: string; tools_count: number }[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    let items: ClientSummary[] = page.map((r) => {
      const live = this.clients.get(r.name);
      return {
        name: r.name,
        enabled: r.enabled === 1,
        live: live !== undefined,
        status: live?.status ?? null,
        toolsCount: r.tools_count,
        healthUrl: r.health_url,
        baseUrl: r.base_url,
      };
    });

    if (opts.status) {
      items = items.filter((i) => i.status === opts.status);
    }

    return { items, nextCursor: hasMore ? page[page.length - 1].name : undefined };
  }

  /**
   * Flat listing of every (client, tool) pair across every registered client,
   * read from SQLite so it includes clients that aren't currently live —
   * purpose-built for the bundle admin UI's tool picker, which (consistent
   * with bundles.ts checking existence rather than "currently enabled" when
   * validating membership) should let an admin pick a tool belonging to a
   * temporarily-down client.
   */
  listAllTools(): { client: string; tool: string; description: string; enabled: boolean; clientEnabled: boolean; tags: string[] }[] {
    const db = getDb();
    const rows = db
      .query(
        `SELECT c.name as client_name, c.enabled as client_enabled, t.name as tool_name, t.description, t.enabled
         FROM tools t JOIN clients c ON c.name = t.client_name
         ORDER BY c.name, t.name`
      )
      .all() as { client_name: string; client_enabled: number; tool_name: string; description: string; enabled: number }[];

    const allTags = getAllToolTags();
    return rows.map((r) => ({
      client: r.client_name,
      tool: r.tool_name,
      description: r.description,
      enabled: r.enabled === 1,
      clientEnabled: r.client_enabled === 1,
      tags: allTags[`${r.client_name}__${r.tool_name}`] ?? [],
    }));
  }

  /** Full detail for one client — tools with guards, health, circuit-breaker state. Undefined if never registered. */
  getClientDetail(name: string): ClientDetail | undefined {
    const db = getDb();
    const row = db
      .query(`SELECT ip, health_url, base_url, resolved_ip, retry_non_safe_methods, enabled FROM clients WHERE name = ?`)
      .get(name) as
      | { ip: string; health_url: string; base_url: string; resolved_ip: string; retry_non_safe_methods: number; enabled: number }
      | null;
    if (!row) return undefined;

    const live = this.clients.get(name);
    const guardRow = db
      .query(`SELECT cb_failure_threshold, cb_reset_timeout_ms, cb_half_open_timeout_ms, cb_window_ms, extra_json FROM client_guards WHERE client_name = ?`)
      .get(name) as ClientGuardRow | null;

    const tagMap = getTagsForClient(name);
    let tools: RegisteredTool[];
    if (live) {
      tools = live.tools.map((t) => ({ ...t, tags: tagMap[t.name] ?? [] }));
    } else {
      const toolRows = db
        .query(`SELECT name, method, endpoint, description, input_schema, enabled FROM tools WHERE client_name = ?`)
        .all(name) as { name: string; method: string; endpoint: string; description: string; input_schema: string; enabled: number }[];
      tools = toolRows.map((t) => {
        const tg = db
          .query(`SELECT rate_limit_per_min, timeout_ms, allowed_key_hashes, extra_json FROM tool_guards WHERE client_name = ? AND tool_name = ?`)
          .get(name, t.name) as ToolGuardRow | null;
        const to = db
          .query(`SELECT description, param_overrides_json FROM tool_overrides WHERE client_name = ? AND tool_name = ?`)
          .get(name, t.name) as ToolOverrideRow | null;
        return {
          name: t.name,
          method: t.method as RegisteredTool["method"],
          endpoint: t.endpoint,
          description: t.description,
          inputSchema: JSON.parse(t.input_schema) as Record<string, unknown>,
          enabled: t.enabled === 1,
          guards: rowToToolGuards(tg),
          override: rowToToolOverride(to),
          tags: tagMap[t.name] ?? [],
        };
      });
    }

    return {
      name,
      enabled: row.enabled === 1,
      live: live !== undefined,
      status: live?.status ?? null,
      ip: live?.ip ?? row.ip,
      healthUrl: row.health_url,
      baseUrl: row.base_url,
      resolvedIp: row.resolved_ip,
      retryNonSafeMethods: row.retry_non_safe_methods === 1,
      consecutiveFailures: live?.consecutive_failures ?? null,
      guards: rowToClientGuards(guardRow),
      circuitBreakerState: live ? (getAllCircuitStates()[name] ?? "closed") : null,
      tools,
    };
  }

}

export const registry = new Registry();
