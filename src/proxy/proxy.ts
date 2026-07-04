import Ajv from "ajv";
import addFormats from "ajv-formats";
import { registry } from "../mcp/registry.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import { isRawIpLiteral } from "../ws-proxy.js";
import { getCircuitBreaker } from "../middleware/circuit-breaker.js";
import { recordToolCall } from "../routes/metrics.js";
import {
  proxyBodyCapRejections,
  proxyRetryAttempts,
  proxyRequestDuration,
  cacheEvents,
  lbRequests,
  coalesceHits,
} from "../observability/metrics.js";
import { getToolCacheConfig, cacheKey, cacheGet, cacheSet } from "../response-cache.js";
import { getToolCoalesce, runCoalesced } from "../coalesce.js";
import {
  getLb,
  selectTarget,
  markTargetUp,
  markTargetDown,
  incInflight,
  decInflight,
  type LbChoice,
} from "../load-balancer.js";
import {
  getPaginationConfig,
  extractItems,
  nextCursorValue,
  parseNextLink,
  withItems,
  type PaginationConfig,
} from "../pagination.js";
import { getStreamingConfig, parseStream } from "./streaming.js";
import { getToolTransform, applyOps } from "./transform.js";
import { getToolMock } from "../mock.js";
import {
  requiresApproval,
  approvalArgsHash,
  createApproval,
  consumeApproval,
  notifyApproval,
  getRequiredLevels,
} from "../approvals.js";
import { recordTraffic } from "../observability/traffic.js";
import { getToolGraphql, getToolWs, wsRequest, wsRequestPersistent } from "./backends.js";
import { getOAuthBearer } from "../oauth.js";
import { refreshPinIfStale } from "../security/ip-validator.js";
import type { PinnedIp } from "../security/ip-validator.js";
import { isDeleting } from "../mcp/registry.js";
import { checkToolRateLimit } from "../middleware/rate-limiter.js";
import { checkSharedToolRateLimit } from "../db/rate-counters.js";
import { isKeyAllowed } from "../security/key-hash.js";
import { resolveMcpKeyByToken, isToolInKeyScope } from "../security/mcp-key-store.js";
import { getUpstreamAuthHeaders } from "../security/upstream-auth.js";
import { recordUsage } from "../observability/usage.js";
import { checkConsumerQuota, checkEndUserRateLimit, getConsumer } from "../consumers.js";
import { isToolSensitive } from "../tool-sensitivity.js";
import { getRedactionPaths, applyRedaction } from "../redaction.js";
import { getGuardrails, checkInputGuardrails, applyResponseScan } from "../guardrails.js";
import { checkQuarantine, recordGuardrailHit } from "../quarantine.js";
import { applyContextBudget } from "../context-budget.js";
import { getCanary, decideSecondary } from "../canary.js";
import { tracingEnabled, startSpan, endSpan } from "../observability/tracing.js";
import { mcpUpstream } from "../mcp/mcp-upstream.js";
import type { McpConnParams } from "../mcp/mcp-upstream.js";
import type { RegisteredClient, RegisteredTool } from "../mcp/types.js";

// ---------------------------------------------------------------------------
// Ajv singleton — shared across all tool calls
// ---------------------------------------------------------------------------
const ajv = new Ajv({
  allErrors: false, // first error is enough for tool calls
  strict: false, // tolerate vendor extensions in JSON Schema
  removeAdditional: "all", // strip unknown keys (replicates prior manual behaviour)
  useDefaults: true, // apply defaults if specified in schema
  coerceTypes: false, // do NOT auto-coerce — surface real type errors
});
addFormats(ajv);

// Cache compiled validators per client+tool key (stable for the lifetime of a registration).
const validatorCache = new Map<string, ReturnType<typeof ajv.compile>>();

function getOrCompile(
  clientName: string,
  toolName: string,
  schema: Record<string, unknown>,
): ReturnType<typeof ajv.compile> {
  const key = `${clientName}::${toolName}`;
  let validate = validatorCache.get(key);
  if (!validate) {
    validate = ajv.compile(schema);
    validatorCache.set(key, validate);
  }
  return validate;
}

// ---------------------------------------------------------------------------
// TTL-based pinned IP cache — module-level Map keyed on client name
// ---------------------------------------------------------------------------
const pinnedIpCache = new Map<string, PinnedIp>();

// Track in-flight requests per client for cancellation
const inflightControllers = new Map<string, Set<AbortController>>();

function trackRequest(clientName: string): AbortController {
  const controller = new AbortController();
  if (!inflightControllers.has(clientName)) {
    inflightControllers.set(clientName, new Set());
  }
  inflightControllers.get(clientName)!.add(controller);
  return controller;
}

function untrackRequest(clientName: string, controller: AbortController): void {
  inflightControllers.get(clientName)?.delete(controller);
}

export function abortClientRequests(clientName: string): void {
  const controllers = inflightControllers.get(clientName);
  if (controllers) {
    for (const ctrl of controllers) {
      ctrl.abort();
    }
    controllers.clear();
  }
}

/**
 * Parse a Retry-After header value into a wait duration in milliseconds.
 * Handles both integer-seconds ("120") and HTTP-date ("Wed, 21 Oct 2025 07:28:00 GMT") forms.
 * Returns null when the value cannot be parsed or exceeds `config.retryAfterMaxMs`.
 */
function parseRetryAfter(headerValue: string | null): number | null {
  if (!headerValue) return null;

  // 1) Integer seconds form
  const seconds = parseInt(headerValue, 10);
  if (Number.isFinite(seconds)) {
    const ms = seconds * 1000;
    if (ms >= 0 && ms <= config.retryAfterMaxMs) return ms;
    return null;
  }

  // 2) HTTP-date form
  const dateMs = Date.parse(headerValue);
  if (!isNaN(dateMs)) {
    const ms = dateMs - Date.now();
    if (ms >= 0 && ms <= config.retryAfterMaxMs) return ms;
    return null;
  }

  return null;
}

function httpStatusClass(status: number): string {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  return "5xx";
}

/**
 * Read the response body as a stream, enforcing `config.maxResponseBytes`.
 * Returns the raw text on success, or null when the limit is exceeded (after cancelling the reader).
 */
