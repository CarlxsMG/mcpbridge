/**
 * The /mcp root's tool catalog: system management + data retrieval for the
 * gateway itself, as opposed to the sharded /mcp/:clientName and curated
 * /mcp-custom/:bundleName endpoints, which proxy to registered *backends*.
 * Every handler here is a thin adapter over the same domain functions the
 * REST admin API (src/routes/*.ts) already calls — no new business logic,
 * only a second (LLM-facing) transport onto it.
 *
 * Three independent authorization axes, all enforced in runSystemTool():
 *   - Role tier (`tier`): mirrors this codebase's REST middleware tiers —
 *     "read" ~ adminAuth only, "operate" ~ requireOperator, "admin" ~
 *     requireAdminRole. The caller's tier comes from resolveSystemRole()
 *     (env admin Bearer, or a managed mcp_api_keys row with adminRole set).
 *   - Step-up (`sensitive` / `envBearerOnly`): mutating, destructive, or
 *     credential-minting tools additionally require either an elevated key
 *     (or the literal env Bearer) or an explicit {"__confirm": true} —
 *     the exact mechanism proxy.ts already uses for sensitive backend tools.
 *   - Key scope (`scope`): a managed key's own `scopes` confine it here
 *     exactly as they confine it on the data plane. Declared per tool as a
 *     REQUIRED field and enforced centrally — see SystemToolScope.
 */
import { config } from "../config.js";
import { log } from "../logger.js";
import type { AdminRole } from "../security/user-store.js";
import type { SystemAuthResult } from "../security/system-role.js";
import type { AdvertisedTool } from "./tool-search.js";
import { toolResult, type ToolCallResult } from "../lib/mcp-result.js";
import { checkConfirmGate } from "../proxy/gates.js";
import { registry } from "./registry.js";
import { toolKey, TOOL_KEY_SEPARATOR } from "../lib/identifier.js";
import { listBundles, createBundle, getBundleDetail, type BundleToolRef } from "../admin/tool-composition/bundles.js";
import { applyToolMutations } from "../admin/tool-policies/mutations/index.js";
import {
  listMcpKeys,
  createMcpKey,
  revokeMcpKey,
  getMcpKey,
  isToolInKeyScope,
  isClientInKeyScope,
  type McpKeyScopes,
} from "../security/mcp-key-store.js";
import { isAdminRole } from "../security/user-store.js";
import { getLegacyMetricsSnapshot } from "../observability/metrics.js";
import { listTraffic } from "../observability/traffic.js";
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

/**
 * The caller's key scopes, resolved ONCE per runSystemTool() invocation and
 * threaded into the gate and the handlers.
 *
 * There is no TEAM axis to mirror here: `mcp_api_keys` carries no team_id, and
 * only a super-admin may mint a key with `adminRole` at all (see
 * routes/admin/mcp-keys.ts's POST gate), so in the team dimension every /mcp
 * caller is already what `ensureClientAccess` calls a super-admin. What a
 * managed key CAN still carry is `scopes`, which on the data plane is "the ONLY
 * thing confining it to a set of clients" (same file). A key confined to one
 * client must therefore not reach another one from the control plane either, or
 * this surface hands back exactly the reach `checkKeyScopeGate` denies it on
 * /mcp/:clientName.
 *
 * THIS IS NOT A CACHE, and must not become one. The row is still read from the
 * store on every single /mcp tools/call — the "never trust a stale grant"
 * posture proxy.ts applies to isToolInKeyScope, which is what makes a revoked
 * or re-scoped key take effect on the caller's very next call, and what makes a
 * key row that has vanished resolve to "denied" rather than to "unconfined".
 * What resolving once removes is only the repetition WITHIN one invocation:
 * these predicates run inside listing filters, so sys_list_tools on a
 * thousand-tool gateway used to issue a thousand identical point queries (each
 * with its own JSON.parse of `scopes_json`) to answer one call. Holding the row
 * across invocations instead would re-open exactly the stale-authorization hole
 * the per-call read exists to close.
 */
type CallerScope =
  /** Nothing to narrow by: the env admin Bearer (or AUTH_DISABLED), or a managed key with `scopes` null. */
  | { kind: "unconfined" }
  /** A managed key carrying a real `scopes` object; every target is checked against it. */
  | { kind: "confined"; scopes: McpKeyScopes }
  /** The key row was gone at dispatch time (deleted/revoked mid-session) — fail closed on every target. */
  | { kind: "denied" };

