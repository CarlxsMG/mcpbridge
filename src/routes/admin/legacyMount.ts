import type { Request, Response, Router } from "express";
import { registry, ToolOverrideError } from "../../mcp/registry.js";
import { TOOL_KEY_SEPARATOR, toolKey } from "../../lib/identifier.js";
import { proxyToolCall } from "../../proxy/proxy.js";
import { setToolSensitive } from "../../tool-meta/tool-sensitivity.js";
import { setRedactionPaths } from "../../content-filtering/redaction.js";
import { setGuardrails } from "../../tool-policies/guardrails.js";
import { listExamples, createExample, deleteExample } from "../../tool-meta/tool-examples.js";

import { setToolCacheConfig, purgeToolCache } from "../../tool-policies/response-cache.js";
import { setToolCoalesce } from "../../tool-policies/coalesce.js";
import {
  setQuarantinePolicy,
  clearQuarantine,
} from "../../tool-policies/quarantine.js";

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
} from "./admin-validators.js";
export function mountLegacy(parent: Router): void {
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

  // ── Traffic explorer + replay — moved to ./traffic.ts (P0-2b cont.) ──────
}
