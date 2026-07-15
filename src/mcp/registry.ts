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
} from "./types.js";
import { sanitizeToolDescription } from "../content-filtering/sanitize.js";
import { abortClientRequests, invalidatePinnedIp } from "../proxy/proxy.js";
import { invalidateCompiledSchemasForClient } from "../proxy/schema-validator.js";
import { removeCircuitBreaker } from "../middleware/circuit-breaker.js";
import { clearLbState } from "../tool-policies/load-balancer.js";
import { notifyToolsChanged } from "./mcp-server.js";
import { getDb } from "../db/connection.js";
import { purgeClientCache } from "../tool-policies/response-cache.js";
import { mcpUpstream } from "./mcp-upstream.js";
import type { DiscoveredMcpTool } from "./mcp-discovery.js";
import { TOOL_KEY_SEPARATOR, isValidToolName } from "../lib/identifier.js";
import { createKeyedMutex } from "../lib/async-lock.js";
import { RegistryAliasIndex } from "./registry-alias-index.js";
import { ToolIndex } from "./tool-index.js";
import { RegistryPersistence } from "./registry-persistence.js";
import {
  listClientsSummaryReadModel,
  listAllToolsReadModel,
  getClientDetailReadModel,
  type ClientSummary,
  type ClientDetail,
  type ListClientsSummaryOpts,
  type ToolListItem,
} from "./registry-read-models.js";
import {
  setClientEnabledMutation,
  setToolEnabledMutation,
  setClientGuardsMutation,
  setToolGuardsMutation,
  setToolOverrideMutation,
  annotateToolDriftMutation,
  computeMergedToolGuards,
  ToolOverrideError,
} from "./registry-mutations.js";

export type { ClientSummary, ClientDetail };
export { ToolOverrideError };

const VALID_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

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

/**
 * Sanitizes every string `.description` found on an inputSchema's top-level
 * `properties` map, mutating the schema in place. Shared by register() (REST)
 * and registerMcp() (MCP upstream) — both walk a newly-validated tool's
 * inputSchema.properties the same way right after validation, applying the
 * same prompt-injection defense (sanitizeToolDescription) as the top-level
 * tool.description. Security-relevant: keep behavior byte-for-byte identical
 * to what each call site had inlined before this was extracted.
 */
function sanitizeSchemaPropertyDescriptions(schema: Record<string, unknown> | undefined): void {
  if (!schema?.properties || typeof schema.properties !== "object") return;
  for (const key of Object.keys(schema.properties as Record<string, unknown>)) {
    const prop = (schema.properties as Record<string, Record<string, unknown>>)[key];
    if (prop && typeof prop.description === "string") {
      prop.description = sanitizeToolDescription(prop.description);
    }
  }
}

/**
 * Client-name validation shared by register() (REST) and registerMcp() (MCP
 * upstream) — both entry points gate the same way. Security-relevant: keep
 * behavior byte-for-byte identical to what each call site had inlined before
 * this was extracted (mirrors sanitizeSchemaPropertyDescriptions above).
 */
function validateClientName(name: string): void {
  if (!name || typeof name !== "string") {
    throw new Error("Client name is required and must be a non-empty string");
  }
  if (!isValidToolName(name)) {
    throw new Error("Client name must match /^[a-z0-9][a-z0-9_-]{0,62}$/");
  }
}

/**
 * Per-tool identity checks (name validity + in-batch duplicate detection) shared
 * by both registration paths. Runs BEFORE each path's kind-specific checks
 * (REST method/endpoint, MCP upstreamName), preserving the original error
 * precedence. Adds the accepted name to `seenToolNames`. Extracted so the two
 * security-relevant entry points can't drift and admit on one path a tool the
 * other would reject.
 */
function validateToolIdentity(clientName: string, tool: { name: string }, seenToolNames: Set<string>): void {
  if (!tool.name || typeof tool.name !== "string") {
    throw new Error("Tool name is required and must be a non-empty string");
  }
  if (!isValidToolName(tool.name)) {
    throw new Error(`Tool '${tool.name}': name must be lowercase alphanumeric with hyphens/underscores, 1-63 chars`);
  }
  if (seenToolNames.has(tool.name)) {
    throw new Error(`Duplicate tool name "${tool.name}" found for client "${clientName}"`);
  }
  seenToolNames.add(tool.name);
}

