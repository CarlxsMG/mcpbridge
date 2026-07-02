import type { Request, Response, NextFunction, Express } from "express";
import { registry, TOOL_KEY_SEPARATOR, ToolOverrideError } from "../registry.js";
import { proxyToolCall } from "../proxy.js";
import { adminAuth } from "../middleware/auth.js";
import { hashApiKey } from "../security/key-hash.js";
import { setToolSensitive } from "../tool-sensitivity.js";
import { setRedactionPaths } from "../redaction.js";
import { setGuardrails, MAX_DENY_PATTERNS, MAX_DENY_PATTERN_LENGTH } from "../guardrails.js";
import { listExamples, createExample, deleteExample } from "../tool-examples.js";
import { getCanary, setCanary } from "../canary.js";
import { setToolCacheConfig, purgeToolCache, MAX_CACHE_TTL_SECONDS } from "../response-cache.js";
import { getLb, setLb, addUpstream, updateUpstream, removeUpstream, type LbStrategy } from "../load-balancer.js";
import { setPaginationConfig, MAX_PAGINATION_PAGES, type PaginationStrategy } from "../pagination.js";
import { setStreamingConfig, MAX_STREAM_EVENTS, type StreamFormat } from "../streaming.js";
import { setToolTransform, MAX_TRANSFORM_OPS, type TransformOp } from "../transform.js";
import { setToolMock, type MockMode } from "../mock.js";
import { setApprovalRequired, listApprovals, getApproval, decideApproval, type ApprovalStatus } from "../approvals.js";
import { listTraffic, getTraffic } from "../traffic.js";
import { setMonitor, deleteMonitor, listMonitors } from "../monitor.js";
import { setToolGraphql, setToolWs } from "../backends.js";
import { getClientOAuth, setClientOAuth } from "../oauth.js";
import { getClientTeam, canAccessClient } from "../teams.js";
import { recordAudit, actorFromRequest, listAuditLog, exportAuditLog, verifyAuditChain } from "../admin/audit.js";
import { getAllCircuitStates } from "../circuit-breaker.js";
import {
  listUsers,
  findUserByUsername,
  createUser,
  updateUser,
  deleteUser,
  countActiveAdmins,
  isAdminRole,
} from "../security/user-store.js";
import { revokeAllSessionsForUser } from "../security/session-store.js";
import type { ClientGuardConfig, ToolGuardConfig, ClientStatus, ToolOverride, ToolGuardrails } from "../types.js";
import type { AdminRole } from "../security/user-store.js";

function requestId(res: Response): string | null {
  return (res.locals.requestId as string) ?? null;
}

/** The caller's tenancy scope: a team id, null for a super-admin session, or undefined for a bearer caller (super-admin). */
export function callerTeamId(req: Request): number | null | undefined {
  return req.authContext?.method === "session" ? (req.authContext.teamId ?? null) : undefined;
}

/**
 * Tenancy guard for a single-client route. Returns true when the caller may act
 * on the client (or the client doesn't exist — the route's own 404 handles
 * that). When it returns false it has already written a 404 with the same shape
 * as "client not found", so a scoped caller can't even distinguish existence.
 */
function ensureClientAccess(req: Request, res: Response, clientName: string): boolean {
  const clientTeam = getClientTeam(clientName);
  if (clientTeam === undefined) return true; // unknown client — let the handler 404 normally
  if (canAccessClient(callerTeamId(req), clientTeam)) return true;
  res.status(404).json({ error: { code: "CLIENT_NOT_FOUND", message: "Client not found", request_id: requestId(res) } });
  return false;
}

/** Admin-only for session callers (viewer/operator/auditor are rejected). Bearer callers always pass. */
export function requireAdminRole(req: Request, res: Response, next: NextFunction): void {
  if (req.authContext?.method === "session" && req.authContext.role !== "admin") {
    res.status(403).json({ error: { code: "FORBIDDEN", message: "This action requires the admin role", request_id: requestId(res) } });
    return;
  }
  next();
}

/**
 * Validates a per-tool response-cache config payload. `null` or `false` clears
 * the config; an object opts the tool in (defaulting enabled:true) with a
 * bounded integer TTL in seconds.
 */
function validateCacheInput(
  raw: unknown,
): { ok: true; value: { enabled: boolean; ttlSeconds: number } | null } | { ok: false; message: string } {
  if (raw === null || raw === false) return { ok: true, value: null };
  if (typeof raw !== "object") return { ok: false, message: "cache must be an object, null, or false" };
  const obj = raw as Record<string, unknown>;
  const enabled = obj.enabled !== false;
  const ttlSeconds = typeof obj.ttlSeconds === "number" ? obj.ttlSeconds : NaN;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_CACHE_TTL_SECONDS) {
    return { ok: false, message: `cache.ttlSeconds must be an integer between 1 and ${MAX_CACHE_TTL_SECONDS}` };
  }
  return { ok: true, value: { enabled, ttlSeconds } };
}

interface PaginationInput {
  enabled: boolean;
  strategy: PaginationStrategy;
  itemsPath: string;
  cursorResponsePath?: string;
  cursorParam?: string;
  pageParam?: string;
  maxPages: number;
}

/**
 * Validates a per-tool pagination config payload. `null`/`false` clears it. Each
 * strategy has its own required fields (cursor: response-path + query param;
 * page: page param; link: none).
 */
function validatePaginationInput(
  raw: unknown,
): { ok: true; value: PaginationInput | null } | { ok: false; message: string } {
  if (raw === null || raw === false) return { ok: true, value: null };
  if (typeof raw !== "object") return { ok: false, message: "pagination must be an object, null, or false" };
  const obj = raw as Record<string, unknown>;
  const strategy = obj.strategy;
  if (strategy !== "cursor" && strategy !== "page" && strategy !== "link") {
    return { ok: false, message: "pagination.strategy must be 'cursor', 'page', or 'link'" };
  }
  const maxPages = typeof obj.maxPages === "number" ? obj.maxPages : NaN;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGINATION_PAGES) {
    return { ok: false, message: `pagination.maxPages must be an integer between 1 and ${MAX_PAGINATION_PAGES}` };
  }
  const value: PaginationInput = {
    enabled: obj.enabled !== false,
    strategy,
    itemsPath: typeof obj.itemsPath === "string" ? obj.itemsPath : "",
    maxPages,
  };
  if (strategy === "cursor") {
    const crp = typeof obj.cursorResponsePath === "string" ? obj.cursorResponsePath : "";
    const cp = typeof obj.cursorParam === "string" ? obj.cursorParam : "";
    if (!crp || !cp) return { ok: false, message: "cursor strategy requires cursorResponsePath and cursorParam" };
    value.cursorResponsePath = crp;
    value.cursorParam = cp;
  } else if (strategy === "page") {
    const pp = typeof obj.pageParam === "string" ? obj.pageParam : "";
    if (!pp) return { ok: false, message: "page strategy requires pageParam" };
    value.pageParam = pp;
  }
  return { ok: true, value };
}