function resolveCallerScope(auth: SystemAuthResult): CallerScope {
  // No key row at all: the env admin Bearer (or AUTH_DISABLED). Nothing to
  // narrow by, same as a REST bearer caller.
  if (auth.keyId === null) return { kind: "unconfined" };
  const key = getMcpKey(auth.keyId);
  if (!key) return { kind: "denied" };
  return key.scopes ? { kind: "confined", scopes: key.scopes } : { kind: "unconfined" };
}

/** The tenancy check for a control-plane caller acting on one client's tool. */
function callerMayTouchTool(scope: CallerScope, clientName: string, toolName: string): boolean {
  if (scope.kind === "denied") return false;
  if (scope.kind === "unconfined") return true;
  return isToolInKeyScope(scope.scopes, clientName, toolKey(clientName, toolName));
}

/**
 * The same check one level up, for a tool whose blast radius is a WHOLE client:
 * its detail document (every tool, base_url, resolved_ip, whether an allowlist
 * is in force), its enable flag, its breaker, its existence.
 *
 * The narrowing is `scopes.clients` alone — deliberately NOT the tool-level
 * check above, which also passes on a `scopes.tools` grant. A key granted one
 * tool was granted that tool, not authority over the client that owns it, so it
 * must not be able to read, disable or delete everything sitting alongside it.
 * ws-proxy.ts applies the same rule to a whole ws target through the same
 * isClientInKeyScope. The consequence to know: a tools-only key sees its own
 * pairs from sys_list_tools but no client row from sys_list_clients, because a
 * client row is a client-level fact.
 */
function callerMayTouchClient(scope: CallerScope, clientName: string): boolean {
  if (scope.kind === "denied") return false;
  if (scope.kind === "unconfined") return true;
  return isClientInKeyScope(scope.scopes, clientName);
}

/**
 * callerMayTouchClient's rule expressed as the finite set of names it admits,
 * or undefined for "no narrowing" — so a client-level LISTING can push it into
 * SQL instead of applying it to the rows a paginated read model already chose.
 *
 * Post-filtering that page is a false-empty bug, not merely a slow answer: the
 * read model applies a default LIMIT, so on a gateway with more clients than
 * one page holds, every row of page one can be dropped and the caller told it
 * has no servers at all. An LLM caller believes that. Neither raising the limit
 * nor exposing the cursor fixes it — the first moves the same cliff to a larger
 * N, and the second makes the caller page through rows it may not see, guided
 * by a nextCursor computed over a stranger's listing.
 *
 * An absent or empty `scopes.clients` yields an EMPTY list rather than
 * undefined: a key holding only per-tool grants has no client-level authority
 * at all (see callerMayTouchClient), so it must see no client rows.
 */
function scopedClientNames(scope: CallerScope): string[] | undefined {
  if (scope.kind === "unconfined") return undefined;
  if (scope.kind === "denied") return [];
  return scope.scopes.clients ?? [];
}

/**
 * The single answer a caller gets for a tool it may not act on, whichever
 * reason applies: outside its key's scope, or not registered at all. Same
 * contract as `ensureClientAccess`'s 404 and mcp-server.ts's `Unknown tool:`
 * scope branches — a caller that cannot reach a tool must not learn whether it
 * exists. Deliberately carries no denyCode, for the reason spelled out at those
 * sites and pinned by scope-refusal-is-opaque.test.ts.
 */
function toolUnavailable(clientName: string, toolName: string): ToolCallResult {
  return toolResult(`Tool not found: ${toolKey(clientName, toolName)}`, { isError: true });
}

/**
 * The two client-level refusals. Each is defined once and used BOTH by its
 * handler's own not-found path AND by that tool's `scope` declaration, so
 * "outside your scope" and "no such client" are the same bytes by construction.
 * A comment asking the next editor to keep two literals in sync would not
 * survive; sharing the function does.
 */
function clientNotFound(name: string): ToolCallResult {
  return toolResult(`Client not found: ${name}`, { isError: true });
}