/**
 * Per-tool description + inputSchema-shape/size checks shared by both
 * registration paths. Runs AFTER each path's kind-specific checks, preserving
 * the original error precedence. Same anti-drift rationale as
 * validateToolIdentity.
 */
function validateCommonToolSchema(tool: { name: string; description: string; inputSchema: unknown }): void {
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

class Registry {
  private clients: Map<string, RegisteredClient> = new Map();
  /**
   * Names torn down by health-driven auto-eviction (evictUnhealthy) whose
   * SQLite row is still present (unregister/eviction deliberately never
   * touches durable config). reconcileFromDb() checks this before re-hydrating
   * a name absent from `this.clients` — without it, the next reconcile pass
   * would immediately bring an unreachable client back as "healthy" (no prior
   * `existing` status to fall back on), and the health-check loop would evict
   * it again on the very next tick, forever. Cleared only by a genuine
   * re-registration of the same name (register/registerMcp), never by
   * explicit admin unregister() — that's a deliberate removal, not a symptom
   * of an unhealthy backend, and should propagate normally on reconcile.
   *
   * Known limitation in a multi-replica HA deployment: this Set is local,
   * in-memory, per-process state, not shared via SQLite like the rest of the
   * registry. The health-check loop that populates it is leader-gated (only
   * one instance ever calls evictUnhealthy), but the re-registration that
   * clears it can land on ANY instance (whichever the load balancer routes
   * it to) — clearing only that instance's (already-empty) entry, not the
   * leader's. This is harmless under the documented default topology
   * (`/readyz`-gated LB routing, so only the leader ever serves), but if
   * `/livez` is used for readiness instead so every replica serves (see
   * helm values.yaml's readiness-probe override comment), a re-registration
   * routed to a non-leader replica can leave the leader's mark in place,
   * and the leader's own reconcileFromDb() will keep withholding the client
   * indefinitely. See docs/guide/scaling.md.
   */
  private readonly healthEvicted = new Set<string>();
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
    validateClientName(name);

    const seenToolNames = new Set<string>();

    for (const tool of tools) {
      validateToolIdentity(name, tool, seenToolNames);

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

      validateCommonToolSchema(tool);
    }

    // Sanitize tool descriptions and inputSchema property descriptions
    for (const tool of tools) {
      tool.description = sanitizeToolDescription(tool.description);
      sanitizeSchemaPropertyDescriptions(tool.inputSchema);
    }

    await this.withLock(name, async () => {
      // A genuine (re-)registration proves the backend is reachable again —
      // clear any health-eviction hold so reconcileFromDb can hydrate peers.
      this.healthEvicted.delete(name);

      // Remove existing tool index entries for this client before rebuilding
      if (this.clients.has(name)) {
        const existing = this.clients.get(name)!;
        for (const tool of existing.tools) {
          this.toolIndex.deleteTool(name, tool.name);
        }
        // Re-registering over a live client may point it at a different backend;
        // drop the stale pinned IP so the new resolved_ip below is what gets used
        // (this path does not go through teardownLiveClient).
        invalidatePinnedIp(name);
        // Drop compiled Ajv validators too — a re-registration may carry a
        // tightened/loosened inputSchema for a tool name that stays the same,
        // and getOrCompile's cache is keyed only by clientName::toolName.
        invalidateCompiledSchemasForClient(name);
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
    validateClientName(name);

    const seenToolNames = new Set<string>();
    for (const tool of tools) {
      validateToolIdentity(name, tool, seenToolNames);
      if (!tool.upstreamName || typeof tool.upstreamName !== "string") {
        throw new Error(`Tool "${tool.name}" is missing a valid upstreamName`);
      }
      validateCommonToolSchema(tool);
    }

    // Sanitize descriptions + inputSchema property descriptions (same as REST).
    const sanitizedTools: DiscoveredMcpTool[] = tools.map((t) => {
      sanitizeSchemaPropertyDescriptions(t.inputSchema);
      return { ...t, description: sanitizeToolDescription(t.description) };
    });

    await this.withLock(name, async () => {
      // A genuine (re-)registration proves the backend is reachable again —
      // clear any health-eviction hold so reconcileFromDb can hydrate peers.
      this.healthEvicted.delete(name);

      if (this.clients.has(name)) {
        const existing = this.clients.get(name)!;
        for (const tool of existing.tools) {
          this.toolIndex.deleteTool(name, tool.name);
        }
        // Same reasoning as register(): a re-discovery may carry a
        // tightened/loosened inputSchema for a tool name that stays the same.
        invalidateCompiledSchemasForClient(name);
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

      // 1a. Forget the pinned-IP cache entry so a later re-registration under the
      // same name re-seeds from its fresh resolved_ip instead of the old pin.
      invalidatePinnedIp(name);

      // 1c. Drop compiled Ajv validators for this client's tools — otherwise
      // they'd linger in the module-level cache indefinitely across
      // client/tool churn, and a same-named re-registration later would
      // still risk hitting a stale entry if any tool name is reused.
      invalidateCompiledSchemasForClient(name);

      // 1b. Close any outbound MCP upstream connection (no-op for REST clients).
      void mcpUpstream.disconnect(name);

      // 2. Clean up circuit-breaker state
      removeCircuitBreaker(name);

      // 2b. Drop load-balancer runtime state (round-robin cursor, per-target
      // cooldown/in-flight) so it doesn't leak across client churn.
      clearLbState(name);

      // 3. Drop any cached responses for this client's tools — otherwise a
      // stale (possibly pre-redaction-change or pre-backend-swap) entry can
      // outlive the client and get served again if the same name is
      // re-registered later against a different backend.
      purgeClientCache(name);

      // 4. Remove all toolIndex + alias entries for this client
      for (const tool of client.tools) {
        this.toolIndex.deleteTool(name, tool.name);
      }
      this.aliasIndex.clearForClient(name);

      // 5. Remove the client record
      this.clients.delete(name);

      // 6. Broadcast tool-list change to all connected MCP sessions
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
   * Health-driven counterpart to unregister(): tears down live state
   * identically, but additionally marks `name` in `healthEvicted` so the next
   * reconcileFromDb() doesn't immediately re-hydrate it as "healthy" while its
   * SQLite row (deliberately untouched, same as unregister()) still exists.
   * Only src/observability/health.ts's handleFailure() should call this —
   * every other caller wants the plain unregister() (no re-hydration hold).
   */
  async evictUnhealthy(name: string): Promise<boolean> {
    return this.withLock(name, async () => {
      this.healthEvicted.add(name);
      return this.teardownLiveClient(name);
    });
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
      // The row is gone, so there's nothing left for a future reconcile to
      // withhold — drop any stale eviction marker so it can't leak forever.
      this.healthEvicted.delete(name);
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
        // A name just torn down by health-driven eviction, whose row is still
        // in the DB by design — do NOT re-hydrate it as "healthy" here; wait
        // for either a genuine re-registration (clears the marker) or the
        // row's actual deletion (drops out of dbNames on a later pass).
        if (this.healthEvicted.has(name)) continue;
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
      const crow = db.query(`SELECT enabled FROM clients WHERE name = ?`).get(name) as { enabled: number } | null;
      // A peer instance may have deleted this client between the dbNames snapshot
      // above and this read; treat a vanished row as "removed on the next pass"
      // rather than dereferencing null, which would throw and abort the whole
      // reconcile cycle.
      if (!crow) continue;
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

  /**
   * Persists and (if live) applies a client-level enable/disable toggle.
   * Returns false for an unknown client. Thin wrapper — logic lives in
   * registry-mutations.ts; this method only owns the per-client-name lock.
   */
  async setClientEnabled(name: string, enabled: boolean): Promise<boolean> {
    return this.withLock(name, async () => setClientEnabledMutation(this.clients, name, enabled));
  }

  /**
   * Persists and (if live) applies a tool-level enable/disable toggle.
   * Returns false for an unknown client/tool. Thin wrapper — logic lives in
   * registry-mutations.ts; this method only owns the per-client-name lock.
   */
  async setToolEnabled(clientName: string, toolName: string, enabled: boolean): Promise<boolean> {
    return this.withLock(clientName, async () => setToolEnabledMutation(this.clients, clientName, toolName, enabled));
  }

  // -------------------------------------------------------------------------
  // Admin mutations — dynamic guards
  // -------------------------------------------------------------------------

  /**
   * Persists and (if live) applies a client-level guard config. Pass `null`
   * to clear it back to "use global defaults". Returns false for an unknown
   * client. Does not call notifyToolsChanged — guards don't change what
   * tools/list advertises, only how calls to already-advertised tools behave.
   * Thin wrapper — logic lives in registry-mutations.ts; this method only
   * owns the per-client-name lock.
   */
  async setClientGuards(clientName: string, guards: ClientGuardConfig | null): Promise<boolean> {
    return this.withLock(clientName, async () => setClientGuardsMutation(this.clients, clientName, guards));
  }

  /**
   * Persists and (if live) applies a tool-level guard config. Pass `null` to
   * clear it. Returns false for an unknown client/tool. Thin wrapper — logic
   * lives in registry-mutations.ts; this method only owns the
   * per-client-name lock.
   */
  async setToolGuards(clientName: string, toolName: string, guards: ToolGuardConfig | null): Promise<boolean> {
    return this.withLock(clientName, async () => setToolGuardsMutation(this.clients, clientName, toolName, guards));
  }

  /**
   * Persists and (if live) applies a tool presentation override. Pass null to
   * clear. Admin-provided text is sanitized the same way registration
   * descriptions are, then a tools/list change is broadcast (overrides alter
   * what's advertised). Thin wrapper — logic lives in registry-mutations.ts;
   * this method only owns the per-client-name lock and supplies
   * `isAliasAvailable` (a pure DB lookup that doesn't need the `clients` map).
   */
  async setToolOverride(clientName: string, toolName: string, override: ToolOverride | null): Promise<boolean> {
    return this.withLock(clientName, async () =>
      setToolOverrideMutation(
        this.clients,
        this.aliasIndex,
        (c, t, d) => this.isAliasAvailable(c, t, d),
        clientName,
        toolName,
        override,
      ),
    );
  }

  /**
   * System-authored schema-drift changelog annotation (called from
   * monitor.ts's runSyntheticChecks on the drift-detected/drift-resolved
   * EDGE, and from setMonitor when an admin resets a monitor's baseline).
   * Pass a bracketed, dated note string to add/replace it; pass `null` to
   * clear it. Returns false for an unknown client/tool. Thin wrapper — logic
   * lives in registry-mutations.ts; this method only owns the
   * per-client-name lock.
   */
  async annotateToolDrift(clientName: string, toolName: string, note: string | null): Promise<boolean> {
    return this.withLock(clientName, async () => annotateToolDriftMutation(this.clients, clientName, toolName, note));
  }

  /**
   * Merges a rate-limit / timeout patch into a tool's existing guards
   * (preserving its API-key allow-list) and persists. Used to apply named
   * guard policies in bulk. A null patch field clears that guard. Returns
   * false for an unknown client/tool. The merge computation lives in
   * registry-mutations.ts; setToolGuards takes the per-name lock itself —
   * do not wrap this in withLock.
   */
  async applyGuardPolicy(
    clientName: string,
    toolName: string,
    patch: { rateLimitPerMin?: number | null; timeoutMs?: number | null },
  ): Promise<boolean> {
    const merged = computeMergedToolGuards(clientName, toolName, patch);
    if (merged === null) return false;
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
   * All servable (enabled) tools across every enabled client, flattened. No
   * production caller remains (there is no flattened "every client" serving
   * scope any more — see McpServerScope; `sys_list_tools` uses listAllTools()).
   * Retained as a stable test accessor: the registry test-suite and mutation
   * backstops assert against "everything currently advertised" through this one
   * call rather than aggregating getMcpToolsForClient across clients by hand.
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
   * Thin wrapper — logic lives in registry-read-models.ts (SQL-backed read
   * model, needs only the live `clients` map for health-status merging).
   */
  listClientsSummary(opts: ListClientsSummaryOpts = {}): { items: ClientSummary[]; nextCursor?: string } {
    return listClientsSummaryReadModel(this.clients, opts);
  }

  /**
   * Flat listing of every (client, tool) pair across every registered client.
   * Thin wrapper — logic lives in registry-read-models.ts.
   */
  listAllTools(): ToolListItem[] {
    return listAllToolsReadModel();
  }

  /**
   * Full detail for one client — tools with guards, health, circuit-breaker
   * state. Undefined if never registered. Thin wrapper — logic lives in
   * registry-read-models.ts (SQL-backed read model, needs only the live
   * `clients` map for health/breaker-state merging).
   */
  getClientDetail(name: string): ClientDetail | undefined {
    return getClientDetailReadModel(this.clients, name);
  }
}

export const registry = new Registry();
