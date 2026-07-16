/**
 * registry-read-models.ts — SQL-backed admin read-models split out of the
 * live Registry class.
 *
 * listClientsSummaryReadModel / listAllToolsReadModel / getClientDetailReadModel
 * back the admin UI's client list/detail views and the bundle tool-picker.
 * All three only need the live `clients` map (for health/breaker-state
 * merging, where applicable) plus SQLite + the various per-tool-meta lookup
 * modules — no other Registry state or private methods — so they live here
 * as standalone functions rather than class methods.
 * `Registry.listClientsSummary`/`listAllTools`/`getClientDetail` are thin
 * delegating wrappers (see registry.ts) that pass `this.clients` through,
 * preserving their existing public names/signatures for the ~56+ call sites
 * across src/routes/, src/admin/, and tests.
 */
import { getDb } from "../db/connection.js";
import { getAllCircuitStates } from "../middleware/circuit-breaker.js";
import { getTagsForClient, getAllToolTags } from "../tool-meta/tool-tags.js";
import { getSensitivityForClient } from "../tool-meta/tool-sensitivity.js";
import { getRedactionForClient } from "../content-filtering/redaction.js";
import { getGuardrailsForClient } from "../tool-policies/guardrails.js";
import { getCoalesceForClient } from "../tool-policies/coalesce.js";
import { getApprovalConfigForClient } from "../admin/entities/approvals.js";
import { getQuarantineForClient } from "../tool-policies/quarantine.js";
import { getWsForClient, getGraphqlForClient } from "../proxy/backends.js";
import { getContextBudgetForClient } from "../tool-policies/context-budget.js";
import {
  rowToClientGuards,
  rowToToolGuards,
  rowToToolOverride,
  type ClientGuardRow,
  type ToolGuardRow,
  type ToolOverrideRow,
} from "./registry-persistence.js";
import type { ClientGuardConfig, ClientStatus, RegisteredClient, RegisteredTool, UpstreamKind } from "./types.js";

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

export interface ListClientsSummaryOpts {
  q?: string;
  enabled?: boolean;
  status?: ClientStatus;
  cursor?: string;
  limit?: number;
  teamId?: number | null;
}

export interface ToolListItem {
  client: string;
  tool: string;
  description: string;
  enabled: boolean;
  clientEnabled: boolean;
  tags: string[];
}

/**
 * Paginated (keyset, by name), searchable client listing for the admin UI.
 * `status` is applied as a post-filter over the returned page (health status
 * is in-memory-only/ephemeral, not a SQL column), so a status-filtered page
 * may return fewer than `limit` items — acceptable for an admin list view.
 */
export function listClientsSummaryReadModel(
  clients: Map<string, RegisteredClient>,
  opts: ListClientsSummaryOpts = {},
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
    const live = clients.get(r.name);
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
 *
 * Tenancy scoping: when `teamId` is a number, only tools belonging to that
 * team's clients are returned — same `c.team_id = ?` rule as
 * listClientsSummaryReadModel/canAccessClient (exact match; a team-scoped
 * caller does not see unowned/null-team clients). `undefined` (the default)
 * means unrestricted — callers must pass a real team id or leave it
 * undefined for a super-admin/bearer caller; never pass through an
 * unvalidated value.
 */
export function listAllToolsReadModel(teamId?: number): ToolListItem[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: number[] = [];
  if (typeof teamId === "number") {
    conditions.push("c.team_id = ?");
    params.push(teamId);
  }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = db
    .query(
      `SELECT c.name as client_name, c.enabled as client_enabled, t.name as tool_name, t.description, t.enabled
       FROM tools t JOIN clients c ON c.name = t.client_name
       ${whereClause}
       ORDER BY c.name, t.name`,
    )
    .all(...params) as {
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

/** Per-(client,tool) admin metadata maps threaded into withToolMeta below. */
interface ToolMetaMaps {
  tagMap: ReturnType<typeof getTagsForClient>;
  sensMap: ReturnType<typeof getSensitivityForClient>;
  redactMap: ReturnType<typeof getRedactionForClient>;
  guardrailMap: ReturnType<typeof getGuardrailsForClient>;
  coalesceMap: ReturnType<typeof getCoalesceForClient>;
  approvalMap: ReturnType<typeof getApprovalConfigForClient>;
  quarantineMap: ReturnType<typeof getQuarantineForClient>;
  wsMap: ReturnType<typeof getWsForClient>;
  graphqlMap: ReturnType<typeof getGraphqlForClient>;
  contextBudgetMap: ReturnType<typeof getContextBudgetForClient>;
}

/**
 * Merges the per-tool admin metadata maps onto a base tool shape. Shared by
 * getClientDetailReadModel's live and not-live branches, which previously
 * built the same 11-field merge as two independent inline object literals.
 */
function withToolMeta(base: RegisteredTool, toolName: string, maps: ToolMetaMaps): RegisteredTool {
  return {
    ...base,
    tags: maps.tagMap[toolName] ?? [],
    sensitive: maps.sensMap[toolName] ?? null,
    redactPaths: maps.redactMap[toolName] ?? [],
    guardrails: maps.guardrailMap[toolName],
    coalesce: maps.coalesceMap[toolName],
    approval: maps.approvalMap[toolName],
    quarantine: maps.quarantineMap[toolName],
    ws: maps.wsMap[toolName],
    graphql: maps.graphqlMap[toolName],
    contextBudget: maps.contextBudgetMap[toolName],
  };
}

/** Full detail for one client — tools with guards, health, circuit-breaker state. Undefined if never registered. */
export function getClientDetailReadModel(
  clients: Map<string, RegisteredClient>,
  name: string,
): ClientDetail | undefined {
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

  const live = clients.get(name);
  const guardRow = db
    .query(
      `SELECT cb_failure_threshold, cb_reset_timeout_ms, cb_half_open_timeout_ms, cb_window_ms, extra_json FROM client_guards WHERE client_name = ?`,
    )
    .get(name) as ClientGuardRow | null;

  const maps: ToolMetaMaps = {
    tagMap: getTagsForClient(name),
    sensMap: getSensitivityForClient(name),
    redactMap: getRedactionForClient(name),
    guardrailMap: getGuardrailsForClient(name),
    coalesceMap: getCoalesceForClient(name),
    approvalMap: getApprovalConfigForClient(name),
    quarantineMap: getQuarantineForClient(name),
    wsMap: getWsForClient(name),
    graphqlMap: getGraphqlForClient(name),
    contextBudgetMap: getContextBudgetForClient(name),
  };

  let tools: RegisteredTool[];
  if (live) {
    tools = live.tools.map((t) => withToolMeta(t, t.name, maps));
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
      const base: RegisteredTool = {
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
      return withToolMeta(base, t.name, maps);
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
