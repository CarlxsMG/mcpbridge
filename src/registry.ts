import type { RegisteredClient, RestToolDefinition, ResolvedTool, ClientStatus } from "./types.js";
import { sanitizeToolDescription } from "./sanitize.js";
import { abortClientRequests } from "./proxy.js";
import { removeCircuitBreaker } from "./circuit-breaker.js";
import { notifyToolsChanged } from "./mcp-server.js";

const VALID_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

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

      const client: RegisteredClient = {
        name,
        ip,
        tools,
        health_url: healthUrl,
        base_url: baseUrl,
        resolved_ip: resolvedIp,
        status: "healthy",
        consecutive_failures: 0,
        retry_non_safe_methods: retryNonSafeMethods,
      };

      this.clients.set(name, client);

      for (const tool of tools) {
        this.toolIndex.set(`${name}${TOOL_KEY_SEPARATOR}${tool.name}`, {
          clientName: name,
          toolName: tool.name,
        });
      }

      // Broadcast tool-list change to all connected MCP sessions.
      notifyToolsChanged();
    });
  }

  async unregister(name: string): Promise<boolean> {
    return this.withLock(name, async () => {
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
    });
  }

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

  getAllMcpTools(): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
    const result: { name: string; description: string; inputSchema: Record<string, unknown> }[] = [];

    for (const [clientName, client] of this.clients) {
      for (const tool of client.tools) {
        result.push({
          name: `${clientName}${TOOL_KEY_SEPARATOR}${tool.name}`,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
      }
    }

    return result;
  }

  getClientTools(name: string): RestToolDefinition[] | undefined {
    return this.clients.get(name)?.tools;
  }

}

export const registry = new Registry();
