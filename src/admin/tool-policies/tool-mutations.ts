/**
 * Dispatcher registry for `PATCH /admin-api/clients/:name/tools/:tool`.
 *
 * Before this file existed, the PATCH handler in
 * `src/routes/admin/legacyMount.ts` was a 370-LOC chain of `if (body.X !==
 * undefined) { validate → apply → audit }` blocks — one per body key, all
 * of which had to live in the same handler and run as one atomic call.
 *
 * That shape doesn't fit the per-entity router split (`src/routes/admin/`
 * has one file per admin entity) because the 16 tool-level policy mutations
 * logically belong to one endpoint, not 16 endpoints. The right shape is a
 * sub-handler dispatcher: each mutation declares its own validate / apply /
 * audit contract, the PATCH handler iterates the registry in declaration
 * order, and the order in the registry is the order audit events are
 * emitted (which is part of the observable contract — see
 * `src/__tests__/tools-patch-snapshot.test.ts`).
 *
 * Adding a new body key: append a new entry to {@link TOOL_MUTATIONS} with
 * the appropriate `validate` / `apply` / `audit` implementation. The PATCH
 * handler picks it up automatically.
 *
 * Moving an entry to its own file (the next step in closing the P0-2b split
 * per `docs/ADMIN_ROUTE_SPLIT.md`) is purely a refactor: import the entry
 * from the new location and re-export it through this registry.
 */
import { registry, ToolOverrideError } from "../../mcp/registry.js";
import { TOOL_KEY_SEPARATOR } from "../../lib/identifier.js";
import { setToolSensitive } from "../../tool-meta/tool-sensitivity.js";
import { setRedactionPaths } from "../../content-filtering/redaction.js";
import { setGuardrails } from "../../tool-policies/guardrails.js";
import { setToolCacheConfig } from "../../tool-policies/response-cache.js";
import { setToolCoalesce } from "../../tool-policies/coalesce.js";
import { setQuarantinePolicy } from "../../tool-policies/quarantine.js";
import { setPaginationConfig } from "../../tool-policies/pagination.js";
import { setStreamingConfig } from "../../proxy/streaming.js";
import { setToolTransform } from "../../proxy/transform.js";
import { setToolMock } from "../../tool-meta/tool-mock.js";
import { setApprovalRequired, MAX_APPROVAL_LEVELS } from "../../admin/entities/approvals.js";
import { setMonitor, deleteMonitor } from "../../observability/monitor.js";
import { setToolGraphql, setToolWs } from "../../proxy/backends.js";
import { setToolContextBudget } from "../../tool-policies/context-budget.js";
import {
  validateCacheInput,
  validateCoalesceInput,
  validateQuarantinePolicyInput,
  validateContextBudgetInput,
  validatePaginationInput,
  validateStreamingInput,
  validateTransformInput,
  validateMockInput,
  validateToolGuardInput,
  validateToolOverrideInput,
  validateGuardrailsInput,
} from "../../routes/admin-validators.js";
import type { ValidationResult } from "../../routes/validation.js";

// ─── Public types ──────────────────────────────────────────────────────────

/**
 * Per-mutation apply result. Three outcomes:
 *   - `ok`: the mutation persisted; the PATCH handler will record an audit
 *     event (the action label + meta come from {@link ToolMutation.audit}).
 *   - `tool_not_found`: the client or tool doesn't exist; the PATCH handler
 *     responds 404 with the same `TOOL_NOT_FOUND` envelope every other
 *     per-tool mutation uses, so the wire contract is uniform.
 *   - `error`: any other failure (validator didn't catch, downstream
 *     refused). The PATCH handler responds with the supplied `status`,
 *     `code`, and `reason` via the standard error envelope.
 */
export type MutationApplyResult =
  | { kind: "ok" }
  | { kind: "tool_not_found" }
  | { kind: "error"; status: number; code: string; reason?: string };

/**
 * Context passed to a mutation's `apply` and `audit` callbacks. Carries the
 * target identity (so mutations don't have to thread it through their own
 * closures) and the per-call extras a few mutations need (audit actor).
 */
export interface MutationContext {
  actor: string;
  clientName: string;
  toolName: string;
}

/**
 * One PATCH-body sub-handler. Implementations live inline below for now;
 * the next refactor pass will move each entry to its own file
 * (`mutations/cache.ts`, `mutations/monitor.ts`, …) without changing the
 * shape — see `docs/ADMIN_ROUTE_SPLIT.md` for the plan.
 */
