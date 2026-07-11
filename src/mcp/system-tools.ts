/**
 * The /mcp root's tool catalog: system management + data retrieval for the
 * gateway itself, as opposed to the sharded /mcp/:clientName and curated
 * /mcp-custom/:bundleName endpoints, which proxy to registered *backends*.
 * Every handler here is a thin adapter over the same domain functions the
 * REST admin API (src/routes/*.ts) already calls — no new business logic,
 * only a second (LLM-facing) transport onto it.
 *
 * Two independent authorization axes, both enforced in runSystemTool():
 *   - Role tier (`tier`): mirrors this codebase's REST middleware tiers —
 *     "read" ~ adminAuth only, "operate" ~ requireOperator, "admin" ~
 *     requireAdminRole. The caller's tier comes from resolveSystemRole()
 *     (env admin Bearer, or a managed mcp_api_keys row with adminRole set).
 *   - Step-up (`sensitive` / `envBearerOnly`): mutating, destructive, or
 *     credential-minting tools additionally require either an elevated key
 *     (or the literal env Bearer) or an explicit {"__confirm": true} —
 *     the exact mechanism proxy.ts already uses for sensitive backend tools.
 */
import { config } from "../config.js";
import { log } from "../logger.js";
import type { AdminRole } from "../security/user-store.js";
import type { SystemAuthResult } from "../security/system-role.js";
import type { AdvertisedTool } from "./tool-search.js";
import { toolResult, type ToolCallResult } from "../lib/mcp-result.js";
import { registry } from "./registry.js";
import { listBundles } from "../admin/tool-composition/bundles.js";
import { listMcpKeys, createMcpKey, revokeMcpKey, getMcpKey, type McpKeyScopes } from "../security/mcp-key-store.js";
import { isAdminRole } from "../security/user-store.js";
import { getLegacyMetricsSnapshot } from "../observability/metrics.js";
import { listAuditLog, recordAudit } from "../admin/audit/audit.js";
import {
  performRestRegistration,
  performMcpRegistration,
  performGraphqlRegistration,
  type RegisterOutcome,
} from "./registration.js";

export type SystemToolTier = "read" | "operate" | "admin";

// Mirrors requireOperator (admin+operator)/requireAdminRole (admin-only)'s
// exact semantics from middleware/authz.ts — auditor and viewer both land at
// the "read" floor, same as their REST GET-only access.
const ROLE_RANK: Record<AdminRole, number> = { viewer: 0, auditor: 0, operator: 1, admin: 2 };
const TIER_RANK: Record<SystemToolTier, number> = { read: 0, operate: 1, admin: 2 };

function roleMeetsTier(role: AdminRole, tier: SystemToolTier): boolean {
  return ROLE_RANK[role] >= TIER_RANK[tier];
}

/** Stable actor label for the audit log — mirrors audit.ts's actorFromRequest() convention for the env-bearer case. */
function actorFor(auth: SystemAuthResult): string {
  return auth.isEnvBearer ? "bearer:admin-api-key" : `mcp-key:${auth.keyId}`;
}

interface SystemTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  tier: SystemToolTier;
  /** Requires {"__confirm": true} in args, or an elevated key/the env Bearer — same gate proxy.ts applies to sensitive backend tools. */
  sensitive?: boolean;
  /** Requires the literal env admin Bearer — no managed key, however privileged, may do this (no self-escalation). */
  envBearerOnly?: boolean;
  handler: (args: Record<string, unknown>, auth: SystemAuthResult) => Promise<ToolCallResult> | ToolCallResult;
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function bool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  return typeof v === "boolean" ? v : undefined;
}

function json(data: unknown): ToolCallResult {
  return toolResult(JSON.stringify(data, null, 2));
}

