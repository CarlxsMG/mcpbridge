import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { buildTransport } from "./mcp-upstream.js";
import type { McpConnParams } from "./mcp-upstream.js";

// ---------------------------------------------------------------------------
// MCP upstream tool discovery — the MCP counterpart of openapi-discovery.ts.
//
// Opens a short-lived MCP Client, paginates tools/list, and maps each upstream
// tool into the registry's tool shape. Two upstream-specific concerns handled
// here (that OpenAPI discovery doesn't have):
//
//  1. Names: upstream MCP tool names are unconstrained (dots, uppercase, etc.)
//     but the registry enforces /^[a-z0-9][a-z0-9_-]{0,62}$/ and uses "__" as
//     the client/tool key separator. We normalize to a safe `name` and keep the
//     raw `upstreamName` for dispatch (that is what gets sent in tools/call).
//  2. Descriptions are OPTIONAL on the MCP wire, but the registry requires a
//     non-empty description — so we synthesize a fallback.
// ---------------------------------------------------------------------------

/** A discovered upstream tool, ready to hand to the registry's MCP registration. */
export interface DiscoveredMcpTool {
  /** Registry-safe, regex-conforming name used in the `client__name` key. */
  name: string;
  /** Raw upstream tool name — what dispatch sends in tools/call. */
  upstreamName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const CLIENT_NAME = "mcp-rest-bridge";
const CLIENT_VERSION = "1.0.0";

/**
 * Normalizes an arbitrary upstream tool name to the registry's identifier
 * regex: lowercase, non-`[a-z0-9_-]` chars → "_", trimmed to 63 chars, and
 * guaranteed to start with an alphanumeric. Collisions are resolved by the
 * caller (discoverMapTools), not here.
 */
export function normalizeToolName(raw: string): string {
  let s = raw.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  if (s.length === 0) return "tool";
  if (!/^[a-z0-9]/.test(s)) s = `t${s}`;
  return s.slice(0, 63);
}

/**
 * Maps raw MCP tools/list entries to DiscoveredMcpTool[], normalizing names and
 * de-duplicating collisions with a numeric suffix (e.g. two upstream tools that
 * both normalize to "get_item" become "get_item" and "get_item_2").
 */
export function discoverMapTools(
  mcpTools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>,
): DiscoveredMcpTool[] {
  const used = new Set<string>();
  const out: DiscoveredMcpTool[] = [];

  for (const t of mcpTools) {
    let name = normalizeToolName(t.name);
    if (used.has(name)) {
      let i = 2;
      while (used.has(`${name}_${i}`.slice(0, 63))) i++;
      name = `${name}_${i}`.slice(0, 63);
    }
    used.add(name);

    const description =
      t.description && t.description.trim().length > 0 ? t.description : `Tool "${t.name}" from upstream MCP server`;

    out.push({ name, upstreamName: t.name, description, inputSchema: t.inputSchema });
  }

  return out;
}

export interface DiscoverOptions {
  /** Overrides the transport factory (tests inject an InMemoryTransport). */
  transportFactory?: (p: McpConnParams) => Transport;
  /** Per-request timeout for connect + each tools/list page. */
  timeoutMs?: number;
}

/**
 * Connects to an upstream MCP server, paginates through tools/list, and returns
 * the mapped tool set. The connection is short-lived — opened and closed here —
 * because discovery runs at registration time, not on the hot path.
 */
export async function discoverToolsFromMcpServer(
  params: McpConnParams,
  opts: DiscoverOptions = {},
): Promise<DiscoveredMcpTool[]> {
  const factory = opts.transportFactory ?? buildTransport;
  const timeout = opts.timeoutMs ?? 10_000;

  const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION }, { capabilities: {} });
  await client.connect(factory(params), { timeout });

  try {
    const collected: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout });
      for (const t of page.tools) {
        collected.push({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as Record<string, unknown>,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);

    return discoverMapTools(collected);
  } finally {
    await client.close();
  }
}
