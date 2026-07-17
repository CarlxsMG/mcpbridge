/**
 * `search_tools` — a synthetic MCP meta-tool that helps LLM clients discover the
 * right tool when a bundle exposes many tools behind one endpoint (or the /mcp
 * system root exposes many `sys_*` tools). It is not a registered tool: it
 * carries no `clientName__` prefix (so it can never collide with a real tool,
 * which always has the `__` separator), it is advertised in tools/list, and
 * it is handled directly in mcp-server.ts — it never enters proxyToolCall. It
 * always ranks over the *caller's current scope* (a single sharded client, a
 * bundle, or the system root), so it can only surface tools the caller could
 * already see.
 */

import { toolResult, type ToolCallResult } from "../lib/mcp-result.js";
import type { ToolAnnotations } from "./types.js";

export const SEARCH_TOOL_NAME = "search_tools";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const DESCRIPTION_SNIPPET = 200;

export interface AdvertisedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * MCP tool annotations (2025-06-18) advertised in tools/list — governance-
   * derived hints (readOnly/idempotent/destructive/openWorld) merged with any
   * upstream-declared annotations. See registry.effectiveAdvertised. Optional:
   * the search meta-tool, composites, and sys_* tools omit it.
   */
  annotations?: ToolAnnotations;
  /** Upstream-declared MCP tool `outputSchema` (2025-06-18), advertised when present (MCP-upstream tools only). */
  outputSchema?: Record<string, unknown>;
  /** Upstream-declared MCP tool `title` (2025-06-18), advertised when present (MCP-upstream tools only). */
  title?: string;
}

/** The tools/list shape advertised for the meta-tool. */
export function searchToolDefinition(): AdvertisedTool {
  return {
    name: SEARCH_TOOL_NAME,
    description:
      "Search the tools available on this endpoint by keyword. Returns the best-matching tool names and " +
      "descriptions ranked by relevance — call this first to find the exact tool to use, then call that tool.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keywords describing the capability you need (e.g. 'create github issue').",
        },
        limit: { type: "number", description: `Max results to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
      },
      required: ["query"],
      additionalProperties: false,
    },
  };
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export interface RankedTool {
  name: string;
  description: string;
  score: number;
}

/**
 * Pure relevance ranking. Name matches weigh more than description matches, and
 * a whole-query substring of the name is boosted. Returns only positive-scoring
 * tools, highest first, truncated to `limit`.
 */
export function rankTools(query: string, tools: AdvertisedTool[], limit: number): RankedTool[] {
  const q = query.trim().toLowerCase();
  const tokens = tokenize(query);
  if (q.length === 0 || tokens.length === 0) return [];

  const scored: RankedTool[] = [];
  for (const tool of tools) {
    const name = tool.name.toLowerCase();
    const desc = (tool.description ?? "").toLowerCase();
    let score = 0;
    for (const tok of tokens) {
      if (name.includes(tok)) score += 2;
      if (desc.includes(tok)) score += 1;
    }
    // Boost when the full query appears verbatim in the name.
    if (name.includes(q)) score += 3;
    if (score > 0) {
      scored.push({
        name: tool.name,
        description: (tool.description ?? "").slice(0, DESCRIPTION_SNIPPET),
        score,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, Math.max(1, Math.min(limit, MAX_LIMIT)));
}

/**
 * Executes the meta-tool against a snapshot of the caller's scoped tool list.
 * Returns a standard MCP CallTool result whose text is a compact JSON object,
 * so the model can parse the ranked matches directly.
 */
export function runSearchTool(args: Record<string, unknown>, scopedTools: AdvertisedTool[]): ToolCallResult {
  const query = typeof args.query === "string" ? args.query : "";
  if (!query.trim()) {
    return toolResult("search_tools requires a non-empty 'query' string.", { isError: true });
  }
  const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.floor(args.limit) : DEFAULT_LIMIT;
  const matches = rankTools(query, scopedTools, limit).map((m) => ({ name: m.name, description: m.description }));

  return toolResult(JSON.stringify({ query, count: matches.length, matches }, null, 2));
}