/** Validates a per-tool streaming-normalization payload. `null`/`false` clears it. */
function validateStreamingInput(
  raw: unknown,
): { ok: true; value: { enabled: boolean; format: StreamFormat; maxEvents: number } | null } | { ok: false; message: string } {
  if (raw === null || raw === false) return { ok: true, value: null };
  if (typeof raw !== "object") return { ok: false, message: "streaming must be an object, null, or false" };
  const obj = raw as Record<string, unknown>;
  if (obj.format !== "ndjson" && obj.format !== "sse") return { ok: false, message: "streaming.format must be 'ndjson' or 'sse'" };
  const maxEvents = typeof obj.maxEvents === "number" ? obj.maxEvents : NaN;
  if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > MAX_STREAM_EVENTS) {
    return { ok: false, message: `streaming.maxEvents must be an integer between 1 and ${MAX_STREAM_EVENTS}` };
  }
  return { ok: true, value: { enabled: obj.enabled !== false, format: obj.format, maxEvents } };
}

/** Validates an ordered transform op list (set/remove/rename/copy). */
function validateOps(raw: unknown, label: string): { ok: true; value: TransformOp[] } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, message: `${label} must be an array of ops` };
  if (raw.length > MAX_TRANSFORM_OPS) return { ok: false, message: `${label} exceeds ${MAX_TRANSFORM_OPS} ops` };
  const ops: TransformOp[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") return { ok: false, message: `${label}: each op must be an object` };
    const o = entry as Record<string, unknown>;
    if (o.op === "set") {
      if (typeof o.path !== "string" || !("value" in o)) return { ok: false, message: `${label}: set requires path + value` };
      ops.push({ op: "set", path: o.path, value: o.value });
    } else if (o.op === "remove") {
      if (typeof o.path !== "string") return { ok: false, message: `${label}: remove requires path` };
      ops.push({ op: "remove", path: o.path });
    } else if (o.op === "rename" || o.op === "copy") {
      if (typeof o.from !== "string" || typeof o.to !== "string") return { ok: false, message: `${label}: ${o.op} requires from + to` };
      ops.push({ op: o.op, from: o.from, to: o.to });
    } else {
      return { ok: false, message: `${label}: unknown op '${String(o.op)}'` };
    }
  }
  return { ok: true, value: ops };
}

/** Validates a per-tool transform payload. `null`/`false` clears it. */
function validateTransformInput(
  raw: unknown,
): { ok: true; value: { enabled: boolean; request: TransformOp[]; response: TransformOp[] } | null } | { ok: false; message: string } {
  if (raw === null || raw === false) return { ok: true, value: null };
  if (typeof raw !== "object") return { ok: false, message: "transform must be an object, null, or false" };
  const obj = raw as Record<string, unknown>;
  const req = validateOps(obj.request, "transform.request");
  if (!req.ok) return req;
  const resp = validateOps(obj.response, "transform.response");
  if (!resp.ok) return resp;
  return { ok: true, value: { enabled: obj.enabled !== false, request: req.value, response: resp.value } };
}

/** Validates a per-tool mock payload. `null`/`false` clears it. */
function validateMockInput(
  raw: unknown,
): { ok: true; value: { enabled: boolean; mode: MockMode; response: string } | null } | { ok: false; message: string } {
  if (raw === null || raw === false) return { ok: true, value: null };
  if (typeof raw !== "object") return { ok: false, message: "mock must be an object, null, or false" };
  const obj = raw as Record<string, unknown>;
  if (obj.mode !== "always" && obj.mode !== "fallback") return { ok: false, message: "mock.mode must be 'always' or 'fallback'" };
  if (typeof obj.response !== "string") return { ok: false, message: "mock.response must be a string" };
  if (obj.response.length > 1_000_000) return { ok: false, message: "mock.response too large (max 1MB)" };
  return { ok: true, value: { enabled: obj.enabled !== false, mode: obj.mode, response: obj.response } };
}

/** Tenancy administration: only a super-admin session (admin role + no team) passes. Bearer callers always pass. */
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.authContext?.method === "session" && (req.authContext.role !== "admin" || (req.authContext.teamId ?? null) !== null)) {
    res.status(403).json({ error: { code: "FORBIDDEN", message: "This action requires a super-admin (admin role, no team)", request_id: requestId(res) } });
    return;
  }
  next();
}

/** Operational mutations: admin + operator sessions pass; auditor/viewer are rejected. Bearer callers always pass. */
export function requireOperator(req: Request, res: Response, next: NextFunction): void {
  if (req.authContext?.method === "session" && req.authContext.role !== "admin" && req.authContext.role !== "operator") {
    res.status(403).json({ error: { code: "FORBIDDEN", message: "This action requires the admin or operator role", request_id: requestId(res) } });
    return;
  }
  next();
}

function validateToolGuardInput(input: unknown): { ok: true; value: ToolGuardConfig | null } | { ok: false; message: string } {
  if (input === null) return { ok: true, value: null };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, message: "guards must be an object or null" };
  }
  const g = input as Record<string, unknown>;
  const value: ToolGuardConfig = {};

  if (g.rateLimitPerMin !== undefined) {
    if (typeof g.rateLimitPerMin !== "number" || !Number.isFinite(g.rateLimitPerMin) || g.rateLimitPerMin <= 0) {
      return { ok: false, message: "guards.rateLimitPerMin must be a positive number" };
    }
    value.rateLimitPerMin = g.rateLimitPerMin;
  }
  if (g.timeoutMs !== undefined) {
    if (typeof g.timeoutMs !== "number" || !Number.isFinite(g.timeoutMs) || g.timeoutMs <= 0) {
      return { ok: false, message: "guards.timeoutMs must be a positive number" };
    }
    value.timeoutMs = g.timeoutMs;
  }
  if (g.allowedApiKeys !== undefined) {
    if (!Array.isArray(g.allowedApiKeys) || !g.allowedApiKeys.every((k) => typeof k === "string" && k.length > 0)) {
      return { ok: false, message: "guards.allowedApiKeys must be an array of non-empty strings" };
    }
    // Raw keys are hashed here, at the boundary — they are never persisted or echoed back.
    value.allowedKeyHashes = (g.allowedApiKeys as string[]).map((k) => hashApiKey(k));
  }
  return { ok: true, value };
}

function validateToolOverrideInput(input: unknown): { ok: true; value: ToolOverride | null } | { ok: false; message: string } {
  if (input === null) return { ok: true, value: null };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, message: "overrides must be an object or null" };
  }
  const o = input as Record<string, unknown>;
  const value: ToolOverride = {};

  if (o.description !== undefined && o.description !== null) {
    if (typeof o.description !== "string" || o.description.length > 4096) {
      return { ok: false, message: "overrides.description must be a string (<= 4096 chars) or null" };
    }
    if (o.description.length > 0) value.description = o.description;
  }

  if (o.params !== undefined && o.params !== null) {
    if (typeof o.params !== "object" || Array.isArray(o.params)) {
      return { ok: false, message: "overrides.params must be an object" };
    }
    const params: NonNullable<ToolOverride["params"]> = {};
    for (const [p, raw] of Object.entries(o.params as Record<string, unknown>)) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        return { ok: false, message: `overrides.params.${p} must be an object` };
      }
      const desc = (raw as Record<string, unknown>).description;
      if (desc !== undefined && (typeof desc !== "string" || desc.length > 2048)) {
        return { ok: false, message: `overrides.params.${p}.description must be a string (<= 2048 chars)` };
      }
      if (typeof desc === "string" && desc.length > 0) params[p] = { description: desc };
    }
    if (Object.keys(params).length > 0) value.params = params;
  }

  if (o.displayName !== undefined && o.displayName !== null) {
    if (typeof o.displayName !== "string" || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(o.displayName)) {
      return { ok: false, message: "overrides.displayName must be lowercase alphanumeric with hyphens/underscores, 1-63 chars" };
    }
    value.displayName = o.displayName;
  }

  if (value.description === undefined && value.params === undefined && value.displayName === undefined) {
    return { ok: true, value: null };
  }
  return { ok: true, value };
}