export interface ToolMutation {
  /**
   * The body key that triggers this mutation. The PATCH handler skips the
   * entry when `body[key] === undefined`.
   */
  key: string;

  /**
   * Validates the raw value at `body[key]`. May inspect the whole body
   * for co-dependent fields (e.g. `requiresApproval` reads `approvalLevels`
   * from the same body). Returns a `ValidationResult` so 400s flow through
   * the same `VALIDATION_ERROR` envelope the validators in
   * `src/routes/admin-validators.ts` produce.
   */
  validate: (raw: unknown, body: Record<string, unknown>) => ValidationResult<unknown>;

  /**
   * Persists the mutation. Returns the outcome; the dispatcher decides the
   * HTTP response (200/404/400) and whether to call `audit`.
   */
  apply: (ctx: MutationContext, parsed: unknown) => Promise<MutationApplyResult>;

  /**
   * Computes the audit action label and optional `detail` meta. Receives the
   * raw body value (for cases where the audit needs to reference a co-key)
   * and the parsed value (for cases where the action label depends on
   * set-vs-clear).
   */
  audit: (raw: unknown, parsed: unknown) => { action: string; meta?: Record<string, unknown> };
}

/** Builds the canonical `client__tool` audit target string. */
function auditTarget(ctx: MutationContext): string {
  return `${ctx.clientName}${TOOL_KEY_SEPARATOR}${ctx.toolName}`;
}

// ─── ToolMutation implementations ──────────────────────────────────────────
//
// Order in this array is significant: the PATCH handler iterates entries in
// order, and a single multi-key PATCH emits audit events in this order.
// Reorder = change the wire contract; the snapshot fixture will catch it.

// ── enabled ────────────────────────────────────────────────────────────────
const enabledMutation: ToolMutation = {
  key: "enabled",
  validate: (raw) => {
    if (typeof raw !== "boolean") return { ok: false, message: "enabled must be a boolean" };
    return { ok: true, value: raw };
  },
  apply: async (ctx, parsed) => {
    const ok = await registry.setToolEnabled(ctx.clientName, ctx.toolName, parsed as boolean);
    return ok ? { kind: "ok" } : { kind: "tool_not_found" };
  },
  audit: (_raw, parsed) => ({ action: parsed ? "tool.enable" : "tool.disable" }),
};

// ── guards ─────────────────────────────────────────────────────────────────
const guardsMutation: ToolMutation = {
  key: "guards",
  validate: (raw) => validateToolGuardInput(raw) as ValidationResult<unknown>,
  apply: async (ctx, parsed) => {
    const ok = await registry.setToolGuards(
      ctx.clientName,
      ctx.toolName,
      parsed as Parameters<typeof registry.setToolGuards>[2],
    );
    return ok ? { kind: "ok" } : { kind: "tool_not_found" };
  },
  audit: () => ({ action: "tool.guards.update" }),
};

// ── overrides ──────────────────────────────────────────────────────────────
const overridesMutation: ToolMutation = {
  key: "overrides",
  validate: (raw) => validateToolOverrideInput(raw) as ValidationResult<unknown>,
  apply: async (ctx, parsed) => {
    try {
      const ok = await registry.setToolOverride(
        ctx.clientName,
        ctx.toolName,
        parsed as Parameters<typeof registry.setToolOverride>[2],
      );
      return ok ? { kind: "ok" } : { kind: "tool_not_found" };
    } catch (err) {
      if (err instanceof ToolOverrideError) {
        const status = err.code === "TOOL_ALIAS_CONFLICT" ? 409 : 400;
        return { kind: "error", status, code: err.code, reason: err.message };
      }
      throw err;
    }
  },
  audit: () => ({ action: "tool.override.update" }),
};

// ── sensitive ──────────────────────────────────────────────────────────────
const sensitiveMutation: ToolMutation = {
  key: "sensitive",
  validate: (raw) => {
    if (raw !== null && typeof raw !== "boolean") {
      return { ok: false, message: "sensitive must be a boolean or null" };
    }
    return { ok: true, value: raw };
  },
  apply: async (ctx, parsed) => {
    const ok = setToolSensitive(ctx.clientName, ctx.toolName, parsed as boolean | null);
    return ok ? { kind: "ok" } : { kind: "tool_not_found" };
  },
  audit: (_raw, parsed) => ({ action: "tool.sensitive.set", meta: { sensitive: parsed } }),
};

