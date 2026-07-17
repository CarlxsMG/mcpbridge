/**
 * Maps a string transform over every string leaf of a JSON-ish value, returning
 * a NEW value of the same shape (never mutating the input). Arrays and plain
 * objects are rebuilt; every non-string primitive (number/boolean/null) is
 * returned unchanged.
 *
 * Used to run string-level response sanitizers — injected-credential stripping
 * and the guardrail prompt-injection scan — over an MCP upstream's
 * `structuredContent`, an arbitrarily-nested object whose string leaves are
 * exactly as untrusted as a text content part and which would otherwise reach
 * the caller completely unscanned.
 *
 * Prototype-pollution safe: object properties are re-attached with
 * `Object.defineProperty`, so a `__proto__` / `constructor` OWN key coming off
 * an untrusted upstream (JSON.parse yields `__proto__` as an own data property)
 * is copied as a plain own data property rather than being routed through the
 * `__proto__` setter that a bracket assignment would trigger.
 */
export function mapStringLeaves(value: unknown, fn: (s: string) => string, skipKeys?: ReadonlySet<string>): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStringLeaves(v, fn, skipKeys));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      // A skipped key (e.g. a content block's discriminator `type`, or base64
      // `data`/`blob`) is copied verbatim — never transformed, never recursed.
      Object.defineProperty(out, key, {
        value: skipKeys?.has(key) ? v : mapStringLeaves(v, fn, skipKeys),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}
