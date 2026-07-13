/**
 * Extracts a human-readable string from an unknown thrown value.
 *
 * `catch (err)` binds `err` as `unknown`, so the same narrowing idiom —
 * `err instanceof Error ? err.message : String(err)` — was repeated at ~40
 * call sites (log context, error-response bodies, best-effort webhook failure
 * notes). This is that idiom, once: a real `Error`'s `.message`, otherwise the
 * `String()` coercion of whatever non-Error value was thrown (a string, a
 * number, a plain object, `undefined`, …).
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
