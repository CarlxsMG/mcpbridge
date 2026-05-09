import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "module";
import { registry } from "./registry.js";
import { proxyToolCall } from "./proxy.js";

const _require = createRequire(import.meta.url);
const pkg = _require("../package.json") as { version: string };

const activeServers = new Set<Server>();

export function createMcpServer(): Server {
  const server = new Server(
    { name: "mcp-rest-bridge", version: pkg.version },
    { capabilities: { tools: { listChanged: true } } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: registry.getAllMcpTools() };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return proxyToolCall(name, args ?? {});
  });

  activeServers.add(server);

  server.onclose = () => {
    activeServers.delete(server);
  };

  return server;
}

export function notifyToolsChanged(): void {
  for (const server of activeServers) {
    try {
      server.notification({ method: "notifications/tools/list_changed" });
    } catch {
      // ignore failures for individual servers
    }
  }
}