/** Reset-breaker's refusal: registry.resetCircuitBreaker cannot distinguish "unknown" from "not live" either. */
function clientNotLive(name: string): ToolCallResult {
  return toolResult(`Client is not currently live: ${name}`, { isError: true });
}

/**
 * sys_register_client's scope refusal, and the one place on this surface that
 * may name the reason out loud: registration runs no existence check ahead of
 * the gate (POST /register has no client-name-collision check at all — see
 * registration.ts, which only rejects a collision with a ws-proxy target), so
 * this answer is returned for every name equally and reveals nothing but the
 * caller's own scope. If a collision check is ever added AHEAD of this gate,
 * this message turns into an existence oracle and has to collapse into
 * clientNotFound's shared wording.
 */
function clientOutsideScope(name: string): ToolCallResult {
  return toolResult(`Client '${name}' is outside this credential's scope`, { isError: true });
}

/**
 * Splits a `clientName__toolName` key. The first separator occurrence is the
 * boundary: registration rejects `__` inside either half (registry.ts), so a
 * valid key has exactly one.
 */
function splitToolKey(key: string): BundleToolRef | undefined {
  const at = key.indexOf(TOOL_KEY_SEPARATOR);
  if (at <= 0) return undefined;
  const tool = key.slice(at + TOOL_KEY_SEPARATOR.length);
  return tool ? { client: key.slice(0, at), tool } : undefined;
}

/** How far back sys_diagnose summarises denials when the caller doesn't say, and the ceiling it clamps to. */
const DIAGNOSE_DEFAULT_WINDOW_MS = 15 * 60_000;
const DIAGNOSE_MAX_WINDOW_MS = 24 * 60 * 60_000;
/**
 * Traffic rows sys_diagnose scans for the window above — a summary, not a log
 * dump. The cap applies to the newest rows BEFORE the window filter, which is
 * why the report says `sampled`/`truncated` instead of claiming a total.
 */
const DIAGNOSE_SCAN_LIMIT = 200;
/** How many individual denials sys_diagnose echoes alongside the per-code counts. */
const DIAGNOSE_LATEST_SAMPLE = 5;

export type SystemToolScopeDimension = "none" | "client" | "tool" | "handler";

/**
 * What a tool's arguments name in the one dimension a managed key can be
 * narrowed by (`mcp_api_keys.scopes`), so runSystemTool can apply the gate
 * itself instead of trusting fifteen handlers to remember it.
 *
 * The field is REQUIRED for the same reason `ToolMutation.read` is in
 * admin/tool-policies/mutations: a new tool does not compile until its author
 * answers the question, and answering "nothing to narrow by" has to be written
 * down where a reviewer reads it. That matters here specifically because half
 * this surface once shipped with no check at all while three tools added
 * alongside it each carried one — same arguments, same tier, same blast radius,
 * and nothing anywhere asked why one was gated and its neighbour wasn't.
 */
type SystemToolScope =
  /** Names neither a client nor a tool. `why` is what a reviewer checks. */
  | { dimension: "none"; why: string }
  /**
   * Whole-client blast radius; `clientArg` is the argument holding the name.
   * `refuse` MUST be the same function the handler uses for its own not-found
   * answer — see clientNotFound.
   */
  | { dimension: "client"; clientArg: string; refuse: (clientName: string) => ToolCallResult }
  /** One (client, tool) pair. The refusal is always toolUnavailable, for the reason written there. */
  | { dimension: "tool"; clientArg: string; toolArg: string }
  /**
   * The handler narrows for itself — because one call names many targets, or
   * because it filters a listing rather than refusing it. `why` says which.
   */
  | { dimension: "handler"; why: string };

