import type { RegisteredClient, RestToolDefinition, ResolvedTool } from "./types.js";

const VALID_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

class Registry {
  clients: Map<string, RegisteredClient> = new Map();
  toolIndex: Map<string, { clientName: string; toolName: string }> = new Map();

  register(
    name: string,
    tools: RestToolDefinition[],
    healthUrl: string,
    ip: string
  ): void {
    if (!name || typeof name !== "string") {
      throw new Error("Client name is required and must be a non-empty string");
    }

    const seenToolNames = new Set<string>();

    for (const tool of tools) {
      if (!tool.name || typeof tool.name !== "string") {
        throw new Error("Tool name is required and must be a non-empty string");
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
    }

    // Remove existing tool index entries for this client before rebuilding
    if (this.clients.has(name)) {
      const existing = this.clients.get(name)!;
      for (const tool of existing.tools) {
        this.toolIndex.delete(`${name}__${tool.name}`);
      }
    }

    const client: RegisteredClient = {
      name,
      ip,
      tools,
      health_url: healthUrl,
      status: "healthy",
    };

    this.clients.set(name, client);

    for (const tool of tools) {
      this.toolIndex.set(`${name}__${tool.name}`, {
        clientName: name,
        toolName: tool.name,
      });
    }
  }

  unregister(name: string): boolean {
    const client = this.clients.get(name);
    if (!client) {
      return false;
    }

    for (const tool of client.tools) {
      this.toolIndex.delete(`${name}__${tool.name}`);
    }

    this.clients.delete(name);
    return true;
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
          name: `${clientName}__${tool.name}`,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
      }
    }

    return result;
  }

  getAllClients(): RegisteredClient[] {
    return Array.from(this.clients.values());
  }

  getClientTools(name: string): RestToolDefinition[] | undefined {
    return this.clients.get(name)?.tools;
  }

  markStatus(name: string, status: "healthy" | "unreachable"): void {
    const client = this.clients.get(name);
    if (client) {
      client.status = status;
    }
  }
}

export const registry = new Registry();