async function readBodyWithCap(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) {
    // Fallback for environments where body is not a ReadableStream
    return response.text();
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      totalBytes += value.byteLength;
      if (totalBytes > config.maxResponseBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

interface PageCtx {
  targetBaseUrl: string;
  resolvedPath: string;
  baseQuery: URLSearchParams;
  pinIp: string;
  originalHost: string;
  headers: Record<string, string>;
  timeoutMs: number;
  externalSignal: AbortSignal;
  maxBytes: number;
  firstBytes: number;
  firstLink: string | null;
}

/** Builds a same-host page URL with the pinned IP substituted for the hostname. */
function buildPinnedUrl(baseUrl: string, path: string, query: URLSearchParams, pinIp: string): string {
  const u = new URL(`${baseUrl}${path}`);
  u.hostname = pinIp;
  u.search = query.toString();
  return u.toString();
}

/**
 * Follows pagination from a first JSON page, aggregating the array at
 * `cfg.itemsPath` across pages. Returns the merged body as pretty JSON, or null
 * when the first body isn't paginable (not JSON / itemsPath not an array / empty).
 * Every follow-up reuses the pinned IP + Host of the primary request; a `link`
 * next URL to a different host is not followed (SSRF-safe). Bounded by
 * cfg.maxPages and the aggregate byte cap.
 */
async function fetchAllPages(firstBodyText: string, cfg: PaginationConfig, ctx: PageCtx): Promise<string | null> {
  let firstBody: unknown;
  try {
    firstBody = JSON.parse(firstBodyText);
  } catch {
    return null;
  }
  const firstItems = extractItems(firstBody, cfg.itemsPath);
  if (!firstItems || firstItems.length === 0) return null;

  const all: unknown[] = [...firstItems];
  let totalBytes = ctx.firstBytes;
  let cursor: string | null =
    cfg.strategy === "cursor" ? nextCursorValue(firstBody, cfg.cursorResponsePath ?? "") : null;
  let link: string | null = cfg.strategy === "link" ? parseNextLink(ctx.firstLink) : null;
  let pageNum = 2;

  const fetchPage = async (urlStr: string): Promise<{ ok: boolean; text: string | null; link: string | null }> => {
    const signal = AbortSignal.any([ctx.externalSignal, AbortSignal.timeout(ctx.timeoutMs)]);
    const resp = await fetch(urlStr, {
      method: "GET",
      headers: { ...ctx.headers, "Content-Type": "application/json", Host: ctx.originalHost },
      redirect: "error" as RequestRedirect,
      signal,
    });
    const text = resp.ok ? await readBodyWithCap(resp) : null;
    return { ok: resp.ok, text, link: resp.headers.get("link") };
  };

  const limit = Math.min(cfg.maxPages, 100);
  for (let page = 1; page < limit; page++) {
    let urlStr: string;
    if (cfg.strategy === "cursor") {
      if (!cursor) break;
      const q = new URLSearchParams(ctx.baseQuery);
      q.set(cfg.cursorParam ?? "cursor", cursor);
      urlStr = buildPinnedUrl(ctx.targetBaseUrl, ctx.resolvedPath, q, ctx.pinIp);
    } else if (cfg.strategy === "page") {
      const q = new URLSearchParams(ctx.baseQuery);
      q.set(cfg.pageParam ?? "page", String(pageNum));
      urlStr = buildPinnedUrl(ctx.targetBaseUrl, ctx.resolvedPath, q, ctx.pinIp);
    } else {
      if (!link) break;
      let linkUrl: URL;
      try {
        linkUrl = new URL(link);
      } catch {
        break;
      }
      if (linkUrl.host !== ctx.originalHost) break; // cross-host next: stop (SSRF-safe)
      linkUrl.hostname = ctx.pinIp;
      urlStr = linkUrl.toString();
    }

    let res: { ok: boolean; text: string | null; link: string | null };
    try {
      res = await fetchPage(urlStr);
    } catch {
      break;
    }
    if (!res.ok || res.text === null) break;

    let body: unknown;
    try {
      body = JSON.parse(res.text);
    } catch {
      break;
    }
    const items = extractItems(body, cfg.itemsPath);
    if (!items || items.length === 0) break;

    all.push(...items);
    totalBytes += new TextEncoder().encode(res.text).length;
    if (totalBytes > ctx.maxBytes) break;

    if (cfg.strategy === "cursor") {
      cursor = nextCursorValue(body, cfg.cursorResponsePath ?? "");
      if (!cursor) break;
    } else if (cfg.strategy === "link") {
      link = parseNextLink(res.link);
      if (!link) break;
    } else {
      pageNum++;
    }
  }

  return JSON.stringify(withItems(firstBody, cfg.itemsPath, all), null, 2);
}

/**
 * Optional per-call bridging for MCP-to-MCP progress/cancellation forwarding
 * (kind:"mcp" upstreams only — see dispatchMcpToolCall). `signal` is the
 * downstream caller's own cancellation (auto-aborted by the SDK on
 * notifications/cancelled); `onProgress` is only ever set when the downstream
 * caller itself requested progress (a `_meta.progressToken` on its call), so
 * an upstream that doesn't support progress is simply never asked for it.
 */
export interface ToolCallOpts {
  signal?: AbortSignal;
  onProgress?: (progress: number, total?: number, message?: string) => void;
  /** Caller-asserted end-user identity (X-End-User-Id header), for optional
   * per-end-user rate limiting. Unauthenticated — see resolveEndUserId. */
  endUserId?: string;
  /** The calling MCP transport session id (extra.sessionId from the SDK's
   * RequestHandlerExtra — see transports.ts's session maps), threaded through
   * so the trace viewer can attribute a span to the session/agent run that
   * caused it, not just the API key. Undefined for callers with no live MCP
   * session (composite steps, admin test-calls). */
  sessionId?: string;
}

/**
 * Resolves the caller-asserted end-user identity for this call, if any. The
 * header (threaded via ToolCallOpts.endUserId) wins when both are present:
 * it's set by the wrapping application's own request-construction code, not
 * influenced by anything an LLM emits as tool-call arguments (which could be
 * steered by prompt injection). Blank/non-string values are treated as absent.
 *
 * SECURITY NOTE: when the header is absent (the common case for a bare/raw
 * MCP client, or any deployment that doesn't thread X-End-User-Id through),
 * the __end_user *argument* is the only identity signal — and it comes
 * straight from the model's tool-call arguments. A prompt-injected or
 * malicious caller can therefore not only evade its own per-end-user limit
 * (self-harm, the originally-scoped risk) but also assert a SPECIFIC OTHER
 * end-user's id to burn that victim's bucket and deny their legitimate calls.
 * This is inherent to accepting any unauthenticated identity signal from tool
 * arguments; only deploy per-end-user rate limiting for a consumer where the
 * wrapping application reliably sets the header, or treat the arg-only path
 * as a fairness convenience with no adversarial guarantee at all.
 */
function resolveEndUserId(headerValue: string | undefined, args: Record<string, unknown>): string | null {
  const fromHeader = typeof headerValue === "string" ? headerValue.trim() : "";
  if (fromHeader) return fromHeader;
  const rawArg = (args as Record<string, unknown>).__end_user;
  const fromArg = typeof rawArg === "string" ? rawArg.trim() : "";
  return fromArg || null;
}

/**
 * Public entry point. When OTLP tracing is enabled, wraps the dispatch in a
 * CLIENT span (bridge -> backend) with the tool name and error outcome; a no-op
 * passthrough otherwise. Kept as a thin wrapper so every caller
 * (mcp-server/composites/admin test route) is traced without change.
 */
export async function proxyToolCall(
  mcpToolName: string,
  args: Record<string, unknown> = {},
  callerToken?: string,
  opts?: ToolCallOpts,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const capture = config.trafficCaptureEnabled;
  const started = capture ? Date.now() : 0;

  let result: { content: Array<{ type: string; text: string }>; isError?: boolean };
  if (!tracingEnabled()) {
    result = await dispatchToolCall(mcpToolName, args, callerToken, opts);
  } else {
    const span = startSpan(`tool_call ${mcpToolName}`, { "mcp.tool": mcpToolName });
    result = await dispatchToolCall(mcpToolName, args, callerToken, opts);
    endSpan(
      span,
      {
        "mcp.tool.is_error": result.isError === true,
        ...(opts?.sessionId ? { "mcp.session_id": opts.sessionId } : {}),
      },
      result.isError ? 2 : 1,
    );
  }

  // Traffic capture — a single point covering every dispatch outcome. Opt-in.
  if (capture) {
    const resolved = registry.resolveTool(mcpToolName);
    recordTraffic({
      mcpToolName,
      clientName: resolved?.client.name ?? null,
      toolName: resolved?.tool.name ?? null,
      keyId: callerToken ? (resolveMcpKeyByToken(callerToken)?.id ?? null) : null,
      args,
      result,
      durationMs: Date.now() - started,
    });
  }
  return result;
}

/**
 * Runs the human-in-the-loop approval ticket gate for one call: files a new
 * pending ticket (no __approval_id) or validates+consumes an existing one.
 * Returns a terminal result when the call must stop here, or null when it may
 * proceed. Shared by the natural per-tool `requiresApproval` check and by
 * quarantine's "force_approval" action, so ticket-creation logic never
 * duplicates between the two call sites.
 */
function runApprovalGate(
  client: RegisteredClient,
  tool: RegisteredTool,
  args: Record<string, unknown>,
  mcpToolName: string,
  callerKey: { id: number } | null,
): { content: Array<{ type: string; text: string }>; isError?: boolean } | null {
  const rawApprovalId = (args as Record<string, unknown>).__approval_id;
  const approvalId = typeof rawApprovalId === "number" ? rawApprovalId : null;
  const argsHash = approvalArgsHash(args as Record<string, unknown>);
  if (approvalId === null) {
    const id = createApproval(
      client.name,
      tool.name,
      argsHash,
      JSON.stringify(args),
      callerKey?.id ?? null,
      getRequiredLevels(client.name, tool.name),
    );
    notifyApproval(id, client.name, tool.name);
    log("info", "Tool call queued for approval", { tool: mcpToolName, client: client.name, approval_id: id });
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Tool '${mcpToolName}' requires human approval. Queued as approval #${id}. Once approved, re-call with {"__approval_id": ${id}}.`,
        },
      ],
    };
  }
  const decision = consumeApproval(approvalId, client.name, tool.name, argsHash);
  if (!decision.ok) {
    return { isError: true, content: [{ type: "text", text: decision.message }] };
  }
  return null;
}

