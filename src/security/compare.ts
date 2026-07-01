import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison via hash-then-timingSafeEqual, so that
 * neither operand's raw length nor content is observable via timing.
 * Used for every secret comparison in this codebase (API keys, session
 * tokens, CSRF tokens, guard-restricted API key hashes) — never compare
 * secrets with `===`.
 */
export function safeCompare(a: string, b: string): boolean {
  try {
    const ha = createHash("sha256").update(a, "utf8").digest();
    const hb = createHash("sha256").update(b, "utf8").digest();
    return timingSafeEqual(ha, hb);
  } catch {
    return false;
  }
}
