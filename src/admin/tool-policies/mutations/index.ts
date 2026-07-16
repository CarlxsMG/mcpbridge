/**
 * Tool PATCH mutation registry + dispatcher.
 *
 * One entry per body key `PATCH /admin-api/clients/:name/tools/:tool`
 * accepts. The route handler in `src/routes/admin/tools.ts` delegates
 * to {@link dispatchToolMutations}, which iterates this registry in
 * declaration order and dispatches each defined body key to its
 * sub-handler. Declaration order is the audit-event order for multi-key
 * PATCHes; the snapshot fixture
 * `src/__tests__/tools-patch-snapshot.test.ts` guards it.
 *
 * Adding a new body key: create `./<key>.ts` exporting a `ToolMutation`
 * const, import it here, append it to {@link TOOL_MUTATIONS}. No other
 * file needs to change.
 */
import { TOOL_KEY_SEPARATOR } from "../../../lib/identifier.js";
import { recordAudit } from "../../../admin/audit/audit.js";
import { purgeToolCache } from "../../../tool-policies/response-cache.js";
import { sendError, validationError, notFound } from "../../../routes/http-errors.js";
import type {
  DispatchOutcome,
  DispatcherResponse,
  MutationApplyResult,
  MutationContext,
  ToolMutation,
} from "./types.js";

import { enabledMutation } from "./enabled.js";
import { guardsMutation } from "./guards.js";
import { overridesMutation } from "./overrides.js";
import { sensitiveMutation } from "./sensitive.js";
import { redactPathsMutation } from "./redact-paths.js";
import { guardrailsMutation } from "./guardrails.js";
import { cacheMutation } from "./cache.js";
import { coalesceMutation } from "./coalesce.js";
import { quarantinePolicyMutation } from "./quarantine-policy.js";
import { paginationMutation } from "./pagination.js";
import { streamingMutation } from "./streaming.js";
import { transformMutation } from "./transform.js";
import { mockMutation } from "./mock.js";
import { requiresApprovalMutation } from "./requires-approval.js";
import { monitorMutation } from "./monitor.js";
import { graphqlMutation } from "./graphql.js";
import { wsMutation } from "./ws.js";
import { contextBudgetMutation } from "./context-budget.js";

export type { MutationApplyResult, MutationContext, ToolMutation, DispatchOutcome } from "./types.js";

/** Canonical `client__tool` audit target string. */
function auditTarget(ctx: MutationContext): string {
  return `${ctx.clientName}${TOOL_KEY_SEPARATOR}${ctx.toolName}`;
}

/**
 * Per-body-key sub-handlers, in declaration order. Order matters: the
 * dispatcher iterates this array in order, and a single multi-key PATCH
 * emits audit events in this order.
 */
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

/**
 * Runs every entry in {@link TOOL_MUTATIONS} whose `body[key]` is defined.
 *
 * Returns `null` on success (caller responds 200) or a sentinel string
 * identifying the failure case the dispatcher already wrote to `res`
 * (caller short-circuits). The split between null and sentinel keeps the
 * call site in the route handler short without dragging in a
 * discriminated-union result type for the rare failure case.
 */
export async function dispatchToolMutations(
  body: Record<string, unknown>,
  ctx: MutationContext,
  res: DispatcherResponse,
): Promise<DispatchOutcome> {
  let purgeCache = false;
  for (const mutation of TOOL_MUTATIONS) {
    if (body[mutation.key] === undefined) continue;

    const parsed = mutation.validate(body[mutation.key], body);
    if (!parsed.ok) {
      validationError(res, parsed.message);
      return "validation_error";
    }

    const result: MutationApplyResult = await mutation.apply(ctx, parsed.value);
    if (result.kind === "tool_not_found") {
      notFound(res, "TOOL_NOT_FOUND", "Client or tool not found");
      return "tool_not_found";
    }
    if (result.kind === "error") {
      sendError(res, result.status, result.code, result.reason ?? result.code);
      return "downstream_error";
    }

    if (mutation.purgesCache) purgeCache = true;

    const { action, meta } = mutation.audit(body[mutation.key], parsed.value);
    recordAudit(ctx.actor, action, auditTarget(ctx), meta);
  }
  // A response-shaping policy changed: drop any responses cached under the old
  // policy so a hit can't keep serving the pre-change (e.g. un-redacted) body.
  if (purgeCache) purgeToolCache(ctx.clientName, ctx.toolName);
  return null;
}