const SYSTEM_TOOLS: SystemTool[] = [
  // ── Read tier ────────────────────────────────────────────────────────────
  {
    name: "sys_list_clients",
    description: "List registered backend clients (REST or MCP upstreams), with enable/health status.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Filter by name substring." },
        enabled: { type: "boolean", description: "Filter by enabled state." },
      },
      additionalProperties: false,
    },
    tier: "read",
    handler: (args) => json(registry.listClientsSummary({ q: str(args, "q"), enabled: bool(args, "enabled") })),
  },
  {
    name: "sys_get_client",
    description: "Get full detail for one registered client, including its tools and health.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Client name." } },
      required: ["name"],
      additionalProperties: false,
    },
    tier: "read",
    handler: (args) => {
      const name = str(args, "name");
      if (!name) return toolResult("Missing required argument: name", { isError: true });
      const detail = registry.getClientDetail(name);
      if (!detail) return toolResult(`Client not found: ${name}`, { isError: true });
      return json(detail);
    },
  },
  {
    name: "sys_list_tools",
    description: "List every (client, tool) pair across every registered client, live or not.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    tier: "read",
    handler: () => json(registry.listAllTools()),
  },
  {
    name: "sys_list_bundles",
    description:
      "List admin-curated MCP bundles (cross-client tool + composite selections served at /mcp-custom/:bundleName).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    tier: "read",
    handler: () => json(listBundles()),
  },
  {
    name: "sys_list_keys",
    description: "List managed MCP API keys (metadata only — raw key values are never retrievable after creation).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    tier: "read",
    handler: () => json(listMcpKeys()),
  },
  {
    name: "sys_metrics",
    description: "Snapshot of gateway metrics: uptime, active sessions, tool-call counts, average latency.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    tier: "read",
    handler: () => json(getLegacyMetricsSnapshot()),
  },
  {
    name: "sys_audit_tail",
    description: "Tail the admin audit log (most recent entries first).",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "Max entries to return (default 50, max 200)." } },
      additionalProperties: false,
    },
    tier: "read",
    handler: (args) => json(listAuditLog({ limit: num(args, "limit") })),
  },

  // ── Operate tier ─────────────────────────────────────────────────────────
  {
    name: "sys_set_client_enabled",
    description: "Enable or disable a registered client (all its tools become unreachable while disabled).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        enabled: { type: "boolean" },
      },
      required: ["name", "enabled"],
      additionalProperties: false,
    },
    tier: "operate",
    handler: async (args, auth) => {
      const name = str(args, "name");
      const enabled = bool(args, "enabled");
      if (!name || enabled === undefined)
        return toolResult("Missing required argument: name, enabled", { isError: true });
      const ok = await registry.setClientEnabled(name, enabled);
      if (!ok) return toolResult(`Client not found: ${name}`, { isError: true });
      recordAudit(actorFor(auth), enabled ? "client.enable" : "client.disable", name);
      return toolResult(`Client '${name}' ${enabled ? "enabled" : "disabled"}`);
    },
  },
  {
    name: "sys_set_tool_enabled",
    description: "Enable or disable a single tool on a registered client.",
    inputSchema: {
      type: "object",
      properties: {
        client: { type: "string" },
        tool: { type: "string" },
        enabled: { type: "boolean" },
      },
      required: ["client", "tool", "enabled"],
      additionalProperties: false,
    },
    tier: "operate",
    handler: async (args, auth) => {
      const client = str(args, "client");
      const tool = str(args, "tool");
      const enabled = bool(args, "enabled");
      if (!client || !tool || enabled === undefined) {
        return toolResult("Missing required argument: client, tool, enabled", { isError: true });
      }
      const ok = await registry.setToolEnabled(client, tool, enabled);
      if (!ok) return toolResult(`Tool not found: ${client}__${tool}`, { isError: true });
      recordAudit(actorFor(auth), enabled ? "tool.enable" : "tool.disable", `${client}__${tool}`);
      return toolResult(`Tool '${client}__${tool}' ${enabled ? "enabled" : "disabled"}`);
    },
  },
  {
    name: "sys_reset_circuit_breaker",
    description: "Force a live client's circuit breaker back to closed.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    tier: "operate",
    handler: (args, auth) => {
      const name = str(args, "name");
      if (!name) return toolResult("Missing required argument: name", { isError: true });
      const ok = registry.resetCircuitBreaker(name);
      if (!ok) return toolResult(`Client is not currently live: ${name}`, { isError: true });
      recordAudit(actorFor(auth), "client.circuit_breaker.reset", name);
      return toolResult(`Circuit breaker reset for '${name}'`);
    },
  },
  {
    name: "sys_register_client",
    description:
      "Register a new backend client — REST/OpenAPI (name + tools[] or openapi_url), an MCP upstream (kind:'mcp', mcp_url), " +
      "or GraphQL (kind:'graphql', graphql_url). Mirrors POST /register's body shape exactly. Touches the network (SSRF-validated) " +
      'and adds a new call target, so this is sensitive: pass {"__confirm": true} or use an elevated credential.',
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        kind: { type: "string", enum: ["rest", "mcp", "graphql"] },
        tools: { type: "array", description: "REST manual tool list." },
        openapi_url: { type: "string" },
        health_url: { type: "string" },
        mcp_url: { type: "string" },
        mcp_transport: { type: "string" },
        graphql_url: { type: "string" },
        __confirm: { type: "boolean" },
      },
      required: ["name"],
      additionalProperties: true,
    },
    tier: "operate",
    sensitive: true,
    handler: async (args, auth) => {
      // Mirrors routes/register.ts's "Change B" — that cap is enforced by
      // the REST route itself, before it ever reaches registration.ts, so
      // performRestRegistration's own cap check only covers the curl/postman
      // branches (see its doc comment). This MCP path calls
      // performRestRegistration directly and would otherwise skip the cap
      // entirely for a hand-written tools[] array.
      if (Array.isArray(args.tools) && args.tools.length > config.maxToolsPerClient) {
        return toolResult(`tools[] exceeds maximum of ${config.maxToolsPerClient}`, { isError: true });
      }
      const peerIp = undefined;
      const requestId = null;
      let outcome: RegisterOutcome;
      if (args.kind === "mcp" || typeof args.mcp_url === "string") {
        outcome = await performMcpRegistration(args, peerIp, requestId);
      } else if (args.kind === "graphql" || typeof args.graphql_url === "string") {
        outcome = await performGraphqlRegistration(args, peerIp, requestId);
      } else {
        outcome = await performRestRegistration(args, peerIp, requestId);
      }
      if (outcome.ok)
        recordAudit(actorFor(auth), "client.register", str(args, "name") ?? "", { source: outcome.body.source });
      return json(outcome.body);
    },
  },
  {
    name: "sys_delete_client",
    description:
      "Permanently forget a registered client: tears down its live state and purges its SQLite config (tools, guards). " +
      'Destructive — pass {"__confirm": true} or use an elevated credential.',
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, __confirm: { type: "boolean" } },
      required: ["name"],
      additionalProperties: false,
    },
    tier: "operate",
    sensitive: true,
    handler: async (args, auth) => {
      const name = str(args, "name");
      if (!name) return toolResult("Missing required argument: name", { isError: true });
      const ok = await registry.forgetClient(name);
      if (!ok) return toolResult(`Client not found: ${name}`, { isError: true });
      recordAudit(actorFor(auth), "client.delete", name);
      return toolResult(`Client '${name}' deleted`);
    },
  },

  // ── Admin tier ───────────────────────────────────────────────────────────
  {
    name: "sys_mint_key",
    description:
      "Mint a new managed MCP API key. Requires the environment admin Bearer credential specifically — no managed key, " +
      'however privileged, may mint another (no self-escalation). Destructive/sensitive: pass {"__confirm": true}.',
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string" },
        scopes: { type: "object", description: "{clients?: string[], tools?: string[]} — omit for unrestricted." },
        expiresAt: { type: "number", description: "Epoch ms, or omit for no expiry." },
        elevated: { type: "boolean" },
        adminRole: { type: "string", enum: ["admin", "operator", "auditor", "viewer"] },
        __confirm: { type: "boolean" },
      },
      required: ["label"],
      additionalProperties: false,
    },
    tier: "admin",
    sensitive: true,
    envBearerOnly: true,
    handler: (args, auth) => {
      const label = str(args, "label");
      if (!label) return toolResult("Missing required argument: label", { isError: true });
      const scopesRaw = args.scopes;
      const scopes: McpKeyScopes | null =
        scopesRaw && typeof scopesRaw === "object" && !Array.isArray(scopesRaw) ? (scopesRaw as McpKeyScopes) : null;
      const adminRoleRaw = args.adminRole;
      const adminRole = isAdminRole(adminRoleRaw) ? adminRoleRaw : null;
      const { record, rawKey } = createMcpKey(
        label,
        scopes,
        num(args, "expiresAt") ?? null,
        actorFor(auth),
        null,
        bool(args, "elevated") ?? false,
        adminRole,
      );
      recordAudit(actorFor(auth), "mcp_key.create", String(record.id), { label, adminRole: adminRole ?? undefined });
      // The raw key is returned exactly once, here — it is never persisted or retrievable again.
      return json({ ...record, key: rawKey });
    },
  },
  {
    name: "sys_revoke_key",
    description:
      'Revoke a managed MCP API key by id. Destructive: pass {"__confirm": true} or use an elevated credential.',
    inputSchema: {
      type: "object",
      properties: { id: { type: "number" }, __confirm: { type: "boolean" } },
      required: ["id"],
      additionalProperties: false,
    },
    tier: "admin",
    sensitive: true,
    handler: (args, auth) => {
      const id = num(args, "id");
      if (id === undefined) return toolResult("Missing required argument: id", { isError: true });
      if (!getMcpKey(id)) return toolResult(`API key not found: ${id}`, { isError: true });
      const ok = revokeMcpKey(id);
      if (!ok) return toolResult(`API key ${id} is already revoked`, { isError: true });
      recordAudit(actorFor(auth), "mcp_key.revoke", String(id));
      return toolResult(`API key ${id} revoked`);
    },
  },
];

