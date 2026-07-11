import { Router, type Request, type Response } from "express";
import { registry } from "../../mcp/registry.js";
import { ensureClientAccess, requireOperator } from "../../middleware/authz.js";
import { sendError, validationError, notFound } from "../http-errors.js";
import { listExamples, createExample, deleteExample } from "../../tool-meta/tool-examples.js";
import { purgeToolCache } from "../../tool-policies/response-cache.js";
import { clearQuarantine } from "../../tool-policies/quarantine.js";
import { actorFromRequest, recordAudit } from "../../admin/audit/audit.js";
import { proxyToolCall } from "../../proxy/proxy.js";
import { toolKey } from "../../lib/identifier.js";
import { dispatchToolMutations } from "../../admin/tool-policies/mutations/index.js";

/**
 * Admin endpoints for the per-tool lifecycle on an already-registered
 * client:
 *   - bulk enable / disable across a list of tools in one client
 *   - per-tool policy PATCH (cache, coalesce, mock, transform, pagination,
 *     streaming, guardrails, quarantine, context-budget, sensitivity,
 *     redaction, override, monitor, graphql, ws, approval) — delegates to
 *     the dispatcher in `src/admin/tool-policies/mutations/index.ts`
 *   - synthetic test call against the live proxy pipeline
 *   - saved-example CRUD (playground)
 *   - circuit-breaker manual reset
 *   - per-tool response-cache purge
 *   - per-tool quarantine manual clear
 */
export const toolsRoutes = Router();

// Per-tool policy PATCH — the big multi-key handler. Each body key is
// dispatched to its own `ToolMutation` in
// `src/admin/tool-policies/mutations/<key>.ts`, in declaration order,
// which is the audit-event order for multi-key PATCHes.
toolsRoutes.patch(
  "/clients/:name/tools/:tool",
  requireOperator,
  async (req: Request<{ name: string; tool: string }>, res: Response) => {
    const { name, tool } = req.params;
    if (!ensureClientAccess(req, res, name)) return;
    const body = (req.body as Record<string, unknown>) ?? {};
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      validationError(res, "request body must be a JSON object");
      return;
    }
    const outcome = await dispatchToolMutations(
      body,
      { actor: actorFromRequest(req), clientName: name, toolName: tool },
      res,
    );
    if (outcome !== null) return; // dispatcher already wrote the error response
    res.status(200).json({ status: "updated", name, tool });
  },
);

// Bulk enable/disable across all listed tools of one client.
toolsRoutes.patch("/clients/:name/tools", requireOperator, async (req: Request<{ name: string }>, res: Response) => {
  const { name } = req.params;
  // Tenancy: this bulk toggle targets one client's tools, so scope it up front.
  if (!ensureClientAccess(req, res, name)) return;
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
    if (results[toolName]) {
      recordAudit(actor, enabled ? "tool.enable" : "tool.disable", toolKey(name, toolName), { bulk: true });
    }
  }
  res.status(200).json({ results });
});

// Synthetic test call — runs the live proxy pipeline against a real
// upstream so admins can exercise a tool without going through an MCP
// client. Full guard stack still applies.
toolsRoutes.post(
  "/clients/:name/tools/:tool/test",
  requireOperator,
  async (req: Request<{ name: string; tool: string }>, res: Response) => {
    const { name, tool } = req.params;
    if (!ensureClientAccess(req, res, name)) return;
    const mcpToolName = toolKey(name, tool);
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

// ── Saved examples (admin playground) ───────────────────────────────────────

toolsRoutes.get(
  "/clients/:name/tools/:tool/examples",
  (req: Request<{ name: string; tool: string }>, res: Response) => {
    if (!ensureClientAccess(req, res, req.params.name)) return;
    res.status(200).json({ items: listExamples(req.params.name, req.params.tool) });
  },
);

toolsRoutes.post(
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
    recordAudit(actorFromRequest(req), "tool.example.create", toolKey(name, tool), { label });
    res.status(201).json(result);
  },
);

toolsRoutes.delete(
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
    recordAudit(actorFromRequest(req), "tool.example.delete", toolKey(name, tool), {
      id: Number(id),
    });
    res.status(200).json({ status: "deleted", id: Number(id) });
  },
);

// Manual circuit-breaker reset (admin override). Forcing the breaker
// back to closed reopens the path to a known-down upstream — use with
// care.
toolsRoutes.post(
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

// Per-tool response-cache manual purge (admin override; the cached
// value expires on its TTL naturally, this is for emergencies).
toolsRoutes.post(
  "/clients/:name/tools/:tool/cache/purge",
  requireOperator,
  (req: Request<{ name: string; tool: string }>, res: Response) => {
    const { name, tool } = req.params;
    if (!ensureClientAccess(req, res, name)) return;
    if (!registry.resolveTool(toolKey(name, tool))) {
      notFound(res, "TOOL_NOT_FOUND", "Client or tool not found");
      return;
    }
    purgeToolCache(name, tool);
    recordAudit(actorFromRequest(req), "tool.cache.purge", toolKey(name, tool));
    res.status(200).json({ status: "purged", name, tool });
  },
);

// Per-tool auto-quarantine manual clear (lift the block/force-approval
// state set by the auto-quarantine policy after too many guardrail hits).
toolsRoutes.post(
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
    recordAudit(actorFromRequest(req), "tool.quarantine.clear", toolKey(name, tool));
    res.status(200).json({ status: "cleared", name, tool });
  },
);