// ── redactPaths ────────────────────────────────────────────────────────────
const redactPathsMutation: ToolMutation = {
  key: "redactPaths",
  validate: (raw) => {
    if (!Array.isArray(raw) || !raw.every((p) => typeof p === "string")) {
      return { ok: false, message: "redactPaths must be an array of strings" };
    }
    return { ok: true, value: raw };
  },
  apply: async (ctx, parsed) => {
    const ok = setRedactionPaths(ctx.clientName, ctx.toolName, parsed as string[]);
    return ok ? { kind: "ok" } : { kind: "tool_not_found" };
  },
  audit: (_raw, parsed) => ({ action: "tool.redaction.set", meta: { count: (parsed as string[]).length } }),
};

// ── guardrails ─────────────────────────────────────────────────────────────
const guardrailsMutation: ToolMutation = {
  key: "guardrails",
  validate: (raw) => validateGuardrailsInput(raw) as ValidationResult<unknown>,
  apply: async (ctx, parsed) => {
    const ok = setGuardrails(
      ctx.clientName,
      ctx.toolName,
      parsed as Parameters<typeof setGuardrails>[2],
    );
    return ok ? { kind: "ok" } : { kind: "tool_not_found" };
  },
  audit: (_raw, parsed) => {
    // Unlike every other per-tool mutation, guardrails always emits the same
    // detail shape (with default values when the input was null/clear) so
    // downstream audit consumers can rely on a stable payload regardless of
    // set-vs-clear. Mirrors the legacy handler in `legacyMount.ts` exactly.
    const v = parsed as { denyPatterns: string[]; blockSecrets: boolean; scanResponses: boolean } | null;
    return {
      action: "tool.guardrails.set",
      meta: {
        denyPatterns: v?.denyPatterns.length ?? 0,
        blockSecrets: v?.blockSecrets ?? false,
        scanResponses: v?.scanResponses ?? false,
      },
    };
  },
};

// ── cache ──────────────────────────────────────────────────────────────────
const cacheMutation: ToolMutation = {
  key: "cache",
  validate: (raw) => validateCacheInput(raw) as ValidationResult<unknown>,
  apply: async (ctx, parsed) => {
    const ok = setToolCacheConfig(
      ctx.clientName,
      ctx.toolName,
      parsed as Parameters<typeof setToolCacheConfig>[2],
    );
    return ok ? { kind: "ok" } : { kind: "tool_not_found" };
  },
  audit: (_raw, parsed) => {
    const v = parsed as { enabled: boolean; ttlSeconds: number } | null;
    return {
      action: v ? "tool.cache.set" : "tool.cache.clear",
      meta: v ? { ttlSeconds: v.ttlSeconds, enabled: v.enabled } : undefined,
    };
  },
};

// ── coalesce ───────────────────────────────────────────────────────────────
const coalesceMutation: ToolMutation = {
  key: "coalesce",
  validate: (raw) => validateCoalesceInput(raw) as ValidationResult<unknown>,
  apply: async (ctx, parsed) => {
    const ok = setToolCoalesce(
      ctx.clientName,
      ctx.toolName,
      parsed as Parameters<typeof setToolCoalesce>[2],
    );
    return ok ? { kind: "ok" } : { kind: "tool_not_found" };
  },
  audit: (_raw, parsed) => {
    const v = parsed as { enabled: boolean } | null;
    return {
      action: v ? "tool.coalesce.set" : "tool.coalesce.clear",
      meta: v ? { enabled: v.enabled } : undefined,
    };
  },
};

// ── quarantinePolicy ──────────────────────────────────────────────────────
const quarantinePolicyMutation: ToolMutation = {
  key: "quarantinePolicy",
  validate: (raw) => validateQuarantinePolicyInput(raw) as ValidationResult<unknown>,
  apply: async (ctx, parsed) => {
    const ok = setQuarantinePolicy(
      ctx.clientName,
      ctx.toolName,
      parsed as Parameters<typeof setQuarantinePolicy>[2],
    );
    return ok ? { kind: "ok" } : { kind: "tool_not_found" };
  },
  audit: (_raw, parsed) => {
    const v = parsed as Record<string, unknown> | null;
    return {
      action: v ? "tool.quarantine.policy.set" : "tool.quarantine.policy.clear",
      meta: (v as Record<string, unknown> | undefined) ?? undefined,
    };
  },
};

