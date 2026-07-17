import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "./config.js";

type LogLevel = "info" | "warn" | "error";

// Per-request correlation id. `requestIdMiddleware` seeds it via
// `runWithRequestId`, and `log()` (below) auto-attaches it to every line
// emitted inside that request's async tree — so dispatch/proxy/guard logs all
// carry the same id already echoed in the `X-Request-ID` response header,
// without threading it through every call site. Kept here, next to its only
// reader, rather than in the middleware: independent of tracing (populated
// whether or not OTLP export is enabled or a `traceparent` was supplied).
const requestIdStorage = new AsyncLocalStorage<string>();

/**
 * Runs `fn` (and everything it awaits) with `requestId` bound as the ambient
 * correlation id, so any `log()` call inside it is auto-tagged with
 * `request_id`. Used by `requestIdMiddleware`; safe to nest (an inner run
 * shadows the outer for its own subtree).
 */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return requestIdStorage.run(requestId, fn);
}

// Defense-in-depth secret redaction: if a log meta key *names* a credential, its
// value is replaced with "<redacted>" before it ever reaches stdout / the SIEM,
// so a stray `log("info", msg, { token })` can't leak. SAFE_SUFFIX_RE keeps
// non-secret fields that merely contain a secret-ish word — e.g. `apiKeyId`,
// `secretName`, `tokenCount`, `keyHash` are IDs / labels / counts / already-hashed.
const SECRET_KEY_WORDS = [
  "password",
  "passwd",
  "secret",
  "token",
  "authorization",
  "credential",
  "privatekey",
  "apikey",
  "api_key",
  "cookie",
  "bearer",
  "csrf",
];
// Deliberately NOT a bare "key": it would redact non-secret diagnostic fields
// (lbKey, cacheKey, responseCacheKey, scopeKey…) that don't end in a safe
// suffix. "apikey"/"api_key" already cover the credential case.
const SAFE_SUFFIX_WORDS = [
  "id",
  "ids",
  "count",
  "name",
  "label",
  "length",
  "type",
  "hash",
  "kind",
  "at",
  "ms",
  "url",
  "enabled",
  "expiry",
  "expires",
  "provider",
];
const SECRET_KEY_RE = new RegExp(`(${SECRET_KEY_WORDS.join("|")})`, "i");
const SAFE_SUFFIX_RE = new RegExp(`(${SAFE_SUFFIX_WORDS.join("|")})$`, "i");

// Recurses into nested objects/arrays so a secret buried under a non-secret key
// (e.g. { response: { headers: { authorization } } }) is redacted too, not just
// top-level keys. A secret-named key's value is redacted whole (not descended
// into); any other value is descended.
function redactValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redactValue);
  if (v != null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] =
        val != null && val !== "" && SECRET_KEY_RE.test(k) && !SAFE_SUFFIX_RE.test(k) ? "<redacted>" : redactValue(val);
    }
    return out;
  }
  return v;
}

function redactMeta(meta: Record<string, unknown>): Record<string, unknown> {
  return redactValue(meta) as Record<string, unknown>;
}

export function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const safeMeta = meta ? redactMeta(meta) : undefined;
  // Auto-attach the active request's correlation id (seeded by
  // requestIdMiddleware). An explicit `request_id` in `meta` still wins — it's
  // spread last — so call sites that already pass one (e.g. the global error
  // handler) are unchanged. Outside any request, nothing is added.
  const requestId = requestIdStorage.getStore();
  const enriched = requestId !== undefined ? { request_id: requestId, ...safeMeta } : safeMeta;
  if (config.logFormat === "json") {
    const entry = { timestamp: new Date().toISOString(), level, message, ...enriched };
    console[level === "error" ? "error" : "log"](JSON.stringify(entry));
  } else {
    const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}]`;
    const metaStr = enriched ? " " + JSON.stringify(enriched) : "";
    console[level === "error" ? "error" : "log"](`${prefix} ${message}${metaStr}`);
  }
}
