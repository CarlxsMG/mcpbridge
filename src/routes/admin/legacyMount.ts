import type { Request, Response, Router } from "express";
import { registry, ToolOverrideError } from "../../mcp/registry.js";
import { TOOL_KEY_SEPARATOR, toolKey } from "../../lib/identifier.js";
import { proxyToolCall } from "../../proxy/proxy.js";
import { setToolSensitive } from "../../tool-meta/tool-sensitivity.js";
import { setRedactionPaths } from "../../content-filtering/redaction.js";
import { setGuardrails } from "../../tool-policies/guardrails.js";
import { listExamples, createExample, deleteExample } from "../../tool-meta/tool-examples.js";
import { getCanary, setCanary } from "../../tool-policies/canary.js";
import { setToolCacheConfig, purgeToolCache } from "../../tool-policies/response-cache.js";
import { setToolCoalesce } from "../../tool-policies/coalesce.js";
import {
  setQuarantinePolicy,
  clearQuarantine,
} from "../../tool-policies/quarantine.js";
import {
  getLb,
  setLb,
  addUpstream,
  updateUpstream,
  removeUpstream,
  type LbStrategy,
} from "../../tool-policies/load-balancer.js";
import { setPaginationConfig } from "../../tool-policies/pagination.js";
import { setStreamingConfig } from "../../proxy/streaming.js";
import { setToolTransform } from "../../proxy/transform.js";
import { setToolMock } from "../../tool-meta/tool-mock.js";
import {
  setApprovalRequired,
  MAX_APPROVAL_LEVELS,
} from "../../admin/entities/approvals.js";
import { listTraffic } from "../../observability/traffic.js";
import { setMonitor, deleteMonitor, listMonitors } from "../../observability/monitor.js";
import { setToolGraphql, setToolWs } from "../../proxy/backends.js";
import { getClientOAuth, setClientOAuth, type OAuthError } from "../../backend-auth/oauth.js";
import {
  setToolContextBudget,
} from "../../tool-policies/context-budget.js";
import {
  recordAudit,
  actorFromRequest,
  listAuditLog,
  exportAuditLog,
  verifyAuditChain,
  listAuditActions,
} from "../../admin/audit/audit.js";
import { auditLogToCsv, auditLogToHtml } from "../../admin/audit/audit-export.js";
import { getAllCircuitStates } from "../../middleware/circuit-breaker.js";
import type { ClientGuardConfig, ToolGuardConfig, ClientStatus, ToolOverride, ToolGuardrails } from "../../mcp/types.js";
import type { AdminRole } from "../../security/user-store.js";
import { sendError, validationError, notFound } from "../http-errors.js";
import { mutationErrorToStatus } from "../validation.js";
import { config } from "../../config.js";
import { callerTeamId, ensureClientAccess, requireAdminRole, requireOperator } from "../../middleware/authz.js";