// ── pagination ─────────────────────────────────────────────────────────────
const paginationMutation: ToolMutation = {
  key: "pagination",
  validate: (raw) => validatePaginationInput(raw) as ValidationResult<unknown>,
  apply: async (ctx, parsed) => {
    const ok = setPaginationConfig(
      ctx.clientName,
      ctx.toolName,
      parsed as Parameters<typeof setPaginationConfig>[2],
    );
    return ok ? { kind: "ok" } : { kind: "tool_not_found" };
  },
  audit: (_raw, parsed) => {
    const v = parsed as { strategy: string; maxPages: number } | null;
    return {
      action: v ? "tool.pagination.set" : "tool.pagination.clear",
      meta: v ? { strategy: v.strategy, maxPages: v.maxPages } : undefined,
    };
  },
};

// ── streaming ──────────────────────────────────────────────────────────────
const streamingMutation: ToolMutation = {
  key: "streaming",
  validate: (raw) => validateStreamingInput(raw) as ValidationResult<unknown>,
  apply: async (ctx, parsed) => {
    const ok = setStreamingConfig(
      ctx.clientName,
      ctx.toolName,
      parsed as Parameters<typeof setStreamingConfig>[2],
    );
    return ok ? { kind: "ok" } : { kind: "tool_not_found" };
  },
  audit: (_raw, parsed) => {
    const v = parsed as { format: string } | null;
    return {
      action: v ? "tool.streaming.set" : "tool.streaming.clear",
      meta: v ? { format: v.format } : undefined,
    };
  },
};

// ── transform ──────────────────────────────────────────────────────────────
const transformMutation: ToolMutation = {
  key: "transform",
  validate: (raw) => validateTransformInput(raw) as ValidationResult<unknown>,
  apply: async (ctx, parsed) => {
    const ok = setToolTransform(
      ctx.clientName,
      ctx.toolName,
      parsed as Parameters<typeof setToolTransform>[2],
    );
    return ok ? { kind: "ok" } : { kind: "tool_not_found" };
  },
  audit: (_raw, parsed) => {
    const v = parsed as { request: unknown[]; response: unknown[] } | null;
    return {
      action: v ? "tool.transform.set" : "tool.transform.clear",
      meta: v ? { request: v.request.length, response: v.response.length } : undefined,
    };
  },
};

// ── mock ───────────────────────────────────────────────────────────────────
const mockMutation: ToolMutation = {
  key: "mock",
  validate: (raw) => validateMockInput(raw) as ValidationResult<unknown>,
  apply: async (ctx, parsed) => {
    const ok = setToolMock(
      ctx.clientName,
      ctx.toolName,
      parsed as Parameters<typeof setToolMock>[2],
    );
    return ok ? { kind: "ok" } : { kind: "tool_not_found" };
  },
  audit: (_raw, parsed) => {
    const v = parsed as { mode: string } | null;
    return {
      action: v ? "tool.mock.set" : "tool.mock.clear",
      meta: v ? { mode: v.mode } : undefined,
    };
  },
};

// ── requiresApproval (co-reads `approvalLevels` from the same body) ────────
const requiresApprovalMutation: ToolMutation = {
  key: "requiresApproval",
  validate: (raw, body) => {
    if (typeof raw !== "boolean") return { ok: false, message: "requiresApproval must be a boolean" };
    let approvalLevels: number | undefined;
    if (body.approvalLevels !== undefined) {
      if (
        typeof body.approvalLevels !== "number" ||
        !Number.isInteger(body.approvalLevels) ||
        body.approvalLevels < 1 ||
        body.approvalLevels > MAX_APPROVAL_LEVELS
      ) {
        return {
          ok: false,
          message: `approvalLevels must be an integer between 1 and ${MAX_APPROVAL_LEVELS}`,
        };
      }
      approvalLevels = body.approvalLevels;
    }
    return { ok: true, value: { enabled: raw, approvalLevels } };
  },
  apply: async (ctx, parsed) => {
    const v = parsed as { enabled: boolean; approvalLevels: number | undefined };
    const ok = setApprovalRequired(ctx.clientName, ctx.toolName, v.enabled, v.approvalLevels);
    return ok ? { kind: "ok" } : { kind: "tool_not_found" };
  },
  audit: (_raw, parsed) => {
    const v = parsed as { enabled: boolean; approvalLevels: number | undefined };
    return {
      action: v.enabled ? "tool.approval.enable" : "tool.approval.disable",
      meta: v.approvalLevels !== undefined ? { approvalLevels: v.approvalLevels } : undefined,
    };
  },
};

