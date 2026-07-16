/**
 * Shared types for the per-tool PATCH mutation registry.
 *
 * Each entry in {@link ./index.ts}'s `TOOL_MUTATIONS` array implements
 * {@link ToolMutation} (one sub-handler per body key the PATCH endpoint
 * accepts). The dispatcher reads `validate` → `apply` → `audit` in that
 * order for every defined body key, in the registry's declaration order.
 *
 * Declaration order is part of the wire contract: a single multi-key
 * PATCH emits audit events in the registry's order, and downstream
 * consumers (the audit log, the admin UI's "recent activity" panel)
 * rely on that ordering. The snapshot fixture
 * `src/__tests__/tools-patch-snapshot.test.ts` guards the contract.
 */
import type { Response } from "express";
import type { ValidationResult } from "../../../routes/validation.js";

/**
 * Outcome of {@link ToolMutation.apply}. Three branches:
 *   - `ok`: the mutation persisted; the dispatcher will call `audit` and
 *     record the resulting event.
 *   - `tool_not_found`: the client or tool doesn't exist; the dispatcher
 *     writes the standard 404 `TOOL_NOT_FOUND` envelope.
 *   - `error`: any other downstream refusal. The dispatcher writes a
 *     response with the supplied `status` / `code` / `reason` via the
 *     standard error envelope.
 */
export type MutationApplyResult =
  { kind: "ok" } | { kind: "tool_not_found" } | { kind: "error"; status: number; code: string; reason?: string };

/**
 * Per-call context threaded through every mutation. Carries the target
 * identity and the actor label so individual mutations don't have to
 * re-resolve them.
 */
export interface MutationContext {
  actor: string;
  clientName: string;
  toolName: string;
}

/**
 * One PATCH-body sub-handler. Implementations live in sibling files
 * (`./enabled.ts`, `./cache.ts`, …) and are re-exported through
 * `./index.ts`.
 */
export interface ToolMutation {
  /** The body key that triggers this mutation. */
  key: string;

  /**
   * When true, a successful application of this mutation changes how the
   * tool's responses are shaped (redaction, guardrail scanning, transforms,
   * streaming framing, pagination, context budget). Any already-cached
   * response predates the new policy and would keep serving the old shape,
   * so the dispatcher purges the tool's response cache once after applying
   * all mutations (see {@link ./index.ts}).
   */
  purgesCache?: boolean;

  /**
   * Validates `body[key]`. May inspect the whole body for co-dependent
   * fields (e.g. `requiresApproval` reads `approvalLevels` from the same
   * body). Returns a `ValidationResult` so 400s flow through the same
   * `VALIDATION_ERROR` envelope the validators in
   * `src/routes/admin-validators.ts` produce.
   */
  validate: (raw: unknown, body: Record<string, unknown>) => ValidationResult<unknown>;

  /** Persists the mutation. See {@link MutationApplyResult}. */
  apply: (ctx: MutationContext, parsed: unknown) => Promise<MutationApplyResult>;

  /**
   * Computes the audit action label and optional `detail` meta. Receives
   * the raw body value and the parsed value so the audit can depend on
   * either (most use `parsed`; a few use `raw` when the action label
   * needs to distinguish set-vs-clear from the original shape).
   */
  audit: (raw: unknown, parsed: unknown) => { action: string; meta?: Record<string, unknown> };
}

/** Sentinel result types returned by the dispatcher for the route handler. */
export type DispatchOutcome = "validation_error" | "tool_not_found" | "downstream_error" | null;

/** Marker export so the dispatcher module can take a `Response` without re-typing it. */
export type DispatcherResponse = Response;
