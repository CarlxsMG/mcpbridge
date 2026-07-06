import type {
  RegisteredClient,
  RegisteredTool,
  RestToolDefinition,
  ResolvedTool,
  ClientStatus,
  ClientGuardConfig,
  ToolGuardConfig,
  ToolOverride,
  McpTransport,
  UpstreamKind,
} from "./types.js";
import { sanitizeToolDescription } from "../content-filtering/sanitize.js";
import { abortClientRequests } from "../proxy/proxy.js";
import {
  removeCircuitBreaker,
  updateCircuitBreakerConfig,
  getAllCircuitStates,
} from "../middleware/circuit-breaker.js";
import { notifyToolsChanged } from "./mcp-server.js";
import { getDb } from "../db/connection.js";
import { getTagsForClient, getAllToolTags } from "../tool-meta/tool-tags.js";
import { getSensitivityForClient } from "../tool-meta/tool-sensitivity.js";
import { getRedactionForClient } from "../content-filtering/redaction.js";
import { getGuardrailsForClient } from "../tool-policies/guardrails.js";
import { getCoalesceForClient } from "../tool-policies/coalesce.js";
import { getApprovalConfigForClient } from "../admin/entities/approvals.js";
import { getQuarantineForClient } from "../tool-policies/quarantine.js";
import { getWsForClient, getGraphqlForClient } from "../proxy/backends.js";
import { getContextBudgetForClient } from "../tool-policies/context-budget.js";
import { mcpUpstream } from "./mcp-upstream.js";
import type { DiscoveredMcpTool } from "./mcp-discovery.js";
import { TOOL_NAME_RE, TOOL_KEY_SEPARATOR } from "../lib/identifier.js";
import { createKeyedMutex } from "../lib/async-lock.js";
import { RegistryAliasIndex } from "./registry-alias-index.js";
import { ToolIndex } from "./tool-index.js";
import {
  RegistryPersistence,
  rowToClientGuards,
  rowToToolGuards,
  rowToToolOverride,
  type ClientGuardRow,
  type ToolGuardRow,
  type ToolOverrideRow,
} from "./registry-persistence.js";

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
  kind: UpstreamKind;
  mcpUrl: string | null;
  mcpTransport: string | null;
  teamId: number | null;
  tools: RegisteredTool[];
}

const VALID_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** Thrown by setToolOverride when a displayName alias is malformed or collides with another tool. */
export class ToolOverrideError extends Error {
  constructor(
    public code: "TOOL_ALIAS_INVALID" | "TOOL_ALIAS_CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "ToolOverrideError";
  }
}

/** Tracks clients currently being unregistered to close the proxy race window. */
const deletingClients = new Set<string>();