// ── monitor (object / null / false → set / clear) ─────────────────────────
const monitorMutation: ToolMutation = {
  key: "monitor",
  validate: (raw) => {
    if (raw === null || raw === false) return { ok: true, value: { kind: "clear" } };
    if (typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, message: "monitor must be an object, null, or false" };
    }
    const mo = raw as Record<string, unknown>;
    const exampleId = typeof mo.exampleId === "number" ? mo.exampleId : NaN;
    if (!Number.isInteger(exampleId)) {
      return { ok: false, message: "monitor.exampleId (number) is required" };
    }
    return {
      ok: true,
      value: {
        kind: "set",
        exampleId,
        intervalMinutes: typeof mo.intervalMinutes === "number" ? mo.intervalMinutes : 15,
        enabled: mo.enabled !== false,
      },
    };
  },
  apply: async (ctx, parsed) => {
    const v = parsed as
      | { kind: "clear" }
      | { kind: "set"; exampleId: number; intervalMinutes: number; enabled: boolean };
    if (v.kind === "clear") {
      await deleteMonitor(ctx.clientName, ctx.toolName);
      return { kind: "ok" };
    }
    const result = await setMonitor(ctx.clientName, ctx.toolName, {
      exampleId: v.exampleId,
      intervalMinutes: v.intervalMinutes,
      enabled: v.enabled,
    });
    if (!result.ok) {
      return {
        kind: "error",
        status: result.error === "TOOL_NOT_LIVE" ? 404 : 400,
        code: result.error,
        reason: result.error,
      };
    }
    return { kind: "ok" };
  },
  audit: (_raw, parsed) => {
    const v = parsed as { kind: "clear" } | { kind: "set"; exampleId: number };
    if (v.kind === "clear") return { action: "tool.monitor.clear" };
    return { action: "tool.monitor.set", meta: { exampleId: v.exampleId } };
  },
};

// ── graphql (object / null / false → set / clear) ─────────────────────────
const graphqlMutation: ToolMutation = {
  key: "graphql",
  validate: (raw) => {
    if (raw === null || raw === false) return { ok: true, value: { kind: "clear" } };
    if (typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, message: "graphql must be an object, null, or false" };
    }
    const g = raw as Record<string, unknown>;
    const query = typeof g.query === "string" ? g.query.trim() : "";
    if (!query) return { ok: false, message: "graphql.query (non-empty string) is required" };
    return { ok: true, value: { kind: "set", enabled: g.enabled !== false, query } };
  },
  apply: async (ctx, parsed) => {
    const v = parsed as { kind: "clear" } | { kind: "set"; enabled: boolean; query: string };
    if (v.kind === "clear") {
      setToolGraphql(ctx.clientName, ctx.toolName, null);
      return { kind: "ok" };
    }
    const ok = setToolGraphql(ctx.clientName, ctx.toolName, { enabled: v.enabled, query: v.query });
    return ok ? { kind: "ok" } : { kind: "tool_not_found" };
  },
  audit: (raw) => {
    if (raw === null || raw === false) return { action: "tool.graphql.clear" };
    return { action: "tool.graphql.set" };
  },
};