const toolByName = new Map(SYSTEM_TOOLS.map((t) => [t.name, t]));

/** Tools/list for the /mcp system scope, filtered to what `role` may see — the only place tier decides *visibility*. */
export function listSystemTools(role: AdminRole): AdvertisedTool[] {
  return SYSTEM_TOOLS.filter((t) => roleMeetsTier(role, t.tier)).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

/** Dispatches a system tool call under `auth`'s resolved role — the tools/call counterpart to listSystemTools. */
export async function runSystemTool(
  name: string,
  args: Record<string, unknown>,
  auth: SystemAuthResult,
): Promise<ToolCallResult> {
  const tool = toolByName.get(name);
  if (!tool) return toolResult(`Unknown tool: ${name}`, { isError: true });

  if (!roleMeetsTier(auth.role, tool.tier)) {
    return toolResult(`Tool '${name}' requires the '${tool.tier}' tier or higher`, { isError: true });
  }
  if (tool.envBearerOnly && !auth.isEnvBearer) {
    return toolResult(`Tool '${name}' requires the environment admin Bearer credential`, { isError: true });
  }
  if (tool.sensitive) {
    const confirmed = args.__confirm === true;
    if (!confirmed && !auth.elevated) {
      return toolResult(
        `Tool '${name}' is sensitive — pass {"__confirm": true} in arguments or call with an elevated key.`,
        { isError: true },
      );
    }
  }

  try {
    return await tool.handler(args, auth);
  } catch (err) {
    // Unlike a handler's own explicit toolResult(..., {isError:true}) returns
    // (expected, caller-facing failures — not-found, validation, etc.), a
    // *thrown* exception here is unexpected — mirror index.ts's global error
    // handler's is5xx behavior and never echo it verbatim to the MCP caller;
    // log the real error server-side instead.
    log("error", `System tool '${name}' failed unexpectedly`, {
      tool: name,
      err: err instanceof Error ? { message: err.message, stack: err.stack, name: err.name } : err,
    });
    return toolResult(`Tool '${name}' failed unexpectedly`, { isError: true });
  }
}