/** Returns true when `name` is currently being unregistered. */
export function isDeleting(name: string): boolean {
  return deletingClients.has(name);
}

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
  private toolIndex = new ToolIndex();
  /** Display-name alias index — see registry-alias-index.ts. Kept as a field on
   * `Registry` only because its lifecycle mirrors the registry's (rebuilt on
   * register, drained on teardown). The map itself lives in its own module. */
  private aliasIndex = new RegistryAliasIndex();
  /** SQLite-backed persistence — every SQL read/write the registry does is
   * delegated here so the live orchestrator stays a thin layer. */
  private persistence = new RegistryPersistence();

  // -------------------------------------------------------------------------
  // Async mutex — per-client name serialisation (see lib/async-lock.ts's
  // createKeyedMutex, which shares this exact shape with
  // admin/tool-composition/bundles.ts and composites.ts's withLock)
  // -------------------------------------------------------------------------

  private readonly mutex = createKeyedMutex();

  private withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return this.mutex.withLock(name, fn);
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
  // Display-name alias index (clientName__displayName -> clientName__toolName)
  // — operations delegated to RegistryAliasIndex (registry-alias-index.ts).
  // -------------------------------------------------------------------------

  /**
   * Translates an advertised tool name (possibly an alias) to its canonical
   * `clientName__toolName`. A non-alias name is returned unchanged, so callers
   * can pass either form. Used at the single MCP call entry point so every
   * downstream check (scope, bundle membership, proxyToolCall) sees the
   * canonical identity. Thin wrapper over `RegistryAliasIndex.resolve`.
   */
  resolveAdvertisedName(name: string): string {
    return this.aliasIndex.resolve(name);
  }

  /**
   * True when `displayName` is free to use as an alias for (clientName, toolName)
   * — i.e. no *other* tool of the same client already exposes that segment as
   * its real name or its own displayName. The `clientName__` prefix guarantees
   * cross-client aliases can never collide, so the check is client-scoped.
   */
  isAliasAvailable(clientName: string, toolName: string, displayName: string): boolean {
    if (displayName === toolName) return true; // aliasing a tool to its own name is a no-op, always fine
    const rows = getDb()
      .query(
        `SELECT t.name AS name, o.display_name AS display_name
         FROM tools t LEFT JOIN tool_overrides o ON o.client_name = t.client_name AND o.tool_name = t.name
         WHERE t.client_name = ? AND t.name != ?`,
      )
      .all(clientName, toolName) as { name: string; display_name: string | null }[];
    for (const r of rows) {
      if (r.name === displayName || r.display_name === displayName) return false;
    }
    return true;
  }

  // Register / unregister
  // -------------------------------------------------------------------------

  async register(
    name: string,
    tools: RestToolDefinition[],
    healthUrl: string,
    ip: string,
    baseUrl: string,
    resolvedIp: string,
    retryNonSafeMethods: boolean = false,
  ): Promise<void> {
    if (!name || typeof name !== "string") {
      throw new Error("Client name is required and must be a non-empty string");
    }

    if (!TOOL_NAME_RE.test(name)) {
      throw new Error("Client name must match /^[a-z0-9][a-z0-9_-]{0,62}$/");
    }

    const seenToolNames = new Set<string>();

    for (const tool of tools) {
      if (!tool.name || typeof tool.name !== "string") {
        throw new Error("Tool name is required and must be a non-empty string");
      }

      if (!TOOL_NAME_RE.test(tool.name)) {
        throw new Error(
          `Tool '${tool.name}': name must be lowercase alphanumeric with hyphens/underscores, 1-63 chars`,
        );
      }

      if (seenToolNames.has(tool.name)) {
        throw new Error(`Duplicate tool name "${tool.name}" found for client "${name}"`);
      }
      seenToolNames.add(tool.name);

      if (!tool.method || !VALID_METHODS.has(tool.method)) {
        throw new Error(`Tool "${tool.name}" has missing or invalid method "${tool.method}"`);
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
        throw new Error(`Tool "${tool.name}" inputSchema must have type: "object"`);
      }

      if (JSON.stringify(tool.inputSchema).length > 10240) {
        throw new Error(`Tool '${tool.name}': inputSchema exceeds 10KB size limit`);
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
          this.toolIndex.deleteTool(name, tool.name);
        }
      }

      const persisted = this.persistence.persistRestRegistration(
        name,
        tools,
        healthUrl,
        ip,
        baseUrl,
        resolvedIp,
        retryNonSafeMethods,
      );

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
        kind: "rest",
      };

      this.clients.set(name, client);

      for (const tool of persisted.tools) {
        this.toolIndex.setTool(name, tool.name);
      }
      this.aliasIndex.rebuildForClient(name, persisted.tools);

      // Broadcast tool-list change to all connected MCP sessions.
      notifyToolsChanged();
    });
  }

  /**
   * Registers (or re-discovers) an MCP-kind upstream: validates + sanitizes the
   * discovered tools, persists them, and folds durable enabled/guards state into
   * the live registry. Mirrors register() but skips REST-only checks
   * (method/endpoint) and requires each tool's raw upstreamName for dispatch.
   */
  async registerMcp(
    name: string,
    tools: DiscoveredMcpTool[],
    mcpUrl: string,
    transport: McpTransport,
    ip: string,
    resolvedIp: string,
  ): Promise<void> {
    if (!name || typeof name !== "string") {
      throw new Error("Client name is required and must be a non-empty string");
    }
    if (!TOOL_NAME_RE.test(name)) {
      throw new Error("Client name must match /^[a-z0-9][a-z0-9_-]{0,62}$/");
    }

    const seenToolNames = new Set<string>();
    for (const tool of tools) {
      if (!tool.name || typeof tool.name !== "string") {
        throw new Error("Tool name is required and must be a non-empty string");
      }
      if (!TOOL_NAME_RE.test(tool.name)) {
        throw new Error(
          `Tool '${tool.name}': name must be lowercase alphanumeric with hyphens/underscores, 1-63 chars`,
        );
      }
      if (seenToolNames.has(tool.name)) {
        throw new Error(`Duplicate tool name "${tool.name}" found for client "${name}"`);
      }
      seenToolNames.add(tool.name);
      if (!tool.upstreamName || typeof tool.upstreamName !== "string") {
        throw new Error(`Tool "${tool.name}" is missing a valid upstreamName`);
      }
      if (!tool.description || typeof tool.description !== "string") {
        throw new Error(`Tool "${tool.name}" is missing a valid description`);
      }
      if (!tool.inputSchema || typeof tool.inputSchema !== "object") {
        throw new Error(`Tool "${tool.name}" is missing a valid inputSchema`);
      }
      if ((tool.inputSchema as Record<string, unknown>)["type"] !== "object") {
        throw new Error(`Tool "${tool.name}" inputSchema must have type: "object"`);
      }
      if (JSON.stringify(tool.inputSchema).length > 10240) {
        throw new Error(`Tool '${tool.name}': inputSchema exceeds 10KB size limit`);
      }
    }

    // Sanitize descriptions + inputSchema property descriptions (same as REST).
    const sanitizedTools: DiscoveredMcpTool[] = tools.map((t) => {
      if (t.inputSchema.properties && typeof t.inputSchema.properties === "object") {
        for (const key of Object.keys(t.inputSchema.properties as Record<string, unknown>)) {
          const prop = (t.inputSchema.properties as Record<string, Record<string, unknown>>)[key];
          if (prop && typeof prop.description === "string") {
            prop.description = sanitizeToolDescription(prop.description);
          }
        }
      }
      return { ...t, description: sanitizeToolDescription(t.description) };
    });

    await this.withLock(name, async () => {
      if (this.clients.has(name)) {
        const existing = this.clients.get(name)!;
        for (const tool of existing.tools) {
          this.toolIndex.deleteTool(name, tool.name);
        }
      }

      const persisted = this.persistence.persistMcpRegistration(
        name,
        sanitizedTools,
        mcpUrl,
        transport,
        ip,
        resolvedIp,
      );

      const client: RegisteredClient = {
        name,
        ip,
        tools: persisted.tools,
        health_url: mcpUrl,
        base_url: mcpUrl,
        resolved_ip: resolvedIp,
        status: "healthy",
        consecutive_failures: 0,
        enabled: persisted.enabled,
        guards: persisted.guards,
        kind: "mcp",
        mcpUrl,
        mcpTransport: transport,
      };

      this.clients.set(name, client);
      for (const tool of persisted.tools) {
        this.toolIndex.setTool(name, tool.name);
      }
      this.aliasIndex.rebuildForClient(name, persisted.tools);

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

      // 1b. Close any outbound MCP upstream connection (no-op for REST clients).
      void mcpUpstream.disconnect(name);

      // 2. Clean up circuit-breaker state
      removeCircuitBreaker(name);

      // 3. Remove all toolIndex + alias entries for this client
      for (const tool of client.tools) {
        this.toolIndex.deleteTool(name, tool.name);
      }
      this.aliasIndex.clearForClient(name);

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

  /**
   * Reconciles the in-memory registry against SQLite so mutations made by other
   * instances propagate: clients present in the DB but not live are added,
   * live clients no longer in the DB are torn down, and for already-live
   * clients the enable flags (client + per-tool) are refreshed. Tool-set
   * changes for a live client propagate when its owning backend re-registers.
   */
  async reconcileFromDb(): Promise<{ added: number; removed: number; updated: number }> {
    const db = getDb();
    const dbNames = new Set((db.query(`SELECT name FROM clients`).all() as { name: string }[]).map((r) => r.name));
    let added = 0;
    let removed = 0;
    let updated = 0;

    // Remove live clients no longer present in SQLite.
    for (const name of Array.from(this.clients.keys())) {
      if (!dbNames.has(name)) {
        await this.withLock(name, async () => {
          if (this.teardownLiveClient(name)) removed++;
        });
      }
    }

    for (const name of dbNames) {
      if (!this.clients.has(name)) {
        // A registration this instance hasn't seen — hydrate it live.
        await this.withLock(name, async () => {
          const persisted = this.persistence.buildPersistedClientFromDb(name);
          if (!persisted) return;
          const existing = this.clients.get(name);
          const client: RegisteredClient = {
            ...persisted,
            status: existing?.status ?? "healthy",
            consecutive_failures: existing?.consecutive_failures ?? 0,
          };
          this.clients.set(name, client);
          for (const t of client.tools) this.toolIndex.setTool(name, t.name);
          this.aliasIndex.rebuildForClient(name, client.tools);
          added++;
        });
        continue;
      }
      // Already live — refresh enable flags (the common cross-instance admin action).
      const live = this.clients.get(name)!;
      const crow = db.query(`SELECT enabled FROM clients WHERE name = ?`).get(name) as { enabled: number };
      if ((crow.enabled === 1) !== live.enabled) {
        live.enabled = crow.enabled === 1;
        updated++;
      }
      const toolEnabled = new Map(
        (
          db.query(`SELECT name, enabled FROM tools WHERE client_name = ?`).all(name) as {
            name: string;
            enabled: number;
          }[]
        ).map((t) => [t.name, t.enabled === 1]),
      );
      for (const t of live.tools) {
        const e = toolEnabled.get(t.name);
        if (e !== undefined && e !== t.enabled) {
          t.enabled = e;
          updated++;
        }
      }
    }

    if (added > 0 || removed > 0 || updated > 0) notifyToolsChanged();
    return { added, removed, updated };
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
             updated_at = excluded.updated_at`,
        ).run(
          clientName,
          cb?.failureThreshold ?? null,
          cb?.resetTimeoutMs ?? null,
          cb?.halfOpenTimeoutMs ?? null,
          cb?.windowMs ?? null,
          guards.extra ? JSON.stringify(guards.extra) : null,
          Date.now(),
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
             updated_at = excluded.updated_at`,
        ).run(
          clientName,
          toolName,
          guards.rateLimitPerMin ?? null,
          guards.timeoutMs ?? null,
          guards.allowedKeyHashes ? JSON.stringify(guards.allowedKeyHashes) : null,
          guards.extra ? JSON.stringify(guards.extra) : null,
          Date.now(),
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
        let displayName: string | undefined;
        if (override.displayName) {
          // A display-name alias becomes part of the composite MCP key, so it
          // must satisfy the same charset as a tool name (keeps the `__`
          // separator unambiguous — see TOOL_KEY_SEPARATOR invariant).
          if (!TOOL_NAME_RE.test(override.displayName)) {
            throw new ToolOverrideError("TOOL_ALIAS_INVALID", "displayName must match /^[a-z0-9][a-z0-9_-]{0,62}$/");
          }
          if (!this.isAliasAvailable(clientName, toolName, override.displayName)) {
            throw new ToolOverrideError(
              "TOOL_ALIAS_CONFLICT",
              `displayName '${override.displayName}' collides with another tool of client '${clientName}'`,
            );
          }
          if (override.displayName !== toolName) displayName = override.displayName;
        }
        if (description || params || displayName) normalized = { description, params, displayName };
      }

      if (!normalized) {
        // A schema-drift note (system-authored, see annotateToolDrift) can live
        // in the same row's `drift_note` column. Clearing the admin's own
        // override must never silently delete that note out from under the
        // monitor — only drop the row entirely when no note is active;
        // otherwise just null out the admin-authored columns and keep it.
        const current = db
          .query(`SELECT drift_note FROM tool_overrides WHERE client_name = ? AND tool_name = ?`)
          .get(clientName, toolName) as { drift_note: string | null } | null;
        if (current?.drift_note) {
          db.query(
            `UPDATE tool_overrides SET description = NULL, param_overrides_json = NULL, display_name = NULL, updated_at = ?
             WHERE client_name = ? AND tool_name = ?`,
          ).run(Date.now(), clientName, toolName);
        } else {
          db.query(`DELETE FROM tool_overrides WHERE client_name = ? AND tool_name = ?`).run(clientName, toolName);
        }
      } else {
        db.query(
          `INSERT INTO tool_overrides (client_name, tool_name, description, param_overrides_json, display_name, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(client_name, tool_name) DO UPDATE SET
             description = excluded.description,
             param_overrides_json = excluded.param_overrides_json,
             display_name = excluded.display_name,
             updated_at = excluded.updated_at`,
        ).run(
          clientName,
          toolName,
          normalized.description ?? null,
          normalized.params ? JSON.stringify(normalized.params) : null,
          normalized.displayName ?? null,
          Date.now(),
        );
      }

      const client = this.clients.get(clientName);
      const tool = client?.tools.find((t) => t.name === toolName);
      if (tool) {
        // Re-read rather than assume `normalized` is the full picture — a
        // drift_note may have survived the branch above and must be reflected
        // in the live in-memory override too.
        const row = db
          .query(
            `SELECT description, param_overrides_json, display_name, drift_note FROM tool_overrides WHERE client_name = ? AND tool_name = ?`,
          )
          .get(clientName, toolName) as ToolOverrideRow | null;
        tool.override = rowToToolOverride(row);
      }
      // Keep the alias index in lockstep — resolveAdvertisedName/resolveTool
      // depend on it. Safe for a non-live client too (rebuilt on next register).
      this.aliasIndex.setAlias(clientName, toolName, normalized?.displayName);
      notifyToolsChanged();
      return true;
    });
  }

  /**
   * System-authored schema-drift changelog annotation (called from
   * monitor.ts's runSyntheticChecks on the drift-detected/drift-resolved
   * EDGE, and from setMonitor when an admin resets a monitor's baseline).
   * Pass a bracketed, dated note string to add/replace it; pass `null` to
   * clear it (drift resolved, or the baseline was reset — never leave a
   * stale note behind, mirroring quarantine.ts's lazy auto-clear idiom).
   *
   * Stored in tool_overrides.drift_note — a column the admin-facing
   * setToolOverride() never writes to — so this can never clobber an
   * admin-authored description, param overrides, or displayName, and an
   * admin editing those can never clobber this note either. The two are
   * concatenated only at advertise-time, in effectiveAdvertised(). Uses the
   * same UPSERT + notifyToolsChanged() idiom setToolOverride uses (this DOES
   * change what tools/list advertises). Idempotent — a no-op call (already
   * in the requested state) skips the write and the tools/list broadcast.
   * Returns false for an unknown client/tool.
   */
  async annotateToolDrift(clientName: string, toolName: string, note: string | null): Promise<boolean> {
    return this.withLock(clientName, async () => {
      const db = getDb();
      const exists = db.query(`SELECT 1 FROM tools WHERE client_name = ? AND name = ?`).get(clientName, toolName);
      if (!exists) return false;

      const current = db
        .query(
          `SELECT description, param_overrides_json, display_name, drift_note FROM tool_overrides WHERE client_name = ? AND tool_name = ?`,
        )
        .get(clientName, toolName) as ToolOverrideRow | null;

      if ((current?.drift_note ?? null) === note) {
        return true; // already in the desired state — avoid a redundant write + broadcast
      }

      if (note === null) {
        if (current?.description || current?.param_overrides_json || current?.display_name) {
          // Admin-authored fields remain — null out only the note, keep the row.
          db.query(
            `UPDATE tool_overrides SET drift_note = NULL, updated_at = ? WHERE client_name = ? AND tool_name = ?`,
          ).run(Date.now(), clientName, toolName);
        } else {
          db.query(`DELETE FROM tool_overrides WHERE client_name = ? AND tool_name = ?`).run(clientName, toolName);
        }
      } else {
        db.query(
          `INSERT INTO tool_overrides (client_name, tool_name, drift_note, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(client_name, tool_name) DO UPDATE SET
             drift_note = excluded.drift_note,
             updated_at = excluded.updated_at`,
        ).run(clientName, toolName, note, Date.now());
      }

      const client = this.clients.get(clientName);
      const tool = client?.tools.find((t) => t.name === toolName);
      if (tool) {
        const row = db
          .query(
            `SELECT description, param_overrides_json, display_name, drift_note FROM tool_overrides WHERE client_name = ? AND tool_name = ?`,
          )
          .get(clientName, toolName) as ToolOverrideRow | null;
        tool.override = rowToToolOverride(row);
      }
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
    patch: { rateLimitPerMin?: number | null; timeoutMs?: number | null },
  ): Promise<boolean> {
    const db = getDb();
    if (!db.query(`SELECT 1 FROM tools WHERE client_name = ? AND name = ?`).get(clientName, toolName)) return false;
    const row = db
      .query(
        `SELECT rate_limit_per_min, timeout_ms, allowed_key_hashes, extra_json FROM tool_guards WHERE client_name = ? AND tool_name = ?`,
      )
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
    // Accept either the canonical key or a display-name alias.
    const canonical = this.aliasIndex.resolve(mcpToolName);
    const entry = this.toolIndex.get(canonical);
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
    tool: RegisteredTool,
  ): { name: string; description: string; inputSchema: Record<string, unknown> } {
    const segment = tool.override?.displayName ?? tool.name;
    const name = `${clientName}${TOOL_KEY_SEPARATOR}${segment}`;
    const ov = tool.override;
    if (!ov) return { name, description: tool.description, inputSchema: tool.inputSchema };
    const base = ov.description ?? tool.description;
    // The drift-note prefix is concatenated here, at advertise-time only — it
    // is never merged into the stored `description`, so it can be added/removed
    // independently of whatever the admin has (or hasn't) set. See
    // ToolOverride.driftNote and Registry.annotateToolDrift.
    const description = ov.driftNote ? `${ov.driftNote} ${base}` : base;
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

  /**
   * All servable (enabled) tools across every enabled client. Not used by any
   * MCP-serving endpoint any more (there is no flattened "every client" scope
   * — see McpServerScope) — kept as a general registry query for admin
   * read-models and the `sys_list_tools`-adjacent tooling in system-tools.ts.
   */
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
  getMcpToolsForClient(
    clientName: string,
  ): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
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
    opts: {
      q?: string;
      enabled?: boolean;
      status?: ClientStatus;
      cursor?: string;
      limit?: number;
      teamId?: number | null;
    } = {},
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
    // Tenancy scoping: a team-scoped caller only sees its own team's clients.
    if (typeof opts.teamId === "number") {
      conditions.push("c.team_id = ?");
      params.push(opts.teamId);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = db
      .query(
        `SELECT c.name, c.enabled, c.kind, c.health_url, c.base_url, c.team_id, COUNT(t.name) as tools_count
         FROM clients c LEFT JOIN tools t ON t.client_name = c.name
         ${whereClause}
         GROUP BY c.name
         ORDER BY c.name
         LIMIT ?`,
      )
      .all(...params, limit + 1) as {
      name: string;
      enabled: number;
      kind: string;
      health_url: string;
      base_url: string;
      team_id: number | null;
      tools_count: number;
    }[];

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
        kind: r.kind as UpstreamKind,
        teamId: r.team_id ?? null,
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
  listAllTools(): {
    client: string;
    tool: string;
    description: string;
    enabled: boolean;
    clientEnabled: boolean;
    tags: string[];
  }[] {
    const db = getDb();
    const rows = db
      .query(
        `SELECT c.name as client_name, c.enabled as client_enabled, t.name as tool_name, t.description, t.enabled
         FROM tools t JOIN clients c ON c.name = t.client_name
         ORDER BY c.name, t.name`,
      )
      .all() as {
      client_name: string;
      client_enabled: number;
      tool_name: string;
      description: string;
      enabled: number;
    }[];

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
      .query(
        `SELECT ip, health_url, base_url, resolved_ip, retry_non_safe_methods, enabled, kind, mcp_url, mcp_transport, team_id FROM clients WHERE name = ?`,
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
      team_id: number | null;
    } | null;
    if (!row) return undefined;

    const live = this.clients.get(name);
    const guardRow = db
      .query(
        `SELECT cb_failure_threshold, cb_reset_timeout_ms, cb_half_open_timeout_ms, cb_window_ms, extra_json FROM client_guards WHERE client_name = ?`,
      )
      .get(name) as ClientGuardRow | null;

    const tagMap = getTagsForClient(name);
    const sensMap = getSensitivityForClient(name);
    const redactMap = getRedactionForClient(name);
    const guardrailMap = getGuardrailsForClient(name);
    const coalesceMap = getCoalesceForClient(name);
    const approvalMap = getApprovalConfigForClient(name);
    const quarantineMap = getQuarantineForClient(name);
    const wsMap = getWsForClient(name);
    const graphqlMap = getGraphqlForClient(name);
    const contextBudgetMap = getContextBudgetForClient(name);
    let tools: RegisteredTool[];
    if (live) {
      tools = live.tools.map((t) => ({
        ...t,
        tags: tagMap[t.name] ?? [],
        sensitive: sensMap[t.name] ?? null,
        redactPaths: redactMap[t.name] ?? [],
        guardrails: guardrailMap[t.name],
        coalesce: coalesceMap[t.name],
        approval: approvalMap[t.name],
        quarantine: quarantineMap[t.name],
        ws: wsMap[t.name],
        graphql: graphqlMap[t.name],
        contextBudget: contextBudgetMap[t.name],
      }));
    } else {
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
      tools = toolRows.map((t) => {
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
          tags: tagMap[t.name] ?? [],
          sensitive: sensMap[t.name] ?? null,
          redactPaths: redactMap[t.name] ?? [],
          guardrails: guardrailMap[t.name],
          coalesce: coalesceMap[t.name],
          approval: approvalMap[t.name],
          quarantine: quarantineMap[t.name],
          ws: wsMap[t.name],
          graphql: graphqlMap[t.name],
          contextBudget: contextBudgetMap[t.name],
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
      kind: row.kind as UpstreamKind,
      mcpUrl: row.mcp_url,
      mcpTransport: row.mcp_transport,
      teamId: row.team_id ?? null,
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
