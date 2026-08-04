/**
 * Shared result-of-validation shape for the many ad hoc `validateXInput`-style
 * helpers scattered across src/routes/*.ts. `ok: true` carries the
 * parsed/validated value; `ok: false` carries a human-readable message meant
 * to be passed straight to `validationError()` in ./http-errors.ts.
 *
 *   function validateFoo(raw: unknown): ValidationResult<Foo> { ... }
 *   const parsed = validateFoo(body.foo);
 *   if (!parsed.ok) { validationError(res, parsed.message); return; }
 *   use(parsed.value);
 */
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * Upper bound for any admin-settable per-tool call timeout, in milliseconds.
 *
 * A tool's `guards.timeoutMs` (and the equivalent field on a guard policy)
 * substitutes directly for `config.toolCallTimeoutMs` at dispatch —
 * `dispatch-rest.ts` reads `circuitCheck.timeout ?? tool.guards?.timeoutMs ??
 * config.toolCallTimeoutMs`. The env-var form is range-checked to this same
 * ceiling by `config-schema.ts` (`TOOL_CALL_TIMEOUT_MS: envInt(30_000, 100,
 * 600_000)`), but the per-tool overrides only required "a positive number", so
 * they could set a timer far beyond it and pin a request — and a WebSocket probe
 * in `proxy/backends.ts` — open effectively forever. Both paths now share the
 * env schema's ceiling instead of silently escaping it.
 */
export const MAX_GUARD_TIMEOUT_MS = 600_000;

/**
 * Same shape as ValidationResult, but for the handful of validators (small
 * `optPositiveOrNull`-style helpers) whose call sites always report one
 * generic message covering every failure mode for that field, so the
 * `ok: false` branch never needed to carry its own per-call message.
 */
export type LooseValidationResult<T> = { ok: true; value: T } | { ok: false };

/**
 * "An optional number, or null to clear it" — the shape four route files each
 * wrote their own near-identical validator for (`optPositiveIntOrNull` in
 * consumers, `optPositiveOrNull` + `optTimeoutOrNull` in policies, `optNumber`
 * in alerts).
 *
 * They looked like copies but were not: one required an integer, one any
 * positive finite number, one allowed zero and negatives, one added a ceiling.
 * Collapsing them into a single body with those differences as OPTIONS is the
 * point — four bodies that differ in ways you have to read carefully to spot
 * are how a rule gets applied to the wrong field.
 *
 * `undefined` and `null` both mean "clear it" (`value: null`); anything else
 * that fails a constraint is a rejection, so a caller can tell "not supplied"
 * from "supplied nonsense".
 */
export function optNumberOrNull(
  v: unknown,
  opts: { integer?: boolean; min?: number; max?: number } = {},
): LooseValidationResult<number | null> {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== "number" || !Number.isFinite(v)) return { ok: false };
  if (opts.integer && !Number.isInteger(v)) return { ok: false };
  if (opts.min !== undefined && v < opts.min) return { ok: false };
  if (opts.max !== undefined && v > opts.max) return { ok: false };
  return { ok: true, value: v };
}

/** `{ client, tool }` pair as accepted in a bundle's or a guard policy's `tools[]`. */
export interface ToolRefInput {
  client: string;
  tool: string;
}

/**
 * Validates a `tools[]` array of `{client, tool}` pairs.
 *
 * bundles.ts and policies.ts had the identical element check written out twice,
 * differing only in whether a length cap applied and whether the failure
 * carried a message. Existence of each referenced tool is NOT checked here —
 * that stays downstream where the registry is in scope, unchanged.
 */
export function parseToolRefs(input: unknown, opts: { max?: number } = {}): ValidationResult<ToolRefInput[]> {
  if (!Array.isArray(input)) return { ok: false, message: "tools must be an array" };
  if (opts.max !== undefined && input.length > opts.max) {
    return { ok: false, message: `tools exceeds maximum of ${opts.max}` };
  }
  const value: ToolRefInput[] = [];
  for (const item of input) {
    const entry = item as Record<string, unknown>;
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.client !== "string" ||
      typeof entry.tool !== "string" ||
      !entry.client ||
      !entry.tool
    ) {
      return { ok: false, message: "each tools[] entry must be {client: string, tool: string}" };
    }
    value.push({ client: entry.client, tool: entry.tool });
  }
  return { ok: true, value };
}

/**
 * Maps a validation/mutation error's `code` to an HTTP status via a
 * caller-supplied lookup table. Replaces the repeated
 * `function statusForXError(code) { switch (code) { case ...: return 4xx; } }`
 * blocks that used to be hand-written per route file (one per admin entity:
 * bundles, install links, catalog, composites, ws-proxy targets, OAuth...).
 * `statusMap` is typed `Record<Code, number>`, so — same as the switch
 * statements it replaces — TypeScript still fails to compile if a new `Code`
 * member is ever added without an accompanying status.
 */
export function mutationErrorToStatus<Code extends string>(code: Code, statusMap: Record<Code, number>): number {
  return statusMap[code];
}
