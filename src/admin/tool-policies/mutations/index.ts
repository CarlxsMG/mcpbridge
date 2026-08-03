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

/** One body key that could not be applied, with everything both callers need to report it. */
export type MutationFailure =
  | { kind: "validation_error"; key: string; message: string }
  | { kind: "tool_not_found"; key: string; message: string }
  | { kind: "downstream_error"; key: string; message: string; status: number; code: string };

/** Outcome of {@link applyToolMutations}: how many keys landed, and which did not. */
export interface ApplyToolMutationsResult {
  applied: number;
  failures: MutationFailure[];
}

/**
 * Runs every entry in {@link TOOL_MUTATIONS} whose `body[key]` is defined, and
 * reports what happened. Knows nothing about HTTP.
 *
 * Split out of {@link dispatchToolMutations} so config import can replay an
 * exported policy document through the SAME validate → apply → audit path an
 * admin's PATCH takes, instead of maintaining a second, drifting copy of the
 * per-policy write logic. That symmetry is what makes the export format
 * trustworthy: an exported tool document is literally a PATCH body.
 *
 * `stopOnFirstFailure` is the one behavioural difference between the two
 * callers, and both defaults are deliberate:
 *   - PATCH stops (default). A caller sent one request and gets one error
 *     back; continuing past a rejected key would apply later keys the client
 *     never learns about.
 *   - Import continues. A config document covers many keys across many tools,
 *     and one bad key — a displayName alias that now collides, a monitor whose
 *     tool_examples row does not exist on this instance — must not discard the
 *     other seventeen. This preserves the partial-application behaviour the
 *     hand-written import loop had for exactly that reason.
 */
export async function applyToolMutations(
  body: Record<string, unknown>,
  ctx: MutationContext,
  opts: { stopOnFirstFailure?: boolean } = {},
): Promise<ApplyToolMutationsResult> {
  const stopOnFirstFailure = opts.stopOnFirstFailure ?? true;
  const failures: MutationFailure[] = [];
  let purgeCache = false;
  let applied = 0;

  for (const mutation of TOOL_MUTATIONS) {
    if (body[mutation.key] === undefined) continue;

    const parsed = mutation.validate(body[mutation.key], body);
    if (!parsed.ok) {
      failures.push({ kind: "validation_error", key: mutation.key, message: parsed.message });
      if (stopOnFirstFailure) break;
      continue;
    }

    const result: MutationApplyResult = await mutation.apply(ctx, parsed.value);
    if (result.kind === "tool_not_found") {
      failures.push({ kind: "tool_not_found", key: mutation.key, message: "Client or tool not found" });
      if (stopOnFirstFailure) break;
      continue;
    }
    if (result.kind === "error") {
      failures.push({
        kind: "downstream_error",
        key: mutation.key,
        message: result.reason ?? result.code,
        status: result.status,
        code: result.code,
      });
      if (stopOnFirstFailure) break;
      continue;
    }

    if (mutation.purgesCache) purgeCache = true;
    applied++;

    const { action, meta } = mutation.audit(body[mutation.key], parsed.value);
    recordAudit(ctx.actor, action, auditTarget(ctx), meta);
  }
  // A response-shaping policy changed: drop any responses cached under the old
  // policy so a hit can't keep serving the pre-change (e.g. un-redacted) body.
  if (purgeCache) purgeToolCache(ctx.clientName, ctx.toolName);
  return { applied, failures };
}

/**
 * Reads every policy in {@link TOOL_MUTATIONS} back for one tool, in the exact
 * body shape {@link applyToolMutations} accepts. Unset policies are omitted, so
 * a tool with no configuration exports as `{ enabled: true }` rather than as
 * eighteen nulls.
 *
 * Because the registry drives this, a policy added later is exported the day it
 * is added — the omission that left fifteen per-tool policies out of every
 * config snapshot and rollback is not expressible any more.
 */
export function readToolPolicies(clientName: string, toolName: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const mutation of TOOL_MUTATIONS) {
    const value = mutation.read(clientName, toolName);
    if (value !== undefined) out[mutation.key] = value;
    const companions = mutation.readCompanions?.(clientName, toolName);
    // The `if` is readability, not behaviour: `Object.assign(out, undefined)` is
    // a legal no-op, so dropping the guard changes nothing observable. Stryker
    // reports the mutant that removes it as a survivor and always will —
    // it is equivalent, not an untested branch.
    if (companions) Object.assign(out, companions);
  }
  return out;
}

/**
 * HTTP adapter over {@link applyToolMutations} for the PATCH route.
 *
 * Returns `null` on success (caller responds 200) or a sentinel string
 * identifying the failure case this already wrote to `res` (caller
 * short-circuits). The split between null and sentinel keeps the call site in
 * the route handler short without dragging in a discriminated-union result type
 * for the rare failure case.
 */
export async function dispatchToolMutations(
  body: Record<string, unknown>,
  ctx: MutationContext,
  res: DispatcherResponse,
): Promise<DispatchOutcome> {
  // Passed explicitly even though `true` is also the default, so the HTTP
  // contract — one request, one error, nothing applied after it — is readable
  // here rather than inferred from another file. Stryker reports emptying this
  // object as a survivor for exactly that reason: it is equivalent.
  const { failures } = await applyToolMutations(body, ctx, { stopOnFirstFailure: true });
  const failure = failures[0];
  if (!failure) return null;
  if (failure.kind === "validation_error") {
    validationError(res, failure.message);
    return "validation_error";
  }
  if (failure.kind === "tool_not_found") {
    notFound(res, "TOOL_NOT_FOUND", failure.message);
    return "tool_not_found";
  }
  sendError(res, failure.status, failure.code, failure.message);
  return "downstream_error";
}
