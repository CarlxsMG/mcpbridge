import { timingSafeEqual } from "node:crypto";
import { sha256Hex } from "../lib/crypto.js";

/**
 * Constant-time string comparison via hash-then-timingSafeEqual, so that
 * neither operand's raw length nor content is observable via timing.
 * Used for every secret comparison in this codebase (API keys, session
 * tokens, CSRF tokens, guard-restricted API key hashes) — never compare
 * secrets with `===`.
 */
export function safeCompare(a: string, b: string): boolean {
  try {
    const ha = Buffer.from(sha256Hex(a), "hex");
    const hb = Buffer.from(sha256Hex(b), "hex");
    return timingSafeEqual(ha, hb);
  } catch {
    return false;
  }
}