interface SystemTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  tier: SystemToolTier;
  /** Which tenancy dimension this tool's arguments name — enforced in runSystemTool, never in the handler. */
  scope: SystemToolScope;
  /** Requires {"__confirm": true} in args, or an elevated key/the env Bearer — same gate proxy.ts applies to sensitive backend tools. */
  sensitive?: boolean;
  /** Requires the literal env admin Bearer — no managed key, however privileged, may do this (no self-escalation). */
  envBearerOnly?: boolean;
  /**
   * `scope` is the caller's key scopes, already resolved by runSystemTool — a
   * `dimension: "handler"` tool narrows with it instead of re-reading the key
   * row per row. See CallerScope for why resolving it once is not caching it.
   */
  handler: (
    args: Record<string, unknown>,
    auth: SystemAuthResult,
    scope: CallerScope,
  ) => Promise<ToolCallResult> | ToolCallResult;
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
    description:
      "List registered backend clients (REST or MCP upstreams), with enable/health status. Paged: a `nextCursor` in " +
      "the response means there are MORE clients than were returned. Do not report the listing as complete until a " +
      "response comes back without one — call again with `cursor` set to that value.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Filter by name substring." },
        enabled: { type: "boolean", description: "Filter by enabled state." },
        limit: { type: "number", description: "Max clients to return (default 50, max 200)." },
        cursor: {
          type: "string",
          description: "The `nextCursor` from a previous call. Omit for the first page.",
        },
      },
      additionalProperties: false,
    },
    tier: "read",
    scope: {
      dimension: "handler",
      why: "An enumeration, so it narrows rather than refuses: the key's own client list becomes part of the read model's query, and rows outside it never exist as far as this caller is concerned.",
    },
    // The narrowing is pushed INTO the read model's WHERE clause (see
    // ListClientsSummaryOpts.names), never applied to the page it hands back.
    // A post-filter over that page answers "you have no clients" whenever the
    // caller's clients all sort behind the first page's worth of names — a
    // false empty, which for an LLM caller is worse than a slow answer because
    // it will simply believe it. Exposing the cursor does not make a
    // post-filter safe either: it would still hand back short or empty pages
    // and a nextCursor describing a STRANGER's listing, so a caller walking to
    // exhaustion would page through rows it may not see to find its own.
    // Filtering in SQL is what makes the page boundary and the scope agree.
    //
    // `cursor`/`limit` are exposed because the read model pages regardless: a
    // caller with more in-scope clients than one page holds must be able to
    // finish the walk. Leaving them off did not hide the paging, it only left
    // the nextCursor unfollowable — the same "believes an incomplete answer"
    // failure as the false empty, one page further out.
    handler: (args, _auth, scope) =>
      json(
        registry.listClientsSummary({
          q: str(args, "q"),
          enabled: bool(args, "enabled"),
          limit: num(args, "limit"),
          cursor: str(args, "cursor"),
          names: scopedClientNames(scope),
        }),
      ),
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
    // Client dimension rather than tool: the detail document is the whole
    // client — every tool name, base_url, resolved_ip, and whether a per-tool
    // key allowlist is in force.
    scope: { dimension: "client", clientArg: "name", refuse: clientNotFound },
    handler: (args) => {
      const name = str(args, "name");
      if (!name) return toolResult("Missing required argument: name", { isError: true });
      const detail = registry.getClientDetail(name);
      if (!detail) return clientNotFound(name);
      return json(detail);
    },
  },
  {
    name: "sys_list_tools",
    description: "List every (client, tool) pair across every registered client, live or not.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    tier: "read",
    scope: {
      dimension: "handler",
      why: "An enumeration, filtered per pair — a `scopes.tools` grant is enough to see its own pair here.",
    },
    // A post-filter is sound HERE, unlike in sys_list_clients above, because
    // listAllToolsReadModel takes no limit and no cursor: it returns every
    // (client, tool) row there is, so dropping rows can never hide the ones
    // that remain behind a page boundary. If that read model ever gains
    // pagination, this filter has to move into its query the same way.
    handler: (_args, _auth, scope) =>
      json(registry.listAllTools().filter((t) => callerMayTouchTool(scope, t.client, t.tool))),
  },
  {
    name: "sys_list_bundles",
    description:
      "List admin-curated MCP bundles (cross-client tool + composite selections served at /mcp-custom/:bundleName).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    tier: "read",
    scope: {
      dimension: "none",
      why: "A bundle is a cross-client curation with no owning client, and BundleSummary carries name/description/counts only — no client or tool names. getBundleDetail, which does carry them, is not reachable from here.",
    },
    handler: () => json(listBundles()),
  },
  {
    name: "sys_list_keys",
    description: "List managed MCP API keys (metadata only — raw key values are never retrievable after creation).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    tier: "read",
    // NOTE: a key record carries its own `scopes`, so client NAMES do appear in
    // this listing — a scoped caller can read the client names other keys are
    // confined to. Narrowing that is not a scope check on an argument (there is
    // no argument): it needs a decision about whether a scoped key should see
    // the key inventory at all, which is bigger than this gate.
    scope: { dimension: "none", why: "Names no client or tool — a key id/label is its own namespace." },
    handler: () => json(listMcpKeys()),
  },
  {
    name: "sys_metrics",
    description: "Snapshot of gateway metrics: uptime, active sessions, tool-call counts, average latency.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    tier: "read",
    scope: {
      dimension: "none",
      why: "Gateway-wide aggregate (uptime, session and call counters, average latency) — no per-client or per-tool identity in the snapshot.",
    },
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
    // NOTE: no argument names a client, but the ROWS do — an audit target is
    // often `client` or `client__tool`. A scoped caller therefore still reads
    // other clients' audit targets here. Filtering would mean parsing `target`
    // strings, which is exactly the fragile prefix-matching mcp-server.ts's
    // confused-deputy fix removed; the durable fix is a client column on
    // audit_log, which is a migration, not a gate.
    scope: { dimension: "none", why: "Takes only a row limit — no client or tool argument to narrow by." },
    handler: (args) => json(listAuditLog({ limit: num(args, "limit") })),
  },

  // ── Operate tier ─────────────────────────────────────────────────────────
  {
    name: "sys_diagnose",
    description:
      "Explain why calls to one tool are currently refused or failing: the client's enable/health/circuit-breaker state, the " +
      "tool's enable flag, the guard values in force, and the deny codes its recent calls actually hit. Read-only. The denial " +
      "counts are a capped sample of the newest captured errors, newest first — `truncated: true` means older denials inside " +
      "the window were never counted, so treat `sampled` as a floor and narrow `windowMs` for an exact picture. The per-tool " +
      "key allowlist is reported as in force or not, never evaluated for the calling credential — a system tool is handed a " +
      "resolved role, never a raw token to hash against the allowlist.",
    inputSchema: {
      type: "object",
      properties: {
        client: { type: "string" },
        tool: { type: "string" },
        windowMs: {
          type: "number",
          description: `How far back to summarise denials (default ${DIAGNOSE_DEFAULT_WINDOW_MS} ms, clamped to ${DIAGNOSE_MAX_WINDOW_MS} ms).`,
        },
      },
      required: ["client", "tool"],
      additionalProperties: false,
    },
    // Operate rather than read for one reason only: the deny-code summary is
    // the traffic explorer's data, and GET /admin-api/traffic is requireOperator
    // for exactly that reason — per-call records of who was refused and why are
    // operational data, not audit-read data. Dropping this to "read" would hand
    // that traffic view to every auditor and viewer key, which is the thing to
    // weigh, and it would also put this tool out of step with the REST route
    // serving the same rows. What it is NOT is the only thing standing between a
    // read-tier caller and existence information: sys_get_client and
    // sys_list_tools are read tier and report on a named client too. Existence
    // is confined by the key-scope gate below, at every tier alike.
    tier: "operate",
    scope: { dimension: "tool", clientArg: "client", toolArg: "tool" },
    handler: (args) => {
      const client = str(args, "client");
      const tool = str(args, "tool");
      if (!client || !tool) return toolResult("Missing required argument: client, tool", { isError: true });

      const detail = registry.getClientDetail(client);
      const registered = detail?.tools.find((t) => t.name === tool);
      if (!detail || !registered) return toolUnavailable(client, tool);

      const windowMs = Math.min(
        Math.max(num(args, "windowMs") ?? DIAGNOSE_DEFAULT_WINDOW_MS, 1_000),
        DIAGNOSE_MAX_WINDOW_MS,
      );
      const since = Date.now() - windowMs;
      // Denials only exist to be read back when traffic capture is on (it is
      // opt-in), so report that flag rather than an empty list that would read
      // as "nothing was refused".
      const scanned = config.trafficCaptureEnabled
        ? listTraffic({
            clientName: client,
            toolName: tool,
            errorsOnly: true,
            limit: DIAGNOSE_SCAN_LIMIT,
          }).items
        : [];
      const denials = scanned.filter((r) => r.denyCode !== null && r.createdAt >= since);
      // The scan is newest-first and capped BEFORE the window filter, so a full
      // page means older rows inside the window were never looked at: the counts
      // below describe a sample, not the window. Hence `sampled`, not `total` —
      // a field called `total` reading 200 for a tool that failed 5,000 times is
      // a number an operator will reason from and be wrong.
      const truncated = scanned.length >= DIAGNOSE_SCAN_LIMIT;
      // Null-prototype: keyed by a value read back out of storage.
      const byCode: Record<string, number> = Object.create(null) as Record<string, number>;
      for (const d of denials) {
        if (d.denyCode !== null) byCode[d.denyCode] = (byCode[d.denyCode] ?? 0) + 1;
      }

      return json({
        tool: toolKey(client, tool),
        client: {
          name: detail.name,
          enabled: detail.enabled,
          live: detail.live,
          status: detail.status,
          circuitBreakerState: detail.circuitBreakerState,
          consecutiveFailures: detail.consecutiveFailures,
        },
        toolEnabled: registered.enabled,
        guards: {
          rateLimitPerMin: registered.guards?.rateLimitPerMin ?? null,
          timeoutMs: registered.guards?.timeoutMs ?? null,
          // The hashes themselves are never returned; whether a restriction is
          // in force is the part that explains an `allowed_key` denial.
          allowedKeyRestricted: (registered.guards?.allowedKeyHashes?.length ?? 0) > 0,
        },
        recentDenials: {
          captureEnabled: config.trafficCaptureEnabled,
          windowMs,
          sampled: denials.length,
          /** True when `sampled`/`byCode` are a floor: the newest `scanLimit` error rows filled the scan. */
          truncated,
          scanLimit: DIAGNOSE_SCAN_LIMIT,
          byCode,
          latest: denials.slice(0, DIAGNOSE_LATEST_SAMPLE).map((d) => ({ denyCode: d.denyCode, at: d.createdAt })),
        },
      });
    },
  },
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
    scope: { dimension: "client", clientArg: "name", refuse: clientNotFound },
    handler: async (args, auth) => {
      const name = str(args, "name");
      const enabled = bool(args, "enabled");
      if (!name || enabled === undefined)
        return toolResult("Missing required argument: name, enabled", { isError: true });
      const ok = await registry.setClientEnabled(name, enabled);
      if (!ok) return clientNotFound(name);
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
    // Same dimension, tier and blast radius as the adjacent sys_set_guard —
    // these two must never diverge again.
    scope: { dimension: "tool", clientArg: "client", toolArg: "tool" },
    handler: async (args, auth) => {
      const client = str(args, "client");
      const tool = str(args, "tool");
      const enabled = bool(args, "enabled");
      if (!client || !tool || enabled === undefined) {
        return toolResult("Missing required argument: client, tool, enabled", { isError: true });
      }
      const ok = await registry.setToolEnabled(client, tool, enabled);
      // Shares toolUnavailable's literal with the scope refusal on purpose.
      if (!ok) return toolUnavailable(client, tool);
      recordAudit(actorFor(auth), enabled ? "tool.enable" : "tool.disable", `${client}__${tool}`);
      return toolResult(`Tool '${client}__${tool}' ${enabled ? "enabled" : "disabled"}`);
    },
  },
  {
    name: "sys_set_guard",
    description:
      "Set (or clear) one tool's guard policy: per-tool rate limit, timeout, and API-key allowlist. Takes the same value the " +
      "admin API's per-tool PATCH takes under its `guards` key, and applies it through the same policy registry, so config " +
      "export/import and snapshot rollback keep seeing it. Pass guards:null to clear the policy entirely.",
    inputSchema: {
      type: "object",
      properties: {
        client: { type: "string" },
        tool: { type: "string" },
        guards: {
          type: ["object", "null"],
          description:
            "{rateLimitPerMin?: number, timeoutMs?: number, allowedApiKeys?: string[]} — raw keys are hashed before storage. Null clears.",
        },
      },
      required: ["client", "tool", "guards"],
      additionalProperties: false,
    },
    tier: "operate",
    scope: { dimension: "tool", clientArg: "client", toolArg: "tool" },
    handler: async (args, auth) => {
      const client = str(args, "client");
      const tool = str(args, "tool");
      // `guards` is checked for presence, not shape: null is a meaningful value
      // (clear the policy) and every other shape is the registry's to validate.
      if (!client || !tool || args.guards === undefined) {
        return toolResult("Missing required argument: client, tool, guards", { isError: true });
      }
      // Through the mutation registry, never registry.setToolGuards directly:
      // that registry is what config export/import and snapshot rollback read
      // and replay, and going around it is how fifteen policies once went
      // missing from every rollback. It also records the audit event in the
      // exact shape a PATCH does.
      const { failures } = await applyToolMutations(
        { guards: args.guards },
        { actor: actorFor(auth), clientName: client, toolName: tool },
      );
      const failure = failures[0];
      if (failure) {
        // A tool this caller may touch but that doesn't exist gets the same
        // words as one outside its scope — see toolUnavailable.
        return failure.kind === "tool_not_found"
          ? toolUnavailable(client, tool)
          : toolResult(failure.message, { isError: true });
      }
      return toolResult(`Guards updated for '${toolKey(client, tool)}'`);
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
    scope: { dimension: "client", clientArg: "name", refuse: clientNotLive },
    handler: (args, auth) => {
      const name = str(args, "name");
      if (!name) return toolResult("Missing required argument: name", { isError: true });
      const ok = registry.resetCircuitBreaker(name);
      if (!ok) return clientNotLive(name);
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
    // A create, but still the client dimension: registration overwrites an
    // existing name (no collision check — see clientOutsideScope), so an
    // ungated call is a way to REPLACE another tenant's client wholesale, and
    // even for a genuinely new name it points the gateway at a network
    // destination the caller could never reach through its own scope. An
    // unrestricted key (scopes null) is unaffected; only a client-scoped key is
    // held to its list.
    scope: { dimension: "client", clientArg: "name", refuse: clientOutsideScope },
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
    scope: { dimension: "client", clientArg: "name", refuse: clientNotFound },
    sensitive: true,
    handler: async (args, auth) => {
      const name = str(args, "name");
      if (!name) return toolResult("Missing required argument: name", { isError: true });
      const ok = await registry.forgetClient(name);
      if (!ok) return clientNotFound(name);
      recordAudit(actorFor(auth), "client.delete", name);
      return toolResult(`Client '${name}' deleted`);
    },
  },

  // ── Admin tier ───────────────────────────────────────────────────────────
  {
    name: "sys_create_bundle",
    description:
      "Create an admin-curated MCP bundle from a list of clientName__toolName keys — the cross-client subset served at " +
      "/mcp-custom/:bundleName. Completes the discover-a-backend, curate-it, hand-out-one-endpoint loop without leaving MCP. " +
      "Composite (macro) members cannot be set here: a composite name carries no client, so the per-key authorization this " +
      'tool applies cannot confine one — use the admin API for those. Creates a new serving surface, so: pass {"__confirm": true} ' +
      "or use an elevated credential.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Bundle name — same lowercase identifier shape as a client/tool name." },
        description: { type: "string" },
        tools: {
          type: "array",
          items: { type: "string" },
          description: "clientName__toolName keys to expose through the bundle.",
        },
        __confirm: { type: "boolean" },
      },
      required: ["name", "tools"],
      additionalProperties: false,
    },
    // The REST counterpart (POST /admin-api/bundles) is requireSuperAdmin, and
    // "admin" is this surface's top tier — but the reason that route needs
    // super-admin does not carry over unchanged. It is super-admin because
    // createBundle's UNKNOWN_TOOL check runs against the GLOBAL tools table with
    // no team filter, so a distinguishable unknown-vs-created answer would let a
    // team-scoped admin enumerate other tenants' tool names. Here the per-key
    // scope check in the handler closes that oracle directly instead.
    tier: "admin",
    scope: {
      dimension: "handler",
      why: "One call names N (client, tool) pairs in a string array, so the check runs per key inside the handler — and answers in createBundle's own UNKNOWN_TOOL wording rather than toolUnavailable's.",
    },
    sensitive: true,
    handler: async (args, auth, scope) => {
      const name = str(args, "name");
      const rawTools = args.tools;
      if (!name || !Array.isArray(rawTools)) {
        return toolResult("Missing required argument: name, tools", { isError: true });
      }
      // Same cap the REST bundle route applies to a tools[] array.
      if (rawTools.length > config.maxToolsPerClient) {
        return toolResult(`tools exceeds maximum of ${config.maxToolsPerClient}`, { isError: true });
      }
      const refs: BundleToolRef[] = [];
      for (const raw of rawTools) {
        const key = typeof raw === "string" ? raw : "";
        const ref = key ? splitToolKey(key) : undefined;
        // A malformed key, a tool outside this caller's key scope, and a tool
        // that does not exist all answer identically — and the scope check has
        // to run BEFORE createBundle, whose own existence check is global and
        // would otherwise report on clients this caller cannot reach. The
        // wording matches createBundle's UNKNOWN_TOOL message for the same
        // reason the two must stay indistinguishable.
        if (!ref || !callerMayTouchTool(scope, ref.client, ref.tool)) {
          return toolResult(`Unknown tool "${key}"`, { isError: true });
        }
        refs.push(ref);
      }
      const result = await createBundle(name, str(args, "description"), refs, actorFor(auth));
      if (!result.ok) return toolResult(result.error.message, { isError: true });
      // Same two-field detail POST /admin-api/bundles records, so one audit row
      // does not read differently depending on which transport wrote it.
      // composites_count is 0 because this tool refuses composite members
      // outright (see the description) — if it ever accepts them, this must
      // count them, not stay pinned at zero.
      recordAudit(actorFor(auth), "bundle.create", name, { tools_count: refs.length, composites_count: 0 });
      return json(getBundleDetail(name));
    },
  },
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
    scope: {
      dimension: "none",
      why: "envBearerOnly, so the caller never has a key row to be narrowed by; the `scopes` argument describes the key being minted, not the minter.",
    },
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
    // NOTE: names a key id, so `scopes` (a client list) cannot narrow it — but
    // that also means an admin-tier managed key may revoke any OTHER key,
    // including a more privileged one. That is a key-ownership question, not a
    // client-scope one, and it is unchanged by this gate.
    scope: { dimension: "none", why: "Names a managed key id, not a client or a tool." },
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