function validateGuardrailsInput(input: unknown): { ok: true; value: ToolGuardrails | null } | { ok: false; message: string } {
  if (input === null) return { ok: true, value: null };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, message: "guardrails must be an object or null" };
  }
  const g = input as Record<string, unknown>;
  const value: ToolGuardrails = { denyPatterns: [], blockSecrets: false, scanResponses: false };

  if (g.denyPatterns !== undefined) {
    if (!Array.isArray(g.denyPatterns) || !g.denyPatterns.every((p) => typeof p === "string")) {
      return { ok: false, message: "guardrails.denyPatterns must be an array of strings" };
    }
    if (g.denyPatterns.length > MAX_DENY_PATTERNS) {
      return { ok: false, message: `guardrails.denyPatterns allows at most ${MAX_DENY_PATTERNS} entries` };
    }
    for (const p of g.denyPatterns as string[]) {
      if (p.length > MAX_DENY_PATTERN_LENGTH) {
        return { ok: false, message: `guardrails.denyPatterns entries must be <= ${MAX_DENY_PATTERN_LENGTH} chars` };
      }
      try {
        new RegExp(p);
      } catch {
        return { ok: false, message: `guardrails.denyPatterns contains an invalid regex: ${p.slice(0, 40)}` };
      }
    }
    value.denyPatterns = (g.denyPatterns as string[]).map((p) => p.trim()).filter(Boolean);
  }
  if (g.blockSecrets !== undefined) {
    if (typeof g.blockSecrets !== "boolean") return { ok: false, message: "guardrails.blockSecrets must be a boolean" };
    value.blockSecrets = g.blockSecrets;
  }
  if (g.scanResponses !== undefined) {
    if (typeof g.scanResponses !== "boolean") return { ok: false, message: "guardrails.scanResponses must be a boolean" };
    value.scanResponses = g.scanResponses;
  }

  if (value.denyPatterns.length === 0 && !value.blockSecrets && !value.scanResponses) return { ok: true, value: null };
  return { ok: true, value };
}

function validateClientGuardInput(input: unknown): { ok: true; value: ClientGuardConfig | null } | { ok: false; message: string } {
  if (input === null) return { ok: true, value: null };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, message: "guards must be an object or null" };
  }
  const g = input as Record<string, unknown>;
  const cbInput = g.circuitBreaker;
  if (cbInput === undefined) return { ok: true, value: {} };
  if (typeof cbInput !== "object" || cbInput === null || Array.isArray(cbInput)) {
    return { ok: false, message: "guards.circuitBreaker must be an object" };
  }
  const cb = cbInput as Record<string, unknown>;
  const numericFields = ["failureThreshold", "resetTimeoutMs", "halfOpenTimeoutMs", "windowMs"] as const;
  const value: NonNullable<ClientGuardConfig["circuitBreaker"]> = {};
  for (const field of numericFields) {
    if (cb[field] === undefined) continue;
    if (typeof cb[field] !== "number" || !Number.isFinite(cb[field] as number) || (cb[field] as number) <= 0) {
      return { ok: false, message: `guards.circuitBreaker.${field} must be a positive number` };
    }
    value[field] = cb[field] as number;
  }
  return { ok: true, value: { circuitBreaker: value } };
}