// ── ws (object / null / false → set / clear) ─────────────────────────────
const wsMutation: ToolMutation = {
  key: "ws",
  validate: (raw) => {
    if (raw === null || raw === false) return { ok: true, value: { kind: "clear" } };
    if (typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, message: "ws must be an object, null, or false" };
    }
    const w = raw as Record<string, unknown>;
    const wsUrl = typeof w.wsUrl === "string" ? w.wsUrl : "";
    if (!wsUrl) return { ok: false, message: "ws.wsUrl (ws:// or wss://) is required" };
    return {
      ok: true,
      value: {
        kind: "set",
        enabled: w.enabled !== false,
        wsUrl,
        persistent: w.persistent === true,
      },
    };
  },
  apply: async (ctx, parsed) => {
    const v = parsed as
      | { kind: "clear" }
      | { kind: "set"; enabled: boolean; wsUrl: string; persistent: boolean };
    if (v.kind === "clear") {
      await setToolWs(ctx.clientName, ctx.toolName, null);
      return { kind: "ok" };
    }
    const result = await setToolWs(ctx.clientName, ctx.toolName, {
      enabled: v.enabled,
      wsUrl: v.wsUrl,
      persistent: v.persistent,
    });
    if (!result.ok) {
      return {
        kind: "error",
        status: result.error === "TOOL_NOT_FOUND" ? 404 : 400,
        code: result.error,
        reason: result.reason ?? result.error,
      };
    }
    return { kind: "ok" };
  },
  audit: (_raw, parsed) => {
    const v = parsed as { kind: "clear" } | { kind: "set"; persistent: boolean };
    if (v.kind === "clear") return { action: "tool.ws.clear" };
    return { action: "tool.ws.set", meta: { persistent: v.persistent } };
  },
};

// ── contextBudget ──────────────────────────────────────────────────────────
const contextBudgetMutation: ToolMutation = {
  key: "contextBudget",
  validate: (raw) => validateContextBudgetInput(raw) as ValidationResult<unknown>,
  apply: async (ctx, parsed) => {
    const result = await setToolContextBudget(
      ctx.clientName,
      ctx.toolName,
      parsed as Parameters<typeof setToolContextBudget>[2],
    );
    if (!result.ok) {
      return {
        kind: "error",
        status: result.error === "TOOL_NOT_FOUND" ? 404 : 400,
        code: result.error,
        reason: result.reason ?? result.error,
      };
    }
    return { kind: "ok" };
  },
  audit: (_raw, parsed) => {
    const v = parsed as
      | { mode: string; maxResponseBytes: number; llm?: { provider: string } }
      | null;
    return {
      action: v ? "tool.context_budget.set" : "tool.context_budget.clear",
      meta: v
        ? {
            mode: v.mode,
            maxResponseBytes: v.maxResponseBytes,
            ...(v.mode === "llm_summarize" && v.llm ? { llmProvider: v.llm.provider } : {}),
          }
        : undefined,
    };
  },
};

// ─── Public registry (declaration order = audit event order) ──────────────

export const TOOL_MUTATIONS: readonly ToolMutation[] = [
  enabledMutation,
  guardsMutation,
  overridesMutation,
  sensitiveMutation,
  redactPathsMutation,
  guardrailsMutation,
  cacheMutation,
  coalesceMutation,
  quarantinePolicyMutation,
  paginationMutation,
  streamingMutation,
  transformMutation,
  mockMutation,
  requiresApprovalMutation,
  monitorMutation,
  graphqlMutation,
  wsMutation,
  contextBudgetMutation,
];

// ─── Dispatcher ────────────────────────────────────────────────────────────

import type { Response } from "express";
import { recordAudit } from "../../admin/audit/audit.js";
import { sendError, validationError, notFound } from "../../routes/http-errors.js";

/**
 * Runs every entry in {@link TOOL_MUTATIONS} whose `body[key]` is defined.
 * Returns `null` on success (caller should respond 200) or writes the
 * appropriate error envelope to `res` and returns a sentinel string
 * identifying which one. The split between return-null and return-sentinel
 * keeps the call site short without dragging in a discriminated-union
 * result type for the rare failure case.
 */
export async function dispatchToolMutations(
  body: Record<string, unknown>,
  ctx: MutationContext,
  res: Response,
): Promise<"validation_error" | "tool_not_found" | "downstream_error" | null> {
  for (const mutation of TOOL_MUTATIONS) {
    if (body[mutation.key] === undefined) continue;

    const parsed = mutation.validate(body[mutation.key], body);
    if (!parsed.ok) {
      validationError(res, parsed.message);
      return "validation_error";
    }

    const result = await mutation.apply(ctx, parsed.value);
    if (result.kind === "tool_not_found") {
      notFound(res, "TOOL_NOT_FOUND", "Client or tool not found");
      return "tool_not_found";
    }
    if (result.kind === "error") {
      sendError(res, result.status, result.code, result.reason ?? result.code);
      return "downstream_error";
    }

    const { action, meta } = mutation.audit(body[mutation.key], parsed.value);
    recordAudit(ctx.actor, action, auditTarget(ctx), meta);
  }
  return null;
}