/**
 * Applies a tool's declared `scope`. Returns the refusal to send, or null to let
 * the call through.
 *
 * A missing or non-string target argument returns null on purpose: there is
 * nothing to narrow by yet, and the handler owns the "Missing required argument"
 * wording. The refusal for a target that IS named is the tool's own not-found
 * answer, so nothing distinguishes "outside your scope" from "does not exist" —
 * the property mcp-server.ts documents at length for the tool-call path and
 * scope-refusal-is-opaque.test.ts pins there.
 */
function checkToolScope(tool: SystemTool, args: Record<string, unknown>, caller: CallerScope): ToolCallResult | null {
  const scope = tool.scope;
  if (scope.dimension === "client") {
    const name = str(args, scope.clientArg);
    if (name === undefined) return null;
    return callerMayTouchClient(caller, name) ? null : scope.refuse(name);
  }
  if (scope.dimension === "tool") {
    const client = str(args, scope.clientArg);
    const toolName = str(args, scope.toolArg);
    if (client === undefined || toolName === undefined) return null;
    return callerMayTouchTool(caller, client, toolName) ? null : toolUnavailable(client, toolName);
  }
  // "none" names nothing; "handler" narrows inside the handler (see each `why`).
  return null;
}

/**
 * Every tool paired with the tenancy dimension it declares — read by the
 * structural census test, which fails when a sys_* tool is added, so the
 * declaration is looked at by a human instead of being defaulted.
 */
export function systemToolScopeCensus(): { name: string; dimension: SystemToolScopeDimension }[] {
  return SYSTEM_TOOLS.map((t) => ({ name: t.name, dimension: t.scope.dimension }));
}

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
  const confirmGate = checkConfirmGate(tool.sensitive === true, args, auth.elevated, name);
  if (confirmGate) return confirmGate;
  // One read of the caller's key row for the whole invocation — the gate below
  // and the handler share it. See CallerScope: still per-call, just not
  // per-row.
  const caller = resolveCallerScope(auth);
  // Last gate before the handler, and after the step-up gate deliberately: the
  // step-up refusal is identical for every target, so answering it first tells
  // an out-of-scope caller nothing, while running it second would let a
  // scope-refused caller learn that its credential alone would have sufficed.
  const outOfScope = checkToolScope(tool, args, caller);
  if (outOfScope) return outOfScope;

  try {
    return await tool.handler(args, auth, caller);
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