export function adminRoutes(app: Express): void {
  // ── Clients ─────────────────────────────────────────────────────────────

  app.get("/admin-api/clients", adminAuth, (req: Request, res: Response) => {
    const { q, status, enabled, cursor, limit } = req.query;
    const teamId = callerTeamId(req);
    const result = registry.listClientsSummary({
      q: typeof q === "string" ? q : undefined,
      status: typeof status === "string" ? (status as ClientStatus) : undefined,
      enabled: enabled === "true" ? true : enabled === "false" ? false : undefined,
      cursor: typeof cursor === "string" ? cursor : undefined,
      limit: typeof limit === "string" ? Number(limit) : undefined,
      // Scope the listing for team users; super-admins (null/undefined) see all.
      teamId: typeof teamId === "number" ? teamId : undefined,
    });
    res.status(200).json(result);
  });

  app.get("/admin-api/clients/:name", adminAuth, (req: Request<{ name: string }>, res: Response) => {
    if (!ensureClientAccess(req, res, req.params.name)) return;
    const detail = registry.getClientDetail(req.params.name);
    if (!detail) {
      res.status(404).json({ error: { code: "CLIENT_NOT_FOUND", message: "Client not found", request_id: requestId(res) } });
      return;
    }
    res.status(200).json(detail);
  });

  app.patch("/admin-api/clients/:name", adminAuth, requireOperator, async (req: Request<{ name: string }>, res: Response) => {
    const { name } = req.params;
    if (!ensureClientAccess(req, res, name)) return;
    const body = (req.body as Record<string, unknown>) ?? {};
    const actor = actorFromRequest(req);

    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") {
        res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "enabled must be a boolean", request_id: requestId(res) } });
        return;
      }
      const ok = await registry.setClientEnabled(name, body.enabled);
      if (!ok) {
        res.status(404).json({ error: { code: "CLIENT_NOT_FOUND", message: "Client not found", request_id: requestId(res) } });
        return;
      }
      recordAudit(actor, body.enabled ? "client.enable" : "client.disable", name);
    }

    if (body.guards !== undefined) {
      const parsed = validateClientGuardInput(body.guards);
      if (!parsed.ok) {
        res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.message, request_id: requestId(res) } });
        return;
      }
      const ok = await registry.setClientGuards(name, parsed.value);
      if (!ok) {
        res.status(404).json({ error: { code: "CLIENT_NOT_FOUND", message: "Client not found", request_id: requestId(res) } });
        return;
      }
      recordAudit(actor, "client.guards.update", name, { guards: parsed.value });
    }

    res.status(200).json({ status: "updated", name });
  });

  app.patch("/admin-api/clients", adminAuth, requireOperator, async (req: Request, res: Response) => {
    const body = (req.body as Record<string, unknown>) ?? {};
    const names = body.names;
    const enabled = body.enabled;
    if (!Array.isArray(names) || names.some((n) => typeof n !== "string") || typeof enabled !== "boolean") {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "names (string[]) and enabled (boolean) are required", request_id: requestId(res) } });
      return;
    }
    const actor = actorFromRequest(req);
    const results: Record<string, boolean> = {};
    for (const name of names as string[]) {
      results[name] = await registry.setClientEnabled(name, enabled);
      if (results[name]) recordAudit(actor, enabled ? "client.enable" : "client.disable", name, { bulk: true });
    }
    res.status(200).json({ results });
  });

  // ── Tools ───────────────────────────────────────────────────────────────

  app.patch(
    "/admin-api/clients/:name/tools/:tool",
    adminAuth,
    requireOperator,
    async (req: Request<{ name: string; tool: string }>, res: Response) => {
      const { name, tool } = req.params;
      if (!ensureClientAccess(req, res, name)) return;
      const body = (req.body as Record<string, unknown>) ?? {};
      const actor = actorFromRequest(req);

      if (body.enabled !== undefined) {
        if (typeof body.enabled !== "boolean") {
          res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "enabled must be a boolean", request_id: requestId(res) } });
          return;
        }
        const ok = await registry.setToolEnabled(name, tool, body.enabled);
        if (!ok) {
          res.status(404).json({ error: { code: "TOOL_NOT_FOUND", message: "Client or tool not found", request_id: requestId(res) } });
          return;
        }
        recordAudit(actor, body.enabled ? "tool.enable" : "tool.disable", `${name}${TOOL_KEY_SEPARATOR}${tool}`);
      }

      if (body.guards !== undefined) {
        const parsed = validateToolGuardInput(body.guards);
        if (!parsed.ok) {
          res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.message, request_id: requestId(res) } });
          return;
        }
        const ok = await registry.setToolGuards(name, tool, parsed.value);
        if (!ok) {
          res.status(404).json({ error: { code: "TOOL_NOT_FOUND", message: "Client or tool not found", request_id: requestId(res) } });
          return;
        }
        recordAudit(actor, "tool.guards.update", `${name}${TOOL_KEY_SEPARATOR}${tool}`);
      }

      if (body.overrides !== undefined) {
        const parsed = validateToolOverrideInput(body.overrides);
        if (!parsed.ok) {
          res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.message, request_id: requestId(res) } });
          return;
        }
        let ok: boolean;
        try {
          ok = await registry.setToolOverride(name, tool, parsed.value);
        } catch (err) {
          if (err instanceof ToolOverrideError) {
            const status = err.code === "TOOL_ALIAS_CONFLICT" ? 409 : 400;
            res.status(status).json({ error: { code: err.code, message: err.message, request_id: requestId(res) } });
            return;
          }
          throw err;
        }
        if (!ok) {
          res.status(404).json({ error: { code: "TOOL_NOT_FOUND", message: "Client or tool not found", request_id: requestId(res) } });
          return;
        }
        recordAudit(actor, "tool.override.update", `${name}${TOOL_KEY_SEPARATOR}${tool}`);
      }

      if (body.sensitive !== undefined) {
        if (body.sensitive !== null && typeof body.sensitive !== "boolean") {
          res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "sensitive must be a boolean or null", request_id: requestId(res) } });
          return;
        }
        const ok = setToolSensitive(name, tool, body.sensitive);
        if (!ok) {
          res.status(404).json({ error: { code: "TOOL_NOT_FOUND", message: "Client or tool not found", request_id: requestId(res) } });
          return;
        }
        recordAudit(actor, "tool.sensitive.set", `${name}${TOOL_KEY_SEPARATOR}${tool}`, { sensitive: body.sensitive });
      }

      if (body.redactPaths !== undefined) {
        if (!Array.isArray(body.redactPaths) || !body.redactPaths.every((p) => typeof p === "string")) {
          res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "redactPaths must be an array of strings", request_id: requestId(res) } });
          return;
        }
        const ok = setRedactionPaths(name, tool, body.redactPaths as string[]);
        if (!ok) {
          res.status(404).json({ error: { code: "TOOL_NOT_FOUND", message: "Client or tool not found", request_id: requestId(res) } });
          return;
        }
        recordAudit(actor, "tool.redaction.set", `${name}${TOOL_KEY_SEPARATOR}${tool}`, { count: (body.redactPaths as string[]).length });
      }

      if (body.guardrails !== undefined) {
        const parsed = validateGuardrailsInput(body.guardrails);
        if (!parsed.ok) {
          res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.message, request_id: requestId(res) } });
          return;
        }
        const ok = setGuardrails(name, tool, parsed.value);
        if (!ok) {
          res.status(404).json({ error: { code: "TOOL_NOT_FOUND", message: "Client or tool not found", request_id: requestId(res) } });
          return;
        }
        recordAudit(actor, "tool.guardrails.set", `${name}${TOOL_KEY_SEPARATOR}${tool}`, {
          denyPatterns: parsed.value?.denyPatterns.length ?? 0,
          blockSecrets: parsed.value?.blockSecrets ?? false,
          scanResponses: parsed.value?.scanResponses ?? false,
        });
      }

      if (body.cache !== undefined) {
        const parsed = validateCacheInput(body.cache);
        if (!parsed.ok) {
          res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.message, request_id: requestId(res) } });
          return;
        }
        const ok = setToolCacheConfig(name, tool, parsed.value);
        if (!ok) {
          res.status(404).json({ error: { code: "TOOL_NOT_FOUND", message: "Client or tool not found", request_id: requestId(res) } });
          return;
        }
        recordAudit(actor, parsed.value ? "tool.cache.set" : "tool.cache.clear", `${name}${TOOL_KEY_SEPARATOR}${tool}`, parsed.value ? { ttlSeconds: parsed.value.ttlSeconds, enabled: parsed.value.enabled } : undefined);
      }

      if (body.pagination !== undefined) {
        const parsed = validatePaginationInput(body.pagination);
        if (!parsed.ok) {
          res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.message, request_id: requestId(res) } });
          return;
        }
        const ok = setPaginationConfig(name, tool, parsed.value);
        if (!ok) {
          res.status(404).json({ error: { code: "TOOL_NOT_FOUND", message: "Client or tool not found", request_id: requestId(res) } });
          return;
        }
        recordAudit(actor, parsed.value ? "tool.pagination.set" : "tool.pagination.clear", `${name}${TOOL_KEY_SEPARATOR}${tool}`, parsed.value ? { strategy: parsed.value.strategy, maxPages: parsed.value.maxPages } : undefined);
      }

      if (body.streaming !== undefined) {
        const parsed = validateStreamingInput(body.streaming);
        if (!parsed.ok) {
          res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.message, request_id: requestId(res) } });
          return;
        }
        const ok = setStreamingConfig(name, tool, parsed.value);
        if (!ok) {
          res.status(404).json({ error: { code: "TOOL_NOT_FOUND", message: "Client or tool not found", request_id: requestId(res) } });
          return;
        }
        recordAudit(actor, parsed.value ? "tool.streaming.set" : "tool.streaming.clear", `${name}${TOOL_KEY_SEPARATOR}${tool}`, parsed.value ? { format: parsed.value.format } : undefined);
      }

      if (body.transform !== undefined) {
        const parsed = validateTransformInput(body.transform);
        if (!parsed.ok) {
          res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.message, request_id: requestId(res) } });
          return;
        }
        const ok = setToolTransform(name, tool, parsed.value);
        if (!ok) {
          res.status(404).json({ error: { code: "TOOL_NOT_FOUND", message: "Client or tool not found", request_id: requestId(res) } });
          return;
        }
        recordAudit(actor, parsed.value ? "tool.transform.set" : "tool.transform.clear", `${name}${TOOL_KEY_SEPARATOR}${tool}`, parsed.value ? { request: parsed.value.request.length, response: parsed.value.response.length } : undefined);
      }

      if (body.mock !== undefined) {
        const parsed = validateMockInput(body.mock);
        if (!parsed.ok) {
          res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.message, request_id: requestId(res) } });
          return;
        }
        const ok = setToolMock(name, tool, parsed.value);
        if (!ok) {
          res.status(404).json({ error: { code: "TOOL_NOT_FOUND", message: "Client or tool not found", request_id: requestId(res) } });
          return;
        }
        recordAudit(actor, parsed.value ? "tool.mock.set" : "tool.mock.clear", `${name}${TOOL_KEY_SEPARATOR}${tool}`, parsed.value ? { mode: parsed.value.mode } : undefined);
      }

      if (body.requiresApproval !== undefined) {
        if (typeof body.requiresApproval !== "boolean") {
          res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "requiresApproval must be a boolean", request_id: requestId(res) } });
          return;
        }
        const ok = setApprovalRequired(name, tool, body.requiresApproval);
        if (!ok) {
          res.status(404).json({ error: { code: "TOOL_NOT_FOUND", message: "Client or tool not found", request_id: requestId(res) } });
          return;
        }
        recordAudit(actor, body.requiresApproval ? "tool.approval.enable" : "tool.approval.disable", `${name}${TOOL_KEY_SEPARATOR}${tool}`);
      }

      if (body.monitor !== undefined) {
        if (body.monitor === null || body.monitor === false) {
          deleteMonitor(name, tool);
          recordAudit(actor, "tool.monitor.clear", `${name}${TOOL_KEY_SEPARATOR}${tool}`);
        } else if (typeof body.monitor === "object") {
          const mo = body.monitor as Record<string, unknown>;
          const exampleId = typeof mo.exampleId === "number" ? mo.exampleId : NaN;
          if (!Number.isInteger(exampleId)) {
            res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "monitor.exampleId (number) is required", request_id: requestId(res) } });
            return;
          }
          const result = setMonitor(name, tool, {
            exampleId,
            intervalMinutes: typeof mo.intervalMinutes === "number" ? mo.intervalMinutes : 15,
            enabled: mo.enabled !== false,
          });
          if (!result.ok) {
            res.status(result.error === "TOOL_NOT_LIVE" ? 404 : 400).json({ error: { code: result.error, message: result.error, request_id: requestId(res) } });
            return;
          }
          recordAudit(actor, "tool.monitor.set", `${name}${TOOL_KEY_SEPARATOR}${tool}`, { exampleId });
        } else {
          res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "monitor must be an object, null, or false", request_id: requestId(res) } });
          return;
        }
      }

      if (body.graphql !== undefined) {
        if (body.graphql === null || body.graphql === false) {
          setToolGraphql(name, tool, null);
          recordAudit(actor, "tool.graphql.clear", `${name}${TOOL_KEY_SEPARATOR}${tool}`);
        } else {
          const g = body.graphql as Record<string, unknown>;
          const query = typeof g?.query === "string" ? g.query.trim() : "";
          if (!query) {
            res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "graphql.query (non-empty string) is required", request_id: requestId(res) } });
            return;
          }
          if (!setToolGraphql(name, tool, { enabled: g.enabled !== false, query })) {
            res.status(404).json({ error: { code: "TOOL_NOT_FOUND", message: "Client or tool not found", request_id: requestId(res) } });
            return;
          }
          recordAudit(actor, "tool.graphql.set", `${name}${TOOL_KEY_SEPARATOR}${tool}`);
        }
      }

      if (body.ws !== undefined) {
        if (body.ws === null || body.ws === false) {
          await setToolWs(name, tool, null);
          recordAudit(actor, "tool.ws.clear", `${name}${TOOL_KEY_SEPARATOR}${tool}`);
        } else {
          const w = body.ws as Record<string, unknown>;
          const wsUrl = typeof w?.wsUrl === "string" ? w.wsUrl : "";
          if (!wsUrl) {
            res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "ws.wsUrl (ws:// or wss://) is required", request_id: requestId(res) } });
            return;
          }
          const result = await setToolWs(name, tool, { enabled: w.enabled !== false, wsUrl });
          if (!result.ok) {
            res.status(result.error === "TOOL_NOT_FOUND" ? 404 : 400).json({ error: { code: result.error, message: result.reason ?? result.error, request_id: requestId(res) } });
            return;
          }
          recordAudit(actor, "tool.ws.set", `${name}${TOOL_KEY_SEPARATOR}${tool}`);
        }
      }

      res.status(200).json({ status: "updated", name, tool });
    }
  );

  app.patch("/admin-api/clients/:name/tools", adminAuth, requireOperator, async (req: Request<{ name: string }>, res: Response) => {
    const { name } = req.params;
    const body = (req.body as Record<string, unknown>) ?? {};
    const toolNames = body.tool_names;
    const enabled = body.enabled;
    if (!Array.isArray(toolNames) || toolNames.some((n) => typeof n !== "string") || typeof enabled !== "boolean") {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "tool_names (string[]) and enabled (boolean) are required", request_id: requestId(res) } });
      return;
    }
    const actor = actorFromRequest(req);
    const results: Record<string, boolean> = {};
    for (const toolName of toolNames as string[]) {
      results[toolName] = await registry.setToolEnabled(name, toolName, enabled);
      if (results[toolName]) recordAudit(actor, enabled ? "tool.enable" : "tool.disable", `${name}${TOOL_KEY_SEPARATOR}${toolName}`, { bulk: true });
    }
    res.status(200).json({ results });
  });

  app.post(
    "/admin-api/clients/:name/tools/:tool/test",
    adminAuth,
    requireOperator,
    async (req: Request<{ name: string; tool: string }>, res: Response) => {
      const { name, tool } = req.params;
      if (!ensureClientAccess(req, res, name)) return;
      const mcpToolName = `${name}${TOOL_KEY_SEPARATOR}${tool}`;
      if (!registry.resolveTool(mcpToolName)) {
        res.status(404).json({ error: { code: "TOOL_NOT_FOUND", message: "Client or tool not found", request_id: requestId(res) } });
        return;
      }
      const args = (req.body as Record<string, unknown>) ?? {};
      const result = await proxyToolCall(mcpToolName, args);
      recordAudit(actorFromRequest(req), "tool.test", mcpToolName);
      res.status(200).json(result);
    }
  );

  // ── Saved examples (playground) ───────────────────────────────────────────

  app.get(
    "/admin-api/clients/:name/tools/:tool/examples",
    adminAuth,
    (req: Request<{ name: string; tool: string }>, res: Response) => {
      if (!ensureClientAccess(req, res, req.params.name)) return;
      res.status(200).json({ items: listExamples(req.params.name, req.params.tool) });
    }
  );

  app.post(
    "/admin-api/clients/:name/tools/:tool/examples",
    adminAuth,
    requireOperator,
    (req: Request<{ name: string; tool: string }>, res: Response) => {
      const { name, tool } = req.params;
      if (!ensureClientAccess(req, res, name)) return;
      const body = (req.body as Record<string, unknown>) ?? {};
      const label = typeof body.label === "string" ? body.label.trim() : "";
      if (!label || label.length > 100) {
        res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "label is required (<= 100 chars)", request_id: requestId(res) } });
        return;
      }
      const result = createExample(name, tool, label, body.args ?? {}, actorFromRequest(req));
      if (result === "TOOL_NOT_FOUND") {
        res.status(404).json({ error: { code: "TOOL_NOT_FOUND", message: "Client or tool not found", request_id: requestId(res) } });
        return;
      }
      if (result === "INVALID_ARGS") {
        res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "args must be an object (<= 16KB)", request_id: requestId(res) } });
        return;
      }
      recordAudit(actorFromRequest(req), "tool.example.create", `${name}${TOOL_KEY_SEPARATOR}${tool}`, { label });
      res.status(201).json(result);
    }
  );

  app.delete(
    "/admin-api/clients/:name/tools/:tool/examples/:id",
    adminAuth,
    requireOperator,
    (req: Request<{ name: string; tool: string; id: string }>, res: Response) => {
      const { name, tool, id } = req.params;
      if (!ensureClientAccess(req, res, name)) return;
      const ok = deleteExample(name, tool, Number(id));
      if (!ok) {
        res.status(404).json({ error: { code: "EXAMPLE_NOT_FOUND", message: "Example not found", request_id: requestId(res) } });
        return;
      }
      recordAudit(actorFromRequest(req), "tool.example.delete", `${name}${TOOL_KEY_SEPARATOR}${tool}`, { id: Number(id) });
      res.status(200).json({ status: "deleted", id: Number(id) });
    }
  );

  app.post(
    "/admin-api/clients/:name/circuit-breaker/reset",
    adminAuth,
    requireOperator,
    (req: Request<{ name: string }>, res: Response) => {
      if (!ensureClientAccess(req, res, req.params.name)) return;
      const ok = registry.resetCircuitBreaker(req.params.name);
      if (!ok) {
        res.status(404).json({ error: { code: "CLIENT_NOT_FOUND", message: "Client is not currently live", request_id: requestId(res) } });
        return;
      }
      recordAudit(actorFromRequest(req), "client.circuit_breaker.reset", req.params.name);
      res.status(200).json({ status: "reset", name: req.params.name });
    }
  );

  // ── Response cache ─────────────────────────────────────────────────────────

  app.post(
    "/admin-api/clients/:name/tools/:tool/cache/purge",
    adminAuth,
    requireOperator,
    (req: Request<{ name: string; tool: string }>, res: Response) => {
      const { name, tool } = req.params;
      if (!ensureClientAccess(req, res, name)) return;
      if (!registry.resolveTool(`${name}${TOOL_KEY_SEPARATOR}${tool}`)) {
        res.status(404).json({ error: { code: "TOOL_NOT_FOUND", message: "Client or tool not found", request_id: requestId(res) } });
        return;
      }
      purgeToolCache(name, tool);
      recordAudit(actorFromRequest(req), "tool.cache.purge", `${name}${TOOL_KEY_SEPARATOR}${tool}`);
      res.status(200).json({ status: "purged", name, tool });
    }
  );

  // ── Canary / failover (secondary upstream) ────────────────────────────────

  app.get("/admin-api/clients/:name/canary", adminAuth, (req: Request<{ name: string }>, res: Response) => {
    if (!ensureClientAccess(req, res, req.params.name)) return;
    res.status(200).json({ canary: getCanary(req.params.name) });
  });

  app.put("/admin-api/clients/:name/canary", adminAuth, requireOperator, async (req: Request<{ name: string }>, res: Response) => {
    const { name } = req.params;
    if (!ensureClientAccess(req, res, name)) return;
    const body = (req.body as Record<string, unknown>) ?? {};
    let input: { secondaryBaseUrl: string; mode: "canary" | "failover"; weight: number; enabled: boolean } | null;
    if (body.canary === null) {
      input = null;
    } else {
      const secondaryBaseUrl = typeof body.secondaryBaseUrl === "string" ? body.secondaryBaseUrl : "";
      const mode = body.mode === "failover" ? "failover" : "canary";
      const weight = typeof body.weight === "number" ? body.weight : 0;
      const enabled = body.enabled !== false;
      if (!secondaryBaseUrl) {
        res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "secondaryBaseUrl is required (or send { canary: null } to clear)", request_id: requestId(res) } });
        return;
      }
      input = { secondaryBaseUrl, mode, weight, enabled };
    }

    const result = await setCanary(name, input);
    if (!result.ok) {
      const status = result.error === "CLIENT_NOT_FOUND" ? 404 : 400;
      res.status(status).json({ error: { code: result.error, message: result.reason ?? result.error, request_id: requestId(res) } });
      return;
    }
    recordAudit(actorFromRequest(req), input ? "client.canary.set" : "client.canary.clear", name, input ? { mode: input.mode, weight: input.weight, enabled: input.enabled } : undefined);
    res.status(200).json({ status: "updated", name });
  });

  // ── Load balancing (N-way upstream pool) ───────────────────────────────────

  app.get("/admin-api/clients/:name/lb", adminAuth, (req: Request<{ name: string }>, res: Response) => {
    if (!ensureClientAccess(req, res, req.params.name)) return;
    res.status(200).json({ lb: getLb(req.params.name) });
  });

  app.put("/admin-api/clients/:name/lb", adminAuth, requireOperator, (req: Request<{ name: string }>, res: Response) => {
    const { name } = req.params;
    if (!ensureClientAccess(req, res, name)) return;
    const body = (req.body as Record<string, unknown>) ?? {};
    let input: { strategy: LbStrategy; primaryWeight: number; enabled: boolean } | null;
    if (body.lb === null) {
      input = null;
    } else {
      const strategy = body.strategy as LbStrategy;
      const primaryWeight = typeof body.primaryWeight === "number" ? body.primaryWeight : 1;
      const enabled = body.enabled !== false;
      input = { strategy, primaryWeight, enabled };
    }
    const result = setLb(name, input);
    if (!result.ok) {
      const status = result.error === "CLIENT_NOT_FOUND" ? 404 : 400;
      res.status(status).json({ error: { code: result.error, message: result.error, request_id: requestId(res) } });
      return;
    }
    recordAudit(actorFromRequest(req), input ? "client.lb.set" : "client.lb.clear", name, input ? { strategy: input.strategy, primaryWeight: input.primaryWeight, enabled: input.enabled } : undefined);
    res.status(200).json({ status: "updated", name });
  });

  app.post("/admin-api/clients/:name/lb/upstreams", adminAuth, requireOperator, async (req: Request<{ name: string }>, res: Response) => {
    const { name } = req.params;
    if (!ensureClientAccess(req, res, name)) return;
    const body = (req.body as Record<string, unknown>) ?? {};
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl : "";
    const weight = typeof body.weight === "number" ? body.weight : 1;
    if (!baseUrl) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "baseUrl is required", request_id: requestId(res) } });
      return;
    }
    const result = await addUpstream(name, baseUrl, weight);
    if (!result.ok) {
      const status = result.error === "CLIENT_NOT_FOUND" ? 404 : 400;
      res.status(status).json({ error: { code: result.error, message: result.reason ?? result.error, request_id: requestId(res) } });
      return;
    }
    recordAudit(actorFromRequest(req), "client.lb.upstream.add", name, { id: result.id, baseUrl, weight });
    res.status(201).json({ status: "added", id: result.id });
  });

  app.patch("/admin-api/clients/:name/lb/upstreams/:id", adminAuth, requireOperator, (req: Request<{ name: string; id: string }>, res: Response) => {
    const { name, id } = req.params;
    if (!ensureClientAccess(req, res, name)) return;
    const body = (req.body as Record<string, unknown>) ?? {};
    const patch: { enabled?: boolean; weight?: number } = {};
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") {
        res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "enabled must be a boolean", request_id: requestId(res) } });
        return;
      }
      patch.enabled = body.enabled;
    }
    if (body.weight !== undefined) {
      if (typeof body.weight !== "number") {
        res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "weight must be a number", request_id: requestId(res) } });
        return;
      }
      patch.weight = body.weight;
    }
    const result = updateUpstream(name, Number(id), patch);
    if (!result.ok) {
      const status = result.error === "TARGET_NOT_FOUND" ? 404 : 400;
      res.status(status).json({ error: { code: result.error, message: result.error, request_id: requestId(res) } });
      return;
    }
    recordAudit(actorFromRequest(req), "client.lb.upstream.update", name, { id: Number(id), ...patch });
    res.status(200).json({ status: "updated", id: Number(id) });
  });

  app.delete("/admin-api/clients/:name/lb/upstreams/:id", adminAuth, requireOperator, (req: Request<{ name: string; id: string }>, res: Response) => {
    const { name, id } = req.params;
    if (!ensureClientAccess(req, res, name)) return;
    const result = removeUpstream(name, Number(id));
    if (!result.ok) {
      res.status(404).json({ error: { code: result.error, message: result.error, request_id: requestId(res) } });
      return;
    }
    recordAudit(actorFromRequest(req), "client.lb.upstream.remove", name, { id: Number(id) });
    res.status(200).json({ status: "removed", id: Number(id) });
  });

  // ── Approvals (human-in-the-loop queue) ────────────────────────────────────

  app.get("/admin-api/approvals", adminAuth, (req: Request, res: Response) => {
    const q = req.query.status;
    const status: ApprovalStatus | undefined = q === "pending" || q === "approved" || q === "rejected" ? q : undefined;
    res.status(200).json({ items: listApprovals(status) });
  });

  app.post("/admin-api/approvals/:id/approve", adminAuth, requireOperator, (req: Request<{ id: string }>, res: Response) => {
    const rec = getApproval(Number(req.params.id));
    if (!rec) {
      res.status(404).json({ error: { code: "APPROVAL_NOT_FOUND", message: "Approval not found", request_id: requestId(res) } });
      return;
    }
    if (!ensureClientAccess(req, res, rec.clientName)) return;
    const note = typeof (req.body as Record<string, unknown>)?.note === "string" ? ((req.body as Record<string, unknown>).note as string) : null;
    if (!decideApproval(rec.id, "approved", actorFromRequest(req), note)) {
      res.status(409).json({ error: { code: "NOT_PENDING", message: "Approval is not pending", request_id: requestId(res) } });
      return;
    }
    recordAudit(actorFromRequest(req), "approval.approve", `${rec.clientName}${TOOL_KEY_SEPARATOR}${rec.toolName}`, { id: rec.id });
    res.status(200).json({ status: "approved", id: rec.id });
  });

  app.post("/admin-api/approvals/:id/reject", adminAuth, requireOperator, (req: Request<{ id: string }>, res: Response) => {
    const rec = getApproval(Number(req.params.id));
    if (!rec) {
      res.status(404).json({ error: { code: "APPROVAL_NOT_FOUND", message: "Approval not found", request_id: requestId(res) } });
      return;
    }
    if (!ensureClientAccess(req, res, rec.clientName)) return;
    const note = typeof (req.body as Record<string, unknown>)?.note === "string" ? ((req.body as Record<string, unknown>).note as string) : null;
    if (!decideApproval(rec.id, "rejected", actorFromRequest(req), note)) {
      res.status(409).json({ error: { code: "NOT_PENDING", message: "Approval is not pending", request_id: requestId(res) } });
      return;
    }
    recordAudit(actorFromRequest(req), "approval.reject", `${rec.clientName}${TOOL_KEY_SEPARATOR}${rec.toolName}`, { id: rec.id });
    res.status(200).json({ status: "rejected", id: rec.id });
  });

  // ── Outbound OAuth2 client-credentials ─────────────────────────────────────

  app.get("/admin-api/clients/:name/oauth", adminAuth, (req: Request<{ name: string }>, res: Response) => {
    if (!ensureClientAccess(req, res, req.params.name)) return;
    res.status(200).json({ oauth: getClientOAuth(req.params.name) });
  });

  app.put("/admin-api/clients/:name/oauth", adminAuth, requireOperator, async (req: Request<{ name: string }>, res: Response) => {
    const { name } = req.params;
    if (!ensureClientAccess(req, res, name)) return;
    const body = (req.body as Record<string, unknown>) ?? {};
    let input: { tokenUrl: string; clientId: string; clientSecret: string; scope?: string } | null;
    if (body.oauth === null) {
      input = null;
    } else {
      const tokenUrl = typeof body.tokenUrl === "string" ? body.tokenUrl : "";
      const clientId = typeof body.clientId === "string" ? body.clientId : "";
      const clientSecret = typeof body.clientSecret === "string" ? body.clientSecret : "";
      if (!tokenUrl || !clientId || !clientSecret) {
        res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "tokenUrl, clientId, and clientSecret are required (or send { oauth: null } to clear)", request_id: requestId(res) } });
        return;
      }
      input = { tokenUrl, clientId, clientSecret, scope: typeof body.scope === "string" ? body.scope : undefined };
    }
    const result = await setClientOAuth(name, input);
    if (!result.ok) {
      res.status(result.error === "CLIENT_NOT_FOUND" ? 404 : 400).json({ error: { code: result.error, message: result.reason ?? result.error, request_id: requestId(res) } });
      return;
    }
    recordAudit(actorFromRequest(req), input ? "client.oauth.set" : "client.oauth.clear", name);
    res.status(200).json({ status: "updated", name });
  });

  // ── Synthetic monitors ─────────────────────────────────────────────────────

  app.get("/admin-api/monitors", adminAuth, (_req: Request, res: Response) => {
    res.status(200).json({ items: listMonitors() });
  });

  // ── Traffic explorer + replay ──────────────────────────────────────────────

  app.get("/admin-api/traffic", adminAuth, (req: Request, res: Response) => {
    const clientName = typeof req.query.client === "string" ? req.query.client : undefined;
    const toolName = typeof req.query.tool === "string" ? req.query.tool : undefined;
    const errorsOnly = req.query.errors === "true";
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    res.status(200).json({ items: listTraffic({ clientName, toolName, errorsOnly, limit }) });
  });

  app.get("/admin-api/traffic/:id", adminAuth, (req: Request<{ id: string }>, res: Response) => {
    const rec = getTraffic(Number(req.params.id));
    if (!rec) {
      res.status(404).json({ error: { code: "TRAFFIC_NOT_FOUND", message: "Traffic record not found", request_id: requestId(res) } });
      return;
    }
    res.status(200).json(rec);
  });

  app.post("/admin-api/traffic/:id/replay", adminAuth, requireOperator, async (req: Request<{ id: string }>, res: Response) => {
    const rec = getTraffic(Number(req.params.id));
    if (!rec) {
      res.status(404).json({ error: { code: "TRAFFIC_NOT_FOUND", message: "Traffic record not found", request_id: requestId(res) } });
      return;
    }
    if (rec.clientName && !ensureClientAccess(req, res, rec.clientName)) return;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(rec.argsJson) as Record<string, unknown>;
    } catch {
      args = {};
    }
    const result = await proxyToolCall(rec.mcpToolName, args);
    recordAudit(actorFromRequest(req), "traffic.replay", rec.mcpToolName, { id: rec.id });
    res.status(200).json(result);
  });

  // ── Users ───────────────────────────────────────────────────────────────

  app.get("/admin-api/users", adminAuth, requireAdminRole, (_req: Request, res: Response) => {
    const users = listUsers().map((u) => ({
      username: u.username,
      role: u.role,
      is_active: u.isActive,
      created_at: u.createdAt,
      last_login_at: u.lastLoginAt,
      team_id: u.teamId,
    }));
    res.status(200).json({ users });
  });

  app.post("/admin-api/users", adminAuth, requireAdminRole, async (req: Request, res: Response) => {
    const body = (req.body as Record<string, unknown>) ?? {};
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const role: AdminRole = isAdminRole(body.role) ? body.role : "admin";

    if (!username || password.length < 12) {
      res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "username and password (min 12 chars) are required", request_id: requestId(res) },
      });
      return;
    }
    if (findUserByUsername(username)) {
      res.status(409).json({ error: { code: "USER_EXISTS", message: "A user with that username already exists", request_id: requestId(res) } });
      return;
    }

    const hash = await Bun.password.hash(password);
    const actor = actorFromRequest(req);
    const user = createUser(username, hash, role, actor);
    recordAudit(actor, "user.create", user.username, { role });
    res.status(201).json({ username: user.username, role: user.role, is_active: user.isActive });
  });

  app.patch("/admin-api/users/:username", adminAuth, requireAdminRole, (req: Request<{ username: string }>, res: Response) => {
    const { username } = req.params;
    const body = (req.body as Record<string, unknown>) ?? {};
    const existing = findUserByUsername(username);
    if (!existing) {
      res.status(404).json({ error: { code: "USER_NOT_FOUND", message: "User not found", request_id: requestId(res) } });
      return;
    }

    const nextRole: AdminRole | undefined = isAdminRole(body.role) ? body.role : undefined;
    const nextActive: boolean | undefined = typeof body.is_active === "boolean" ? body.is_active : undefined;

    const wouldLoseAdminStatus =
      existing.role === "admin" && existing.isActive && ((nextRole !== undefined && nextRole !== "admin") || (nextActive === false));
    if (wouldLoseAdminStatus && countActiveAdmins() <= 1) {
      res.status(409).json({
        error: { code: "LAST_ADMIN_PROTECTED", message: "Cannot demote or deactivate the last active admin", request_id: requestId(res) },
      });
      return;
    }

    updateUser(username, { role: nextRole, isActive: nextActive });
    if (nextActive === false) revokeAllSessionsForUser(existing.id);
    recordAudit(actorFromRequest(req), "user.update", username, { role: nextRole, is_active: nextActive });
    res.status(200).json({ status: "updated", username });
  });

  app.delete("/admin-api/users/:username", adminAuth, requireAdminRole, (req: Request<{ username: string }>, res: Response) => {
    const { username } = req.params;
    const existing = findUserByUsername(username);
    if (!existing) {
      res.status(404).json({ error: { code: "USER_NOT_FOUND", message: "User not found", request_id: requestId(res) } });
      return;
    }
    if (existing.role === "admin" && existing.isActive && countActiveAdmins() <= 1) {
      res.status(409).json({
        error: { code: "LAST_ADMIN_PROTECTED", message: "Cannot delete the last active admin", request_id: requestId(res) },
      });
      return;
    }
    deleteUser(username); // cascades admin_sessions via FK
    recordAudit(actorFromRequest(req), "user.delete", username);
    res.status(200).json({ status: "deleted", username });
  });

  // ── Audit log / overview ────────────────────────────────────────────────

  app.get("/admin-api/audit-log", adminAuth, (req: Request, res: Response) => {
    const { actor, action, from, to, cursor, limit } = req.query;
    const result = listAuditLog({
      actor: typeof actor === "string" ? actor : undefined,
      action: typeof action === "string" ? action : undefined,
      from: typeof from === "string" ? Number(from) : undefined,
      to: typeof to === "string" ? Number(to) : undefined,
      cursor: typeof cursor === "string" ? cursor : undefined,
      limit: typeof limit === "string" ? Number(limit) : undefined,
    });
    res.status(200).json(result);
  });

  app.get("/admin-api/audit-log/verify", adminAuth, (_req: Request, res: Response) => {
    res.status(200).json(verifyAuditChain());
  });

  app.get("/admin-api/audit-log/export", adminAuth, (req: Request, res: Response) => {
    const { actor, action, from, to } = req.query;
    const items = exportAuditLog({
      actor: typeof actor === "string" ? actor : undefined,
      action: typeof action === "string" ? action : undefined,
      from: typeof from === "string" ? Number(from) : undefined,
      to: typeof to === "string" ? Number(to) : undefined,
    });
    res.status(200).json({ items, count: items.length });
  });

  app.get("/admin-api/overview", adminAuth, (_req: Request, res: Response) => {
    const liveClients = registry.listClients();
    const statusCounts = { healthy: 0, degraded: 0, unreachable: 0 };
    let disabledClients = 0;
    let disabledTools = 0;
    let totalTools = 0;
    for (const c of liveClients) {
      statusCounts[c.status]++;
      if (!c.enabled) disabledClients++;
      for (const t of c.tools) {
        totalTools++;
        if (!t.enabled) disabledTools++;
      }
    }
    const breakerStates = Object.values(getAllCircuitStates());
    const openBreakers = breakerStates.filter((s) => s === "open").length;
    const halfOpenBreakers = breakerStates.filter((s) => s === "half_open").length;
    const closedBreakers = breakerStates.length - openBreakers - halfOpenBreakers;

    res.status(200).json({
      clients: { live: liveClients.length, disabled: disabledClients, ...statusCounts },
      tools: { total: totalTools, disabled: disabledTools },
      circuit_breakers: { open: openBreakers, half_open: halfOpenBreakers, closed: closedBreakers },
      admin_users: listUsers().length,
    });
  });
}