import {
  validateCacheInput,
  validateCoalesceInput,
  validateQuarantinePolicyInput,
  validateContextBudgetInput,
  validatePaginationInput,
  validateStreamingInput,
  validateOps,
  validateTransformInput,
  validateMockInput,
  validateToolGuardInput,
  validateToolOverrideInput,
  validateGuardrailsInput,
  validateClientGuardInput,
} from "./admin-validators.js";
export function mountLegacy(parent: Router): void {
  // ── Clients ─────────────────────────────────────────────────────────────

  parent.get("/clients", (req: Request, res: Response) => {
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

  parent.get("/clients/:name", (req: Request<{ name: string }>, res: Response) => {
    if (!ensureClientAccess(req, res, req.params.name)) return;
    const detail = registry.getClientDetail(req.params.name);
    if (!detail) {
      notFound(res, "CLIENT_NOT_FOUND", "Client not found");
      return;
    }
    res.status(200).json(detail);
  });

  parent.patch(
    "/clients/:name",
    requireOperator,
    async (req: Request<{ name: string }>, res: Response) => {
      const { name } = req.params;
      if (!ensureClientAccess(req, res, name)) return;
      const body = (req.body as Record<string, unknown>) ?? {};
      const actor = actorFromRequest(req);

      if (body.enabled !== undefined) {
        if (typeof body.enabled !== "boolean") {
          validationError(res, "enabled must be a boolean");
          return;
        }
        const ok = await registry.setClientEnabled(name, body.enabled);
        if (!ok) {
          notFound(res, "CLIENT_NOT_FOUND", "Client not found");
          return;
        }
        recordAudit(actor, body.enabled ? "client.enable" : "client.disable", name);
      }

      if (body.guards !== undefined) {
        const parsed = validateClientGuardInput(body.guards);
        if (!parsed.ok) {
          validationError(res, parsed.message);
          return;
        }
        const ok = await registry.setClientGuards(name, parsed.value);
        if (!ok) {
          notFound(res, "CLIENT_NOT_FOUND", "Client not found");
          return;
        }
        recordAudit(actor, "client.guards.update", name, { guards: parsed.value });
      }

      res.status(200).json({ status: "updated", name });
    },
  );

  parent.delete(
    "/clients/:name",
    requireOperator,
    async (req: Request<{ name: string }>, res: Response) => {
      const { name } = req.params;
      if (!ensureClientAccess(req, res, name)) return;
      const actor = actorFromRequest(req);
      const removed = await registry.forgetClient(name);
      if (!removed) {
        notFound(res, "CLIENT_NOT_FOUND", "Client not found");
        return;
      }
      recordAudit(actor, "client.delete", name);
      res.status(200).json({ status: "deleted", name });
    },
  );

  parent.patch("/clients", requireOperator, async (req: Request, res: Response) => {
    const body = (req.body as Record<string, unknown>) ?? {};
    const names = body.names;
    const enabled = body.enabled;
    if (!Array.isArray(names) || names.some((n) => typeof n !== "string") || typeof enabled !== "boolean") {
      validationError(res, "names (string[]) and enabled (boolean) are required");
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

  parent.patch(
    "/clients/:name/tools/:tool",
    requireOperator,
    async (req: Request<{ name: string; tool: string }>, res: Response) => {
      const { name, tool } = req.params;
      if (!ensureClientAccess(req, res, name)) return;
      const body = (req.body as Record<string, unknown>) ?? {};
      const actor = actorFromRequest(req);

      if (body.enabled !== undefined) {
        if (typeof body.enabled !== "boolean") {
          validationError(res, "enabled must be a boolean");
          return;
        }
        const ok = await registry.setToolEnabled(name, tool, body.enabled);
        if (!ok) {
          notFound(res, "TOOL_NOT_FOUND", "Client or tool not found");
          return;
        }
        recordAudit(actor, body.enabled ? "tool.enable" : "tool.disable", `${name}${TOOL_KEY_SEPARATOR}${tool}`);
      }

      if (body.guards !== undefined) {
        const parsed = validateToolGuardInput(body.guards);
        if (!parsed.ok) {
          validationError(res, parsed.message);
          return;
        }
        const ok = await registry.setToolGuards(name, tool, parsed.value);
        if (!ok) {
          notFound(res, "TOOL_NOT_FOUND", "Client or tool not found");
          return;
        }
        recordAudit(actor, "tool.guards.update", `${name}${TOOL_KEY_SEPARATOR}${tool}`);
      }

      if (body.overrides !== undefined) {
        const parsed = validateToolOverrideInput(body.overrides);
        if (!parsed.ok) {
          validationError(res, parsed.message);
          return;
        }
        let ok: boolean;
        try {
          ok = await registry.setToolOverride(name, tool, parsed.value);
        } catch (err) {
          if (err instanceof ToolOverrideError) {
            const status = err.code === "TOOL_ALIAS_CONFLICT" ? 409 : 400;
            sendError(res, status, err.code, err.message);
            return;
          }
          throw err;
        }
        if (!ok) {
          notFound(res, "TOOL_NOT_FOUND", "Client or tool not found");
          return;
        }
        recordAudit(actor, "tool.override.update", `${name}${TOOL_KEY_SEPARATOR}${tool}`);
      }

      if (body.sensitive !== undefined) {
        if (body.sensitive !== null && typeof body.sensitive !== "boolean") {
          validationError(res, "sensitive must be a boolean or null");
          return;
        }
        const ok = setToolSensitive(name, tool, body.sensitive);
        if (!ok) {
          notFound(res, "TOOL_NOT_FOUND", "Client or tool not found");
          return;
        }
        recordAudit(actor, "tool.sensitive.set", `${name}${TOOL_KEY_SEPARATOR}${tool}`, { sensitive: body.sensitive });
      }

      if (body.redactPaths !== undefined) {
        if (!Array.isArray(body.redactPaths) || !body.redactPaths.every((p) => typeof p === "string")) {
          validationError(res, "redactPaths must be an array of strings");
          return;
        }
        const ok = setRedactionPaths(name, tool, body.redactPaths as string[]);
        if (!ok) {
          notFound(res, "TOOL_NOT_FOUND", "Client or tool not found");
          return;
        }
        recordAudit(actor, "tool.redaction.set", `${name}${TOOL_KEY_SEPARATOR}${tool}`, {
          count: (body.redactPaths as string[]).length,
        });
      }

      if (body.guardrails !== undefined) {
        const parsed = validateGuardrailsInput(body.guardrails);
        if (!parsed.ok) {
          validationError(res, parsed.message);
          return;
        }
        const ok = setGuardrails(name, tool, parsed.value);
        if (!ok) {
          notFound(res, "TOOL_NOT_FOUND", "Client or tool not found");
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
          validationError(res, parsed.message);
          return;
        }
        const ok = setToolCacheConfig(name, tool, parsed.value);
        if (!ok) {
          notFound(res, "TOOL_NOT_FOUND", "Client or tool not found");
          return;
        }
        recordAudit(
          actor,
          parsed.value ? "tool.cache.set" : "tool.cache.clear",
          `${name}${TOOL_KEY_SEPARATOR}${tool}`,
          parsed.value ? { ttlSeconds: parsed.value.ttlSeconds, enabled: parsed.value.enabled } : undefined,
        );
      }

      if (body.coalesce !== undefined) {
        const parsed = validateCoalesceInput(body.coalesce);
        if (!parsed.ok) {
          validationError(res, parsed.message);
          return;
        }
        const ok = setToolCoalesce(name, tool, parsed.value);
        if (!ok) {
          notFound(res, "TOOL_NOT_FOUND", "Client or tool not found");
          return;
        }
        recordAudit(
          actor,
          parsed.value ? "tool.coalesce.set" : "tool.coalesce.clear",
          `${name}${TOOL_KEY_SEPARATOR}${tool}`,
          parsed.value ? { enabled: parsed.value.enabled } : undefined,
        );
      }

      if (body.quarantinePolicy !== undefined) {
        const parsed = validateQuarantinePolicyInput(body.quarantinePolicy);
        if (!parsed.ok) {
          validationError(res, parsed.message);
          return;
        }
        const ok = setQuarantinePolicy(name, tool, parsed.value);
        if (!ok) {
          notFound(res, "TOOL_NOT_FOUND", "Client or tool not found");
          return;
        }
        recordAudit(
          actor,
          parsed.value ? "tool.quarantine.policy.set" : "tool.quarantine.policy.clear",
          `${name}${TOOL_KEY_SEPARATOR}${tool}`,
          parsed.value ?? undefined,
        );
      }

      if (body.pagination !== undefined) {
        const parsed = validatePaginationInput(body.pagination);
        if (!parsed.ok) {
          validationError(res, parsed.message);
          return;
        }
        const ok = setPaginationConfig(name, tool, parsed.value);
        if (!ok) {
          notFound(res, "TOOL_NOT_FOUND", "Client or tool not found");
          return;
        }
        recordAudit(
          actor,
          parsed.value ? "tool.pagination.set" : "tool.pagination.clear",
          `${name}${TOOL_KEY_SEPARATOR}${tool}`,
          parsed.value ? { strategy: parsed.value.strategy, maxPages: parsed.value.maxPages } : undefined,
        );
      }

      if (body.streaming !== undefined) {
        const parsed = validateStreamingInput(body.streaming);
        if (!parsed.ok) {
          validationError(res, parsed.message);
          return;
        }
        const ok = setStreamingConfig(name, tool, parsed.value);
        if (!ok) {
          notFound(res, "TOOL_NOT_FOUND", "Client or tool not found");
          return;
        }
        recordAudit(
          actor,
          parsed.value ? "tool.streaming.set" : "tool.streaming.clear",
          `${name}${TOOL_KEY_SEPARATOR}${tool}`,
          parsed.value ? { format: parsed.value.format } : undefined,
        );
      }

      if (body.transform !== undefined) {
        const parsed = validateTransformInput(body.transform);
        if (!parsed.ok) {
          validationError(res, parsed.message);
          return;
        }
        const ok = setToolTransform(name, tool, parsed.value);
        if (!ok) {
          notFound(res, "TOOL_NOT_FOUND", "Client or tool not found");
          return;
        }
        recordAudit(
          actor,
          parsed.value ? "tool.transform.set" : "tool.transform.clear",
          `${name}${TOOL_KEY_SEPARATOR}${tool}`,
          parsed.value ? { request: parsed.value.request.length, response: parsed.value.response.length } : undefined,
        );
      }

      if (body.mock !== undefined) {
        const parsed = validateMockInput(body.mock);
        if (!parsed.ok) {
          validationError(res, parsed.message);
          return;
        }
        const ok = setToolMock(name, tool, parsed.value);
        if (!ok) {
          notFound(res, "TOOL_NOT_FOUND", "Client or tool not found");
          return;
        }
        recordAudit(
          actor,
          parsed.value ? "tool.mock.set" : "tool.mock.clear",
          `${name}${TOOL_KEY_SEPARATOR}${tool}`,
          parsed.value ? { mode: parsed.value.mode } : undefined,
        );
      }

      if (body.requiresApproval !== undefined) {
        if (typeof body.requiresApproval !== "boolean") {
          validationError(res, "requiresApproval must be a boolean");
          return;
        }
        let approvalLevels: number | undefined;
        if (body.approvalLevels !== undefined) {
          if (
            typeof body.approvalLevels !== "number" ||
            !Number.isInteger(body.approvalLevels) ||
            body.approvalLevels < 1 ||
            body.approvalLevels > MAX_APPROVAL_LEVELS
          ) {
            validationError(res, `approvalLevels must be an integer between 1 and ${MAX_APPROVAL_LEVELS}`);
            return;
          }
          approvalLevels = body.approvalLevels;
        }
        const ok = setApprovalRequired(name, tool, body.requiresApproval, approvalLevels);
        if (!ok) {
          notFound(res, "TOOL_NOT_FOUND", "Client or tool not found");
          return;
        }
        recordAudit(
          actor,
          body.requiresApproval ? "tool.approval.enable" : "tool.approval.disable",
          `${name}${TOOL_KEY_SEPARATOR}${tool}`,
          approvalLevels !== undefined ? { approvalLevels } : undefined,
        );
      }

      if (body.monitor !== undefined) {
        if (body.monitor === null || body.monitor === false) {
          await deleteMonitor(name, tool);
          recordAudit(actor, "tool.monitor.clear", `${name}${TOOL_KEY_SEPARATOR}${tool}`);
        } else if (typeof body.monitor === "object") {
          const mo = body.monitor as Record<string, unknown>;
          const exampleId = typeof mo.exampleId === "number" ? mo.exampleId : NaN;
          if (!Number.isInteger(exampleId)) {
            validationError(res, "monitor.exampleId (number) is required");
            return;
          }
          const result = await setMonitor(name, tool, {
            exampleId,
            intervalMinutes: typeof mo.intervalMinutes === "number" ? mo.intervalMinutes : 15,
            enabled: mo.enabled !== false,
          });
          if (!result.ok) {
            sendError(res, result.error === "TOOL_NOT_LIVE" ? 404 : 400, result.error, result.error);
            return;
          }
          recordAudit(actor, "tool.monitor.set", `${name}${TOOL_KEY_SEPARATOR}${tool}`, { exampleId });
        } else {
          validationError(res, "monitor must be an object, null, or false");
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
            validationError(res, "graphql.query (non-empty string) is required");
            return;
          }
          if (!setToolGraphql(name, tool, { enabled: g.enabled !== false, query })) {
            notFound(res, "TOOL_NOT_FOUND", "Client or tool not found");
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
            validationError(res, "ws.wsUrl (ws:// or wss://) is required");
            return;
          }
          const result = await setToolWs(name, tool, {
            enabled: w.enabled !== false,
            wsUrl,
            persistent: w.persistent === true,
          });
          if (!result.ok) {
            sendError(res, result.error === "TOOL_NOT_FOUND" ? 404 : 400, result.error, result.reason ?? result.error);
            return;
          }
          recordAudit(actor, "tool.ws.set", `${name}${TOOL_KEY_SEPARATOR}${tool}`, {
            persistent: w.persistent === true,
          });
        }
      }

      if (body.contextBudget !== undefined) {
        const parsed = validateContextBudgetInput(body.contextBudget);
        if (!parsed.ok) {
          validationError(res, parsed.message);
          return;
        }
        const result = await setToolContextBudget(name, tool, parsed.value);
        if (!result.ok) {
          if (result.error === "TOOL_NOT_FOUND") {
            notFound(res, "TOOL_NOT_FOUND", "Client or tool not found");
          } else {
            sendError(res, 400, result.error, result.reason ?? result.error);
          }
          return;
        }
        recordAudit(
          actor,
          parsed.value ? "tool.context_budget.set" : "tool.context_budget.clear",
          `${name}${TOOL_KEY_SEPARATOR}${tool}`,
          parsed.value
            ? {
                mode: parsed.value.mode,
                maxResponseBytes: parsed.value.maxResponseBytes,
                ...(parsed.value.mode === "llm_summarize" ? { llmProvider: parsed.value.llm.provider } : {}),
              }
            : undefined,
        );
      }

      res.status(200).json({ status: "updated", name, tool });
    },
  );

  parent.patch(
    "/clients/:name/tools",
    requireOperator,
    async (req: Request<{ name: string }>, res: Response) => {
      const { name } = req.params;
      const body = (req.body as Record<string, unknown>) ?? {};
      const toolNames = body.tool_names;
      const enabled = body.enabled;
      if (!Array.isArray(toolNames) || toolNames.some((n) => typeof n !== "string") || typeof enabled !== "boolean") {
        validationError(res, "tool_names (string[]) and enabled (boolean) are required");
        return;
      }
      const actor = actorFromRequest(req);
      const results: Record<string, boolean> = {};
      for (const toolName of toolNames as string[]) {
        results[toolName] = await registry.setToolEnabled(name, toolName, enabled);
        if (results[toolName])
          recordAudit(actor, enabled ? "tool.enable" : "tool.disable", `${name}${TOOL_KEY_SEPARATOR}${toolName}`, {
            bulk: true,
          });
      }
      res.status(200).json({ results });
    },
  );

  parent.post(
    "/clients/:name/tools/:tool/test",
    requireOperator,
    async (req: Request<{ name: string; tool: string }>, res: Response) => {
      const { name, tool } = req.params;
      if (!ensureClientAccess(req, res, name)) return;
      const mcpToolName = `${name}${TOOL_KEY_SEPARATOR}${tool}`;
      if (!registry.resolveTool(mcpToolName)) {
        notFound(res, "TOOL_NOT_FOUND", "Client or tool not found");
        return;
      }
      const args = (req.body as Record<string, unknown>) ?? {};
      const result = await proxyToolCall(mcpToolName, args);
      recordAudit(actorFromRequest(req), "tool.test", mcpToolName);
      res.status(200).json(result);
    },
  );

  // ── Saved examples (playground) ───────────────────────────────────────────

  parent.get(
    "/clients/:name/tools/:tool/examples",
    (req: Request<{ name: string; tool: string }>, res: Response) => {
      if (!ensureClientAccess(req, res, req.params.name)) return;
      res.status(200).json({ items: listExamples(req.params.name, req.params.tool) });
    },
  );

  parent.post(
    "/clients/:name/tools/:tool/examples",
    requireOperator,
    (req: Request<{ name: string; tool: string }>, res: Response) => {
      const { name, tool } = req.params;
      if (!ensureClientAccess(req, res, name)) return;
      const body = (req.body as Record<string, unknown>) ?? {};
      const label = typeof body.label === "string" ? body.label.trim() : "";
      if (!label || label.length > 100) {
        validationError(res, "label is required (<= 100 chars)");
        return;
      }
      const result = createExample(name, tool, label, body.args ?? {}, actorFromRequest(req));
      if (result === "TOOL_NOT_FOUND") {
        notFound(res, "TOOL_NOT_FOUND", "Client or tool not found");
        return;
      }
      if (result === "INVALID_ARGS") {
        validationError(res, "args must be an object (<= 16KB)");
        return;
      }
      recordAudit(actorFromRequest(req), "tool.example.create", `${name}${TOOL_KEY_SEPARATOR}${tool}`, { label });
      res.status(201).json(result);
    },
  );

  parent.delete(
    "/clients/:name/tools/:tool/examples/:id",
    requireOperator,
    (req: Request<{ name: string; tool: string; id: string }>, res: Response) => {
      const { name, tool, id } = req.params;
      if (!ensureClientAccess(req, res, name)) return;
      const ok = deleteExample(name, tool, Number(id));
      if (!ok) {
        notFound(res, "EXAMPLE_NOT_FOUND", "Example not found");
        return;
      }
      recordAudit(actorFromRequest(req), "tool.example.delete", `${name}${TOOL_KEY_SEPARATOR}${tool}`, {
        id: Number(id),
      });
      res.status(200).json({ status: "deleted", id: Number(id) });
    },
  );

  parent.post(
    "/clients/:name/circuit-breaker/reset",
    requireOperator,
    (req: Request<{ name: string }>, res: Response) => {
      if (!ensureClientAccess(req, res, req.params.name)) return;
      const ok = registry.resetCircuitBreaker(req.params.name);
      if (!ok) {
        notFound(res, "CLIENT_NOT_FOUND", "Client is not currently live");
        return;
      }
      recordAudit(actorFromRequest(req), "client.circuit_breaker.reset", req.params.name);
      res.status(200).json({ status: "reset", name: req.params.name });
    },
  );

  // ── Response cache ─────────────────────────────────────────────────────────

  parent.post(
    "/clients/:name/tools/:tool/cache/purge",
    requireOperator,
    (req: Request<{ name: string; tool: string }>, res: Response) => {
      const { name, tool } = req.params;
      if (!ensureClientAccess(req, res, name)) return;
      if (!registry.resolveTool(`${name}${TOOL_KEY_SEPARATOR}${tool}`)) {
        notFound(res, "TOOL_NOT_FOUND", "Client or tool not found");
        return;
      }
      purgeToolCache(name, tool);
      recordAudit(actorFromRequest(req), "tool.cache.purge", `${name}${TOOL_KEY_SEPARATOR}${tool}`);
      res.status(200).json({ status: "purged", name, tool });
    },
  );

  // ── Auto-quarantine ─────────────────────────────────────────────────────────

  parent.post(
    "/clients/:name/tools/:tool/quarantine/clear",
    requireOperator,
    (req: Request<{ name: string; tool: string }>, res: Response) => {
      const { name, tool } = req.params;
      if (!ensureClientAccess(req, res, name)) return;
      const ok = clearQuarantine(name, tool);
      if (!ok) {
        notFound(res, "TOOL_NOT_FOUND", "Client or tool not found");
        return;
      }
      recordAudit(actorFromRequest(req), "tool.quarantine.clear", `${name}${TOOL_KEY_SEPARATOR}${tool}`);
      res.status(200).json({ status: "cleared", name, tool });
    },
  );

  // ── Canary / failover (secondary upstream) ────────────────────────────────

  parent.get("/clients/:name/canary", (req: Request<{ name: string }>, res: Response) => {
    if (!ensureClientAccess(req, res, req.params.name)) return;
    res.status(200).json({ canary: getCanary(req.params.name) });
  });

  parent.put(
    "/clients/:name/canary",
    requireOperator,
    async (req: Request<{ name: string }>, res: Response) => {
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
          validationError(res, "secondaryBaseUrl is required (or send { canary: null } to clear)");
          return;
        }
        input = { secondaryBaseUrl, mode, weight, enabled };
      }

      const result = await setCanary(name, input);
      if (!result.ok) {
        sendError(res, result.error === "CLIENT_NOT_FOUND" ? 404 : 400, result.error, result.reason ?? result.error);
        return;
      }
      recordAudit(
        actorFromRequest(req),
        input ? "client.canary.set" : "client.canary.clear",
        name,
        input ? { mode: input.mode, weight: input.weight, enabled: input.enabled } : undefined,
      );
      res.status(200).json({ status: "updated", name });
    },
  );

  // ── Load balancing (N-way upstream pool) ───────────────────────────────────

  parent.get("/clients/:name/lb", (req: Request<{ name: string }>, res: Response) => {
    if (!ensureClientAccess(req, res, req.params.name)) return;
    res.status(200).json({ lb: getLb(req.params.name) });
  });

  parent.put(
    "/clients/:name/lb",
    requireOperator,
    (req: Request<{ name: string }>, res: Response) => {
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
        sendError(res, result.error === "CLIENT_NOT_FOUND" ? 404 : 400, result.error, result.error);
        return;
      }
      recordAudit(
        actorFromRequest(req),
        input ? "client.lb.set" : "client.lb.clear",
        name,
        input ? { strategy: input.strategy, primaryWeight: input.primaryWeight, enabled: input.enabled } : undefined,
      );
      res.status(200).json({ status: "updated", name });
    },
  );

  parent.post(
    "/clients/:name/lb/upstreams",
    requireOperator,
    async (req: Request<{ name: string }>, res: Response) => {
      const { name } = req.params;
      if (!ensureClientAccess(req, res, name)) return;
      const body = (req.body as Record<string, unknown>) ?? {};
      const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl : "";
      const weight = typeof body.weight === "number" ? body.weight : 1;
      if (!baseUrl) {
        validationError(res, "baseUrl is required");
        return;
      }
      const result = await addUpstream(name, baseUrl, weight);
      if (!result.ok) {
        sendError(res, result.error === "CLIENT_NOT_FOUND" ? 404 : 400, result.error, result.reason ?? result.error);
        return;
      }
      recordAudit(actorFromRequest(req), "client.lb.upstream.add", name, { id: result.id, baseUrl, weight });
      res.status(201).json({ status: "added", id: result.id });
    },
  );

  parent.patch(
    "/clients/:name/lb/upstreams/:id",
    requireOperator,
    (req: Request<{ name: string; id: string }>, res: Response) => {
      const { name, id } = req.params;
      if (!ensureClientAccess(req, res, name)) return;
      const body = (req.body as Record<string, unknown>) ?? {};
      const patch: { enabled?: boolean; weight?: number } = {};
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== "boolean") {
          validationError(res, "enabled must be a boolean");
          return;
        }
        patch.enabled = body.enabled;
      }
      if (body.weight !== undefined) {
        if (typeof body.weight !== "number") {
          validationError(res, "weight must be a number");
          return;
        }
        patch.weight = body.weight;
      }
      const result = updateUpstream(name, Number(id), patch);
      if (!result.ok) {
        sendError(res, result.error === "TARGET_NOT_FOUND" ? 404 : 400, result.error, result.error);
        return;
      }
      recordAudit(actorFromRequest(req), "client.lb.upstream.update", name, { id: Number(id), ...patch });
      res.status(200).json({ status: "updated", id: Number(id) });
    },
  );

  parent.delete(
    "/clients/:name/lb/upstreams/:id",
    requireOperator,
    (req: Request<{ name: string; id: string }>, res: Response) => {
      const { name, id } = req.params;
      if (!ensureClientAccess(req, res, name)) return;
      const result = removeUpstream(name, Number(id));
      if (!result.ok) {
        sendError(res, 404, result.error, result.error);
        return;
      }
      recordAudit(actorFromRequest(req), "client.lb.upstream.remove", name, { id: Number(id) });
      res.status(200).json({ status: "removed", id: Number(id) });
    },
  );

  // ── Outbound OAuth2 client-credentials ─────────────────────────────────────

  /** SECRETS_PROVIDER_ERROR -> 502 (external KMS/secrets-manager dependency failure), not a client input error. */
  const OAUTH_ERROR_STATUS: Record<OAuthError, number> = {
    CLIENT_NOT_FOUND: 404,
    SECRETS_PROVIDER_ERROR: 502,
    SECRET_BOX_UNCONFIGURED: 400,
    INVALID_URL: 400,
  };

  parent.get("/clients/:name/oauth", (req: Request<{ name: string }>, res: Response) => {
    if (!ensureClientAccess(req, res, req.params.name)) return;
    res.status(200).json({ oauth: getClientOAuth(req.params.name) });
  });

  parent.put(
    "/clients/:name/oauth",
    requireOperator,
    async (req: Request<{ name: string }>, res: Response) => {
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
          validationError(res, "tokenUrl, clientId, and clientSecret are required (or send { oauth: null } to clear)");
          return;
        }
        input = { tokenUrl, clientId, clientSecret, scope: typeof body.scope === "string" ? body.scope : undefined };
      }
      const result = await setClientOAuth(name, input);
      if (!result.ok) {
        sendError(
          res,
          mutationErrorToStatus(result.error, OAUTH_ERROR_STATUS),
          result.error,
          result.reason ?? result.error,
        );
        return;
      }
      recordAudit(actorFromRequest(req), input ? "client.oauth.set" : "client.oauth.clear", name);
      res.status(200).json({ status: "updated", name });
    },
  );

  // ── Synthetic monitors ─────────────────────────────────────────────────────

  parent.get("/monitors", (_req: Request, res: Response) => {
    res.status(200).json({ items: listMonitors() });
  });

  // ── Traffic explorer + replay — moved to ./traffic.ts (P0-2b cont.) ──────
}