async function dispatchToolCall(
  mcpToolName: string,
  args: Record<string, unknown> = {},
  callerToken?: string,
  opts?: ToolCallOpts,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const resolved = registry.resolveTool(mcpToolName);

  if (resolved === undefined) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${mcpToolName}` }],
      isError: true,
    };
  }

  const { client, tool } = resolved;

  // Admin enable/disable backstop — the tool should already be excluded from
  // whatever tools/list a caller saw, but a stale client-side cache could
  // still attempt to call it directly.
  if (!client.enabled || !tool.enabled) {
    return {
      isError: true,
      content: [{ type: "text", text: `Tool '${mcpToolName}' is disabled` }],
    };
  }

  if (isDeleting(client.name)) {
    return {
      isError: true,
      content: [{ type: "text", text: "Client is being unregistered" }],
    };
  }

  if (client.status === "unreachable") {
    return {
      content: [{ type: "text", text: `Client '${client.name}' is unreachable` }],
      isError: true,
    };
  }

  // Admin guards — run before the circuit breaker check below, since a
  // half-open breaker's canRequest() consumes the single probe slot as a
  // side effect; a guard-rejected call must not burn that probe.
  if (tool.guards?.allowedKeyHashes?.length) {
    // Fail closed: an explicit restriction must hold even when global MCP
    // auth is disabled or unconfigured — it shouldn't become a silent no-op.
    if (!isKeyAllowed(callerToken, tool.guards.allowedKeyHashes)) {
      return {
        isError: true,
        content: [{ type: "text", text: `Not authorized to call tool '${mcpToolName}'` }],
      };
    }
  }

  // Resolve the managed key once — used for scope enforcement here and for
  // usage attribution at every terminal outcome below. Legacy env keys and
  // admin test-calls resolve to null (no scope restriction, unattributed).
  const callerKey = callerToken ? resolveMcpKeyByToken(callerToken) : null;
  if (callerKey && !isToolInKeyScope(callerKey.scopes, client.name, mcpToolName)) {
    return {
      isError: true,
      content: [{ type: "text", text: `API key is not authorized to call tool '${mcpToolName}'` }],
    };
  }

  // Multi-tenant monthly quota — reject once the key's consumer is at/over its cap.
  if (callerKey?.consumerId != null) {
    // Fetched once and passed to both checks below — each independently
    // calling getConsumer() would be a second identical SQLite read per call.
    const consumer = getConsumer(callerKey.consumerId);
    const quota = checkConsumerQuota(callerKey.consumerId, consumer);
    if (quota.exceeded) {
      return {
        isError: true,
        content: [
          { type: "text", text: `Monthly quota exceeded for this API key's consumer (${quota.used}/${quota.quota})` },
        ],
      };
    }

    // Per-end-user rate limit (optional, opt-in fairness dimension) — lets the
    // calling application assert an end-user identity per call so one noisy
    // end user can't exhaust the whole shared key's quota for everyone else.
    // Caller-asserted, UNAUTHENTICATED: a fairness knob, not an authorization
    // boundary. Zero overhead unless BOTH (a) the caller asserts an id AND (b)
    // the consumer opted in (see resolveEndUserId/checkEndUserRateLimit).
    const assertedEndUserId = resolveEndUserId(opts?.endUserId, args);
    if (assertedEndUserId !== null) {
      const endUserRl = checkEndUserRateLimit(callerKey.consumerId, assertedEndUserId, consumer);
      if (endUserRl.limited) {
        return {
          isError: true,
          content: [
            { type: "text", text: `End-user rate limit exceeded — retry after ${endUserRl.retryAfterSeconds}s` },
          ],
        };
      }
    }
  }

  // Destructive-action gating — a sensitive tool requires an explicit
  // `__confirm: true` argument or an elevated key. The __confirm arg is not part
  // of any inputSchema, so Ajv's removeAdditional strips it before the upstream call.
  if (isToolSensitive(client.name, tool.name, tool.method)) {
    const confirmed = (args as Record<string, unknown>).__confirm === true;
    if (!confirmed && callerKey?.elevated !== true) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Tool '${mcpToolName}' is sensitive — pass {"__confirm": true} in arguments or call with an elevated key.`,
          },
        ],
      };
    }
  }

  // Auto-quarantine — escalates after N consecutive guardrail violations (see
  // quarantine.ts). Runs before the breaker, like every other guard, and
  // before the natural approval gate so its "force_approval" action can reuse
  // that same gate below without duplicating ticket-creation logic.
  let approvalGateHandled = false;
  const quarantine = checkQuarantine(client.name, tool.name);
  if (quarantine.active) {
    if (quarantine.action === "block") {
      log("warn", "Tool call blocked by quarantine", {
        tool: mcpToolName,
        client: client.name,
        reason: quarantine.reason,
      });
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Tool '${mcpToolName}' is quarantined: ${quarantine.reason ?? "too many guardrail violations"}`,
          },
        ],
      };
    }
    if (quarantine.action === "force_approval") {
      const gated = runApprovalGate(client, tool, args, mcpToolName, callerKey);
      approvalGateHandled = true;
      if (gated) return gated;
    } else if (quarantine.action === "observe") {
      log("warn", "Quarantined tool call allowed through (observe mode)", {
        tool: mcpToolName,
        client: client.name,
        reason: quarantine.reason,
      });
    }
  }

  // Human-in-the-loop approval (ticket model). No __approval_id -> file a pending
  // ticket bound to these exact args and return its id. With an id -> validate and
  // consume it (single-use, args-bound) before proceeding. __approval_id is not in
  // any inputSchema, so Ajv's removeAdditional strips it before the upstream call.
  if (!approvalGateHandled && requiresApproval(client.name, tool.name)) {
    const gated = runApprovalGate(client, tool, args, mcpToolName, callerKey);
    if (gated) return gated;
  }

  // Content guardrails — input gate runs here (before the breaker, like every
  // other guard) so a rejected call never burns a half-open probe. The same
  // config's scan-responses flag is reused on the output path below (REST) and
  // threaded into the MCP dispatch.
  const guardrails = getGuardrails(client.name, tool.name);
  if (guardrails) {
    const inputCheck = checkInputGuardrails(guardrails, args);
    if (inputCheck.blocked) {
      recordGuardrailHit(client.name, tool.name, true);
      log("warn", "Tool call rejected by input guardrail", {
        tool: mcpToolName,
        client: client.name,
        reason: inputCheck.reason,
      });
      return {
        isError: true,
        content: [{ type: "text", text: `Input rejected by guardrail: ${inputCheck.reason}` }],
      };
    }
    recordGuardrailHit(client.name, tool.name, false);
  }

  if (tool.guards?.rateLimitPerMin !== undefined) {
    // Shared (cross-instance) counters when running HA; fast in-memory otherwise.
    const rl = config.rateLimitShared
      ? checkSharedToolRateLimit(mcpToolName, tool.guards.rateLimitPerMin)
      : checkToolRateLimit(mcpToolName, tool.guards.rateLimitPerMin);
    if (!rl.allowed) {
      return {
        isError: true,
        content: [{ type: "text", text: `Tool rate limit exceeded — retry after ${rl.retryAfterSeconds}s` }],
      };
    }
  }

  // Mock / virtualization. An "always" mock short-circuits the upstream (after
  // guards, before the breaker — like the cache). A "fallback" mock is returned
  // only when the backend is unavailable (checked at the failure returns below).
  const mockCfg = client.kind === "rest" ? getToolMock(client.name, tool.name) : null;
  if (mockCfg?.enabled && mockCfg.mode === "always") {
    recordToolCall(0, false);
    recordUsage({
      clientName: client.name,
      toolName: tool.name,
      keyId: callerKey?.id ?? null,
      statusClass: "2xx",
      isError: false,
      durationMs: 0,
    });
    log("info", "Tool call served from mock", { tool: mcpToolName, client: client.name });
    return { content: [{ type: "text", text: mockCfg.response }] };
  }

  // ── Response cache (lookup) ────────────────────────────────────────────────
  // Idempotent GET responses may be served from an in-memory TTL cache, skipping
  // the upstream entirely. Runs AFTER every auth/guard/rate-limit gate (a hit
  // still counts against them) but BEFORE the circuit breaker, so a hit never
  // consumes a half-open probe slot (rule 4, above). REST GET only; the cached
  // value is the already-redacted/guardrail-scanned text, so every authorised
  // caller gets identical output and no raw secret is ever stored.
  const cacheCfg =
    client.kind === "rest" && tool.method.toUpperCase() === "GET" ? getToolCacheConfig(client.name, tool.name) : null;
  const responseCacheEnabled = cacheCfg?.enabled === true;
  const responseCacheKey = responseCacheEnabled ? cacheKey(client.name, tool.name, client.base_url, args) : "";
  if (responseCacheEnabled) {
    const hit = cacheGet(responseCacheKey);
    if (hit) {
      cacheEvents.inc({ client: client.name, outcome: "hit" });
      recordToolCall(0, false);
      recordUsage({
        clientName: client.name,
        toolName: tool.name,
        keyId: callerKey?.id ?? null,
        statusClass: "2xx",
        isError: false,
        durationMs: 0,
      });
      log("info", "Tool call served from cache", { tool: mcpToolName, client: client.name });
      return { content: hit.content };
    }
    cacheEvents.inc({ client: client.name, outcome: "miss" });
  }

  // Request coalescing — concurrent identical in-flight REST GET calls share a
  // single upstream fetch. Every gate above (scope/quota/sensitivity/approval/
  // guardrails) already ran for THIS caller, so piggybacking on another
  // caller's in-flight request never bypasses per-caller authorization; only
  // the network fetch and its breaker/LB bookkeeping are shared (rule 4 also
  // means this decision must wrap the breaker check below, not just the
  // fetch — calling canRequest() once per piggybacker would spuriously burn
  // extra half-open probe slots).
  const coalesceCfg =
    client.kind === "rest" && tool.method.toUpperCase() === "GET" ? getToolCoalesce(client.name, tool.name) : null;
  const coalesceKey = coalesceCfg?.enabled
    ? responseCacheKey || cacheKey(client.name, tool.name, client.base_url, args)
    : "";

  const runRest = async (): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> => {
    // Circuit breaker check
    const breaker = getCircuitBreaker(client.name, client.guards?.circuitBreaker);
    const circuitCheck = breaker.canRequest();

    // N-way load balancing (REST only) takes precedence over canary: when a pool
    // is active it owns target selection, so canary routing is skipped. The
    // client-level circuit breaker above stays unchanged — LB spreads load across
    // members and tracks per-target health via its own cooldown, not the breaker.
    const lb = client.kind === "rest" ? getLb(client.name) : null;
    const lbActive = !!lb && lb.enabled && lb.targets.some((t) => t.enabled);
    const lbChoice: LbChoice | null = lbActive ? selectTarget(client, lb!) : null;
    if (lbChoice) lbRequests.inc({ client: client.name, member: lbChoice.isPrimary ? "primary" : "pool" });

    // Secondary-upstream routing (canary / failover) — REST clients only, and only
    // when LB is not active. When the breaker is open and a failover secondary is
    // configured, route there instead of failing fast (bypassing the breaker).
    const canary = client.kind === "rest" && !lbActive ? getCanary(client.name) : null;
    const route = decideSecondary(canary, !circuitCheck.allowed);

    if (!circuitCheck.allowed && !route.useSecondary) {
      if (mockCfg?.enabled && mockCfg.mode === "fallback")
        return { content: [{ type: "text", text: mockCfg.response }] };
      return {
        content: [{ type: "text", text: `Circuit breaker OPEN for client '${client.name}' — failing fast` }],
        isError: true,
      };
    }

    // Use shorter timeout if half-open probe, else the tool's guard override, else the global default.
    const effectiveTimeout = circuitCheck.timeout ?? tool.guards?.timeoutMs ?? config.toolCallTimeoutMs;

    // MCP-kind upstream: forward to the outbound MCP client pool. Every
    // transport-agnostic gate above (enable/deleting/status/key-scope/quota/
    // sensitivity/rate-limit/circuit-breaker) has already applied; only the
    // REST URL/path/IP/fetch machinery below is skipped.
    if (client.kind === "mcp") {
      return dispatchMcpToolCall(
        client,
        tool,
        args,
        mcpToolName,
        effectiveTimeout,
        breaker,
        callerKey,
        guardrails?.scanResponses ?? false,
        opts,
      );
    }

    // WebSocket-backed tool — ephemeral request/response over WS. All the
    // transport-agnostic gates above have already applied; only the HTTP fetch
    // machinery below is replaced by a single WS round-trip.
    const wsCfg = getToolWs(client.name, tool.name);
    if (wsCfg?.enabled) {
      return dispatchWsToolCall(client, tool, args, wsCfg, effectiveTimeout, breaker, callerKey, opts);
    }

    // When bypassing the primary breaker (failover call to the secondary), the
    // breaker must not record this call's outcome — a secondary success must not
    // prematurely close the breaker and send the next call back to the down
    // primary. Canary calls (breaker was allowed) record normally.
    // When an LB target served the call, mark it healthy/unhealthy for future
    // selection (independent of the client-level breaker).
    const lbKey = lbChoice?.key;
    const recordBreakerSuccess = () => {
      if (!route.bypassBreaker) breaker.recordSuccess();
      if (lbKey) markTargetUp(lbKey);
    };
    const recordBreakerFailure = () => {
      if (!route.bypassBreaker) breaker.recordFailure();
      if (lbKey) markTargetDown(lbKey);
    };

    // Build URL with path param substitution
    let remainingArgs = { ...args };
    const resolvedPath = tool.endpoint.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, paramName) => {
      const value = remainingArgs[paramName];
      if (value !== undefined) {
        delete remainingArgs[paramName];
        return encodeURIComponent(String(value));
      }
      return `:${paramName}`;
    });

    // Fix 2 — Path traversal rejection post-substitution.
    // Check the resolved path segments for ".." or "." after decoding.
    // This catches endpoint templates that themselves contain traversal segments
    // (e.g. "/users/:id/../admin") since encodeURIComponent never encodes "/".
    // Note: encodeURIComponent applied to arg values cannot introduce "/" so a user
    // supplying id="../admin" produces the safe literal segment "..%2Fadmin" —
    // the real threat is the operator-supplied template containing ".." directly.
    {
      const pathToCheck = resolvedPath.split("?")[0]; // strip any inline query string
      const segments = pathToCheck.split("/");
      for (const seg of segments) {
        let decoded: string;
        try {
          decoded = decodeURIComponent(seg);
        } catch {
          decoded = seg;
        }
        if (decoded === ".." || decoded === ".") {
          return {
            content: [{ type: "text", text: "Tool endpoint resolved to invalid path" }],
            isError: true,
          };
        }
      }
    }

    // Validate args against inputSchema via Ajv (handles enum, format, null, nested objects, etc.)
    // removeAdditional:"all" on the Ajv instance means unknown keys are stripped from remainingArgs.
    {
      const validate = getOrCompile(client.name, tool.name, tool.inputSchema);
      const valid = validate(remainingArgs);
      if (!valid) {
        const firstError = validate.errors?.[0];
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Argument validation failed: ${firstError ? `${firstError.instancePath || "/"}: ${firstError.message}` : "unknown error"}`,
            },
          ],
        };
      }
    }

    // Declarative request transform — runs AFTER Ajv strip so an injected field
    // the MCP inputSchema doesn't declare still reaches the backend.
    const transformCfg = getToolTransform(client.name, tool.name);
    if (transformCfg?.enabled && transformCfg.request.length > 0) {
      remainingArgs = applyOps(remainingArgs, transformCfg.request) as Record<string, unknown>;
    }

    // GraphQL-backed tool — the request body becomes a { query, variables } envelope
    // (built in the body step below) with the args as variables.
    const graphqlCfg = getToolGraphql(client.name, tool.name);

    // Build URL with pinned IP to prevent DNS rebinding.
    // Periodically re-resolve via TTL cache to mitigate IP-pin TOCTOU.
    // When routing to the secondary, use its config-time-validated base URL and
    // its pinned IP directly (no TTL re-resolution; it was pinned at setCanary).
    const targetBaseUrl = lbChoice ? lbChoice.baseUrl : route.useSecondary ? canary!.secondaryBaseUrl : client.base_url;
    const parsedBase = new URL(`${targetBaseUrl}${resolvedPath}`);
    const originalHost = parsedBase.host;
    const hostname = parsedBase.hostname;

    let pinIp: string;
    if (lbChoice) {
      // LB members carry a config-time-pinned IP (pool targets) or the client's
      // pinned IP (primary) — used directly, like the canary secondary.
      pinIp = lbChoice.resolvedIp;
    } else if (route.useSecondary) {
      pinIp = canary!.secondaryResolvedIp;
    } else {
      // Seed the pin cache from the registry value on first access.
      if (!pinnedIpCache.has(client.name)) {
        pinnedIpCache.set(client.name, { ip: client.resolved_ip, resolvedAt: Date.now() });
      }

      let pin = pinnedIpCache.get(client.name)!;

      // Only attempt re-resolution for hostnames (not raw IP literals).
      if (!isRawIpLiteral(hostname)) {
        try {
          pin = await refreshPinIfStale(hostname, pin);
          pinnedIpCache.set(client.name, pin);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return {
            isError: true,
            content: [{ type: "text", text: `Backend hostname now resolves to private IP: ${reason}` }],
          };
        }
      }
      pinIp = pin.ip;
    }

    parsedBase.hostname = pinIp;
    let url = parsedBase.toString();

    const method = tool.method.toUpperCase();
    let body: string | undefined;

    if (isDeleting(client.name)) {
      return {
        isError: true,
        content: [{ type: "text", text: "Client is being unregistered" }],
      };
    }

    const reqController = trackRequest(client.name);
    if (lbKey) incInflight(lbKey);

    if (method === "GET" || method === "DELETE") {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(remainingArgs)) {
        params.append(key, String(value));
      }
      const queryString = params.toString();
      if (queryString) {
        url = `${url}?${queryString}`;
      }
    } else if (graphqlCfg?.enabled) {
      body = JSON.stringify({ query: graphqlCfg.query, variables: remainingArgs });
    } else {
      body = JSON.stringify(remainingArgs);
    }

    // Inject per-client upstream credentials (decrypted at call time). Spread
    // first so the pinned Host and Content-Type set below always take precedence.
    const upstreamAuthHeaders: Record<string, string> = { ...(getUpstreamAuthHeaders(client.name) ?? {}) };
    // Outbound OAuth2 client-credentials — mint/reuse a short-lived token and inject
    // it as a Bearer (the MCP caller never sees the real client secret).
    const oauthBearer = await getOAuthBearer(client.name);
    if (oauthBearer) upstreamAuthHeaders.Authorization = `Bearer ${oauthBearer}`;

    // Response redaction paths for this tool (applied to JSON responses below).
    const redactionPaths = getRedactionPaths(client.name, tool.name);

    const startTime = Date.now();

    // GET / HEAD / OPTIONS are always retried.
    // DELETE / PUT are only retried when the client opts in via retry_non_safe_methods.
    const alwaysSafe = method === "GET" || method === "HEAD" || method === "OPTIONS";
    const optedIn = client.retry_non_safe_methods === true && (method === "DELETE" || method === "PUT");
    const isIdempotent = alwaysSafe || optedIn;

    const RETRYABLE_STATUSES = new Set([408, 429, 502, 503, 504]);
    const MAX_RETRIES = config.retryMaxAttempts;
    const BASE_DELAY = config.retryBaseDelayMs;

    let lastError: string | undefined;
    let lastStatus: number | undefined;

    try {
      for (let attempt = 0; attempt <= (isIdempotent ? MAX_RETRIES : 0); attempt++) {
        if (attempt > 0) {
          // Don't retry if circuit is now open
          if (!breaker.canRequest().allowed) break;
          const delay = BASE_DELAY * Math.pow(2, attempt - 1) + Math.random() * BASE_DELAY;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }

        // A1: build a fresh composed signal per attempt so the timeout is renewed each time.
        // reqController.signal stays persistent (external client cancellation).
        const attemptSignal = AbortSignal.any([reqController.signal, AbortSignal.timeout(effectiveTimeout)]);

        const fetchOptions: RequestInit =
          body !== undefined
            ? {
                method,
                headers: { ...upstreamAuthHeaders, "Content-Type": "application/json", Host: originalHost },
                body,
                redirect: "error" as RequestRedirect,
                signal: attemptSignal,
              }
            : {
                method,
                headers: { ...upstreamAuthHeaders, "Content-Type": "application/json", Host: originalHost },
                redirect: "error" as RequestRedirect,
                signal: attemptSignal,
              };

        try {
          const response = await fetch(url, fetchOptions);

          if (response.ok) {
            recordBreakerSuccess();

            // A2: read body with streaming cap
            const rawText = await readBodyWithCap(response);
            if (rawText === null) {
              proxyBodyCapRejections.inc({ client: client.name });
              log("warn", "Upstream response exceeded size limit", {
                tool: mcpToolName,
                client: client.name,
                limit: config.maxResponseBytes,
              });
              recordToolCall(Date.now() - startTime, true);
              recordUsage({
                clientName: client.name,
                toolName: tool.name,
                keyId: callerKey?.id ?? null,
                statusClass: "2xx",
                isError: true,
                durationMs: Date.now() - startTime,
              });
              proxyRequestDuration.observe(
                { client: client.name, method, status_class: "2xx" },
                (Date.now() - startTime) / 1000,
              );
              return {
                isError: true,
                content: [{ type: "text", text: "Upstream response exceeded MAX_RESPONSE_BYTES limit" }],
              };
            }

            const durationSuccess = (Date.now() - startTime) / 1000;
            proxyRequestDuration.observe({ client: client.name, method, status_class: "2xx" }, durationSuccess);
            if (attempt > 0) {
              proxyRetryAttempts.inc({ client: client.name, method, outcome: "success" });
            }
            log("info", "Tool call succeeded", {
              tool: mcpToolName,
              client: client.name,
              status: response.status,
              duration_ms: Date.now() - startTime,
              attempts: attempt + 1,
            });
            recordToolCall(Date.now() - startTime, false);
            recordUsage({
              clientName: client.name,
              toolName: tool.name,
              keyId: callerKey?.id ?? null,
              statusClass: "2xx",
              isError: false,
              durationMs: Date.now() - startTime,
            });

            // Fix 1 — Response header allowlist (no-op confirmation).
            // Only `content-type` is read internally to format the body; no upstream
            // response headers (Set-Cookie, Authorization, WWW-Authenticate, etc.) are
            // forwarded to the MCP caller. The return value carries only the body text,
            // so sensitive headers cannot leak through this code path.
            // Safe-to-forward allowlist (for future reference if headers are ever added):
            //   content-type, content-length, content-encoding, content-language,
            //   cache-control, etag, last-modified, retry-after
            const contentType = response.headers.get("content-type") ?? "";

            // Response pagination — follow cursor/page/link and aggregate the items
            // array across pages BEFORE redaction/guardrail/cache. JSON GET only; the
            // follow-ups reuse the pinned IP + Host of this request.
            let bodyText = rawText;
            const streamingCfg = getStreamingConfig(client.name, tool.name);
            if (streamingCfg?.enabled) {
              // Normalize a streaming-format body (NDJSON / SSE) into one aggregated
              // JSON result — MCP returns a single tool result, so the upstream stream
              // must complete (bounded by the response byte cap).
              bodyText = JSON.stringify(
                { events: parseStream(rawText, streamingCfg.format, streamingCfg.maxEvents) },
                null,
                2,
              );
            } else if (method === "GET" && contentType.includes("application/json")) {
              const paginationCfg = getPaginationConfig(client.name, tool.name);
              if (paginationCfg?.enabled) {
                const aggregated = await fetchAllPages(rawText, paginationCfg, {
                  targetBaseUrl,
                  resolvedPath,
                  baseQuery: new URLSearchParams(
                    Object.entries(remainingArgs).map(([k, v]) => [k, String(v)] as [string, string]),
                  ),
                  pinIp,
                  originalHost,
                  headers: upstreamAuthHeaders,
                  timeoutMs: effectiveTimeout,
                  externalSignal: reqController.signal,
                  maxBytes: config.maxResponseBytes,
                  firstBytes: new TextEncoder().encode(rawText).length,
                  firstLink: response.headers.get("link"),
                });
                if (aggregated !== null) bodyText = aggregated;
              }
            }

            // Declarative response transform on the parsed JSON body (pre-redaction).
            if (transformCfg?.enabled && transformCfg.response.length > 0) {
              try {
                bodyText = JSON.stringify(applyOps(JSON.parse(bodyText), transformCfg.response), null, 2);
              } catch {
                /* non-JSON body: leave unchanged */
              }
            }

            let responseText = bodyText;
            if (contentType.includes("application/json")) {
              // applyRedaction parses, redacts configured paths, and pretty-prints;
              // returns null on non-JSON so we fall back to the raw text.
              const processed = applyRedaction(redactionPaths, bodyText);
              if (processed !== null) responseText = processed;
            }

            // Response guardrail scan (spotlighting) — runs after redaction so the
            // envelope wraps the already-redacted text, not raw secrets.
            if (guardrails?.scanResponses) {
              const scan = applyResponseScan(responseText);
              recordGuardrailHit(client.name, tool.name, scan.flagged);
              if (scan.flagged) {
                log("warn", "Tool response flagged by guardrail scan", { tool: mcpToolName, client: client.name });
                responseText = scan.text;
              }
            }

            // Context budget — MUST run after redaction and the guardrail scan above:
            // this is the last transformation before the response is cached/returned,
            // so an opt-in llm_summarize call only ever sees already-sanitized text.
            const budgeted = await applyContextBudget(client.name, tool.name, mcpToolName, responseText);
            responseText = budgeted.text;

            if (responseCacheEnabled && cacheCfg && !route.useSecondary) {
              cacheSet(responseCacheKey, { content: [{ type: "text", text: responseText }] }, cacheCfg.ttlSeconds);
              cacheEvents.inc({ client: client.name, outcome: "store" });
            }
            return {
              content: [{ type: "text", text: responseText }],
            };
          }

          lastStatus = response.status;

          // Check if retryable
          if (isIdempotent && RETRYABLE_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
            proxyRetryAttempts.inc({ client: client.name, method, outcome: "retry" });
            // A3: handle Retry-After header (integer seconds OR HTTP-date)
            if (response.status === 429) {
              const waitMs = parseRetryAfter(response.headers.get("retry-after"));
              if (waitMs !== null && waitMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, waitMs));
              }
            }
            continue;
          }

          // Non-retryable error response
          proxyRequestDuration.observe(
            { client: client.name, method, status_class: httpStatusClass(response.status) },
            (Date.now() - startTime) / 1000,
          );
          recordBreakerFailure();
          log("warn", "Tool call returned error", {
            tool: mcpToolName,
            client: client.name,
            status: response.status,
            duration_ms: Date.now() - startTime,
            attempts: attempt + 1,
          });
          recordToolCall(Date.now() - startTime, true);
          recordUsage({
            clientName: client.name,
            toolName: tool.name,
            keyId: callerKey?.id ?? null,
            statusClass: httpStatusClass(response.status),
            isError: true,
            durationMs: Date.now() - startTime,
          });
          // Fix 3 — cap error-response body via the same readBodyWithCap helper used for
          // success responses, preventing a malicious upstream from OOM-ing the bridge with
          // an oversized error body (e.g. a 400 with a 10 GB payload).
          const errorBody = await readBodyWithCap(response);
          const errorBodyText =
            errorBody === null ? `[body truncated — exceeded ${config.maxResponseBytes} byte limit]` : errorBody;
          if (mockCfg?.enabled && mockCfg.mode === "fallback" && response.status >= 500) {
            return { content: [{ type: "text", text: mockCfg.response }] };
          }
          return {
            content: [{ type: "text", text: `REST API returned ${response.status}: ${errorBodyText}` }],
            isError: true,
          };
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          if (!isIdempotent || attempt >= MAX_RETRIES) {
            proxyRequestDuration.observe(
              { client: client.name, method, status_class: "error" },
              (Date.now() - startTime) / 1000,
            );
            recordBreakerFailure();
            log("error", "Tool call failed", {
              tool: mcpToolName,
              client: client.name,
              error: lastError,
              duration_ms: Date.now() - startTime,
              attempts: attempt + 1,
            });
            recordToolCall(Date.now() - startTime, true);
            recordUsage({
              clientName: client.name,
              toolName: tool.name,
              keyId: callerKey?.id ?? null,
              statusClass: "error",
              isError: true,
              durationMs: Date.now() - startTime,
            });
            if (mockCfg?.enabled && mockCfg.mode === "fallback") {
              return { content: [{ type: "text", text: mockCfg.response }] };
            }
            return {
              content: [{ type: "text", text: `Failed to reach ${client.name}: ${lastError}` }],
              isError: true,
            };
          }
          proxyRetryAttempts.inc({ client: client.name, method, outcome: "retry" });
        }
      }

      // Exhausted retries
      proxyRetryAttempts.inc({ client: client.name, method, outcome: "exhausted" });
      proxyRequestDuration.observe(
        { client: client.name, method, status_class: lastError ? "error" : httpStatusClass(lastStatus ?? 0) },
        (Date.now() - startTime) / 1000,
      );
      recordBreakerFailure();
      const errorMsg = lastError || `REST API returned ${lastStatus}`;
      log("error", "Tool call failed after retries", {
        tool: mcpToolName,
        client: client.name,
        error: errorMsg,
        duration_ms: Date.now() - startTime,
        attempts: MAX_RETRIES + 1,
      });
      recordToolCall(Date.now() - startTime, true);
      recordUsage({
        clientName: client.name,
        toolName: tool.name,
        keyId: callerKey?.id ?? null,
        statusClass: lastError ? "error" : httpStatusClass(lastStatus ?? 0),
        isError: true,
        durationMs: Date.now() - startTime,
      });
      if (mockCfg?.enabled && mockCfg.mode === "fallback") {
        return { content: [{ type: "text", text: mockCfg.response }] };
      }
      return {
        content: [
          { type: "text", text: `Failed after ${MAX_RETRIES + 1} attempts to reach ${client.name}: ${errorMsg}` },
        ],
        isError: true,
      };
    } finally {
      untrackRequest(client.name, reqController);
      if (lbKey) decInflight(lbKey);
    }
  };

  if (coalesceCfg?.enabled) {
    const { result, piggybacked } = await runCoalesced(coalesceKey, runRest);
    if (piggybacked) coalesceHits.inc({ client: client.name });
    return result;
  }
  return runRest();
}

/**
 * Dispatches a tool call over a WebSocket (per-tool `tool_ws` config).
 * Non-persistent (default): opens an ephemeral connection, sends the args as
 * JSON, and returns the first message. Persistent (`wsCfg.persistent`): stays
 * open across multiple messages, forwarding each as MCP progress (when the
 * caller requested it) and resolving with the last one — see
 * wsRequestPersistent in backends.ts. Either way, records success/failure on
 * the client breaker like the REST/MCP paths.
 */
async function dispatchWsToolCall(
  client: RegisteredClient,
  tool: RegisteredTool,
  rawArgs: Record<string, unknown>,
  wsCfg: { wsUrl: string; resolvedIp: string; enabled: boolean; persistent?: boolean },
  timeoutMs: number,
  breaker: ReturnType<typeof getCircuitBreaker>,
  callerKey: { id: number } | null,
  opts?: ToolCallOpts,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const startTime = Date.now();
  const cleanArgs = { ...rawArgs };
  delete cleanArgs.__confirm;
  delete cleanArgs.__approval_id;
  try {
    const text = wsCfg.persistent
      ? await wsRequestPersistent(
          wsCfg.wsUrl,
          JSON.stringify(cleanArgs),
          timeoutMs,
          config.maxResponseBytes,
          opts?.onProgress ? (data) => opts.onProgress!(0, undefined, data) : undefined,
        )
      : await wsRequest(wsCfg.wsUrl, JSON.stringify(cleanArgs), timeoutMs, config.maxResponseBytes);
    breaker.recordSuccess();
    const durationMs = Date.now() - startTime;
    recordToolCall(durationMs, false);
    recordUsage({
      clientName: client.name,
      toolName: tool.name,
      keyId: callerKey?.id ?? null,
      statusClass: "2xx",
      isError: false,
      durationMs,
    });
    proxyRequestDuration.observe({ client: client.name, method: "WS", status_class: "2xx" }, durationMs / 1000);
    return { content: [{ type: "text", text }] };
  } catch (err) {
    breaker.recordFailure();
    const durationMs = Date.now() - startTime;
    recordToolCall(durationMs, true);
    recordUsage({
      clientName: client.name,
      toolName: tool.name,
      keyId: callerKey?.id ?? null,
      statusClass: "error",
      isError: true,
      durationMs,
    });
    proxyRequestDuration.observe({ client: client.name, method: "WS", status_class: "error" }, durationMs / 1000);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `WebSocket call failed for '${client.name}': ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
}

/**
 * Dispatches a tool call to an MCP-kind upstream via the outbound client pool.
 * The transport-agnostic gates in proxyToolCall have already run; this only
 * validates args and forwards. No method-based retry — MCP calls carry no
 * idempotency guarantee, so the pool reconnects on the NEXT call rather than
 * replaying this one.
 */
async function dispatchMcpToolCall(
  client: RegisteredClient,
  tool: RegisteredTool,
  rawArgs: Record<string, unknown>,
  mcpToolName: string,
  effectiveTimeout: number,
  breaker: ReturnType<typeof getCircuitBreaker>,
  callerKey: { id: number } | null,
  scanResponses: boolean,
  opts?: ToolCallOpts,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const startTime = Date.now();

  // Same Ajv instance/behaviour as the REST path — removeAdditional strips
  // unknown keys (including the sensitivity __confirm flag) before dispatch.
  const argsToSend = { ...rawArgs };
  const validate = getOrCompile(client.name, tool.name, tool.inputSchema);
  if (!validate(argsToSend)) {
    const firstError = validate.errors?.[0];
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Argument validation failed: ${firstError ? `${firstError.instancePath || "/"}: ${firstError.message}` : "unknown error"}`,
        },
      ],
    };
  }

  const params: McpConnParams = {
    name: client.name,
    url: client.mcpUrl ?? client.base_url,
    transport: client.mcpTransport ?? "streamable-http",
    resolvedIp: client.resolved_ip,
    authHeaders: getUpstreamAuthHeaders(client.name) ?? undefined,
  };

  const result = await mcpUpstream.call(params, tool.upstreamName ?? tool.name, argsToSend, {
    timeoutMs: effectiveTimeout,
    maxBytes: config.maxResponseBytes,
    signal: opts?.signal,
    // Only ask the upstream for progress when the bridge itself has a
    // downstream sink to forward it to (the caller opted in via its own
    // _meta.progressToken) — never invent progress interest on its behalf.
    onprogress: opts?.onProgress ? (p) => opts.onProgress!(p.progress, p.total, p.message) : undefined,
  });

  const durationMs = Date.now() - startTime;
  // A caller-initiated cancellation is not an upstream health signal — it must
  // not be recorded against the breaker (mirrors how the REST path already
  // treats its own external cancellation distinctly from a real failure).
  const statusClass = result.cancelled ? "cancelled" : result.isError ? "error" : "2xx";
  if (!result.cancelled) {
    if (result.isError) breaker.recordFailure();
    else breaker.recordSuccess();
  }

  recordToolCall(durationMs, result.isError === true);
  recordUsage({
    clientName: client.name,
    toolName: tool.name,
    keyId: callerKey?.id ?? null,
    statusClass,
    isError: result.isError === true,
    durationMs,
  });
  proxyRequestDuration.observe({ client: client.name, method: "MCP", status_class: statusClass }, durationMs / 1000);
  log(
    result.cancelled ? "info" : result.isError ? "warn" : "info",
    result.cancelled
      ? "MCP tool call cancelled by caller"
      : result.isError
        ? "MCP tool call returned error"
        : "MCP tool call succeeded",
    { tool: mcpToolName, client: client.name, duration_ms: durationMs },
  );

  // Response redaction parity with the REST path — applies to JSON text parts.
  if (!result.isError) {
    const paths = getRedactionPaths(client.name, tool.name);
    if (paths.length > 0) {
      result.content = result.content.map((item) =>
        item.type === "text" ? { ...item, text: applyRedaction(paths, item.text) ?? item.text } : item,
      );
    }
    // Response guardrail scan parity — wrap flagged text parts (after redaction).
    if (scanResponses) {
      let anyFlagged = false;
      result.content = result.content.map((item) => {
        if (item.type !== "text") return item;
        const scan = applyResponseScan(item.text);
        if (scan.flagged) {
          anyFlagged = true;
          log("warn", "MCP tool response flagged by guardrail scan", { tool: mcpToolName, client: client.name });
        }
        return scan.flagged ? { ...item, text: scan.text } : item;
      });
      recordGuardrailHit(client.name, tool.name, anyFlagged);
    }

    // Context budget parity with the REST path — MUST run after redaction and
    // the guardrail scan above so an opt-in llm_summarize call only ever sees
    // already-sanitized text, right before the response goes back to the caller.
    result.content = await Promise.all(
      result.content.map(async (item) => {
        if (item.type !== "text") return item;
        const budgeted = await applyContextBudget(client.name, tool.name, mcpToolName, item.text);
        return budgeted.applied === "none" ? item : { ...item, text: budgeted.text };
      }),
    );
  }

  return result;
}
