import { config } from "./config.js";

type LogLevel = "info" | "warn" | "error";

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
  if (config.logFormat === "json") {
    const entry = { timestamp: new Date().toISOString(), level, message, ...safeMeta };
    console[level === "error" ? "error" : "log"](JSON.stringify(entry));
  } else {
    const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}]`;
    const metaStr = safeMeta ? " " + JSON.stringify(safeMeta) : "";
    console[level === "error" ? "error" : "log"](`${prefix} ${message}${metaStr}`);
  }
}
