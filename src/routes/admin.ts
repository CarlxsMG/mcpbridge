import type { Request, Response, NextFunction, Express } from "express";
import { registry, TOOL_KEY_SEPARATOR, ToolOverrideError } from "../registry.js";
import { proxyToolCall } from "../proxy.js";
import { adminAuth } from "../middleware/auth.js";
import { hashApiKey } from "../security/key-hash.js";
import { setToolSensitive } from "../tool-sensitivity.js";
import { setRedactionPaths } from "../redaction.js";
import { setGuardrails, MAX_DENY_PATTERNS, MAX_DENY_PATTERN_LENGTH } from "../guardrails.js";
import { recordAudit, actorFromRequest, listAuditLog, exportAuditLog } from "../admin/audit.js";
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

/** Admin-only for session callers (viewer/operator/auditor are rejected). Bearer callers always pass. */
export function requireAdminRole(req: Request, res: Response, next: NextFunction): void {
  if (req.authContext?.method === "session" && req.authContext.role !== "admin") {
    res.status(403).json({ error: { code: "FORBIDDEN", message: "This action requires the admin role", request_id: requestId(res) } });
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
    const result = registry.listClientsSummary({
      q: typeof q === "string" ? q : undefined,
      status: typeof status === "string" ? (status as ClientStatus) : undefined,
      enabled: enabled === "true" ? true : enabled === "false" ? false : undefined,
      cursor: typeof cursor === "string" ? cursor : undefined,
      limit: typeof limit === "string" ? Number(limit) : undefined,
    });
    res.status(200).json(result);
  });

  app.get("/admin-api/clients/:name", adminAuth, (req: Request<{ name: string }>, res: Response) => {
    const detail = registry.getClientDetail(req.params.name);
    if (!detail) {
      res.status(404).json({ error: { code: "CLIENT_NOT_FOUND", message: "Client not found", request_id: requestId(res) } });
      return;
    }
    res.status(200).json(detail);
  });

  app.patch("/admin-api/clients/:name", adminAuth, requireOperator, async (req: Request<{ name: string }>, res: Response) => {
    const { name } = req.params;
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

  app.post(
    "/admin-api/clients/:name/circuit-breaker/reset",
    adminAuth,
    requireOperator,
    (req: Request<{ name: string }>, res: Response) => {
      const ok = registry.resetCircuitBreaker(req.params.name);
      if (!ok) {
        res.status(404).json({ error: { code: "CLIENT_NOT_FOUND", message: "Client is not currently live", request_id: requestId(res) } });
        return;
      }
      recordAudit(actorFromRequest(req), "client.circuit_breaker.reset", req.params.name);
      res.status(200).json({ status: "reset", name: req.params.name });
    }
  );

  // ── Users ───────────────────────────────────────────────────────────────

  app.get("/admin-api/users", adminAuth, requireAdminRole, (_req: Request, res: Response) => {
    const users = listUsers().map((u) => ({
      username: u.username,
      role: u.role,
      is_active: u.isActive,
      created_at: u.createdAt,
      last_login_at: u.lastLoginAt,
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

    res.status(200).json({
      clients: { live: liveClients.length, disabled: disabledClients, ...statusCounts },
      tools: { total: totalTools, disabled: disabledTools },
      circuit_breakers: { open: openBreakers, half_open: halfOpenBreakers },
      admin_users: listUsers().length,
    });
  });
}
