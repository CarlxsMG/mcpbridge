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
 * Same shape as ValidationResult, but for the handful of validators (small
 * `optPositiveOrNull`-style helpers) whose call sites always report one
 * generic message covering every failure mode for that field, so the
 * `ok: false` branch never needed to carry its own per-call message.
 */
export type LooseValidationResult<T> = { ok: true; value: T } | { ok: false };

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
