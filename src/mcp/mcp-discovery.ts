import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { buildTransport } from "./mcp-upstream.js";
import type { McpConnParams } from "./mcp-upstream.js";
import { config } from "../config.js";
import { uniqueToolName } from "../discovery/tool-naming.js";
import type { ToolAnnotations } from "./types.js";

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
  /** Upstream-declared MCP tool annotations (2025-06-18), passed through verbatim when present. */
  annotations?: ToolAnnotations;
  /** Upstream-declared MCP tool `outputSchema` (2025-06-18), passed through when present. */
  outputSchema?: Record<string, unknown>;
  /** Upstream-declared MCP tool `title` (2025-06-18), passed through when present. */
  title?: string;
}

/** The upstream tools/list fields we thread through discovery — a subset of the MCP `Tool` wire shape. */
interface UpstreamListedTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
  outputSchema?: Record<string, unknown>;
  title?: string;
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
 * both normalize to "get_item" become "get_item" and "get_item_2"). Uses the
 * shared `uniqueToolName` helper (src/discovery/tool-naming.ts) rather than a
 * hand-rolled loop — a bespoke version here previously checked the suffixed
 * candidate against the un-truncated base name, which infinite-looped
 * whenever the base was already 63 characters (every candidate collapsed back
 * to the same string). `uniqueToolName` truncates the base first, guaranteeing
 * termination within `used.size + 1` iterations.
 */
export function discoverMapTools(mcpTools: UpstreamListedTool[]): DiscoveredMcpTool[] {
  const used = new Set<string>();
  const out: DiscoveredMcpTool[] = [];

  for (const t of mcpTools) {
    const name = uniqueToolName(normalizeToolName(t.name), used);

    const description =
      t.description && t.description.trim().length > 0 ? t.description : `Tool "${t.name}" from upstream MCP server`;

    // Pass through the 2025-06-18 governance/presentation fields verbatim when
    // the upstream declared them, so a native MCP tool's own annotations,
    // outputSchema, and title survive the bridge (see registry.effectiveAdvertised).
    const mapped: DiscoveredMcpTool = { name, upstreamName: t.name, description, inputSchema: t.inputSchema };
    if (t.annotations) mapped.annotations = t.annotations;
    if (t.outputSchema) mapped.outputSchema = t.outputSchema;
    if (t.title) mapped.title = t.title;
    out.push(mapped);
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
    const collected: UpstreamListedTool[] = [];
    let cursor: string | undefined;
    // Bound the paginated read so a malicious/compromised upstream can't OOM or
    // hang the gateway. `maxTools` mirrors the per-client cap registration enforces
    // afterward, so buffering past it is pointless — once we're over it the client
    // is rejected regardless, and we stop reading rather than absorb an unbounded
    // stream. MAX_PAGES is a separate safety net for an upstream that returns empty
    // pages with an endless nextCursor (which would never grow `collected`).
    const maxTools = config.maxToolsPerClient;
    const MAX_PAGES = 1000;
    let pages = 0;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout });
      for (const t of page.tools) {
        const entry: UpstreamListedTool = {
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as Record<string, unknown>,
        };
        // Thread the optional 2025-06-18 fields through when the upstream sends
        // them (the SDK's Tool type carries all three).
        if (t.annotations) entry.annotations = t.annotations as ToolAnnotations;
        if (t.outputSchema) entry.outputSchema = t.outputSchema as Record<string, unknown>;
        if (typeof t.title === "string") entry.title = t.title;
        collected.push(entry);
      }
      cursor = page.nextCursor;
      if (collected.length > maxTools) break; // over the cap — registration will reject anyway
    } while (cursor && ++pages < MAX_PAGES);

    return discoverMapTools(collected);
  } finally {
    await client.close();
  }
}
