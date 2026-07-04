import { createHash } from "node:crypto";

/**
 * Shared, dependency-free crypto primitive: hex-encoded SHA-256 digest of a
 * UTF-8 string.
 *
 * Extracted from what used to be five byte-identical inline implementations
 * (`src/security/compare.ts`, `key-hash.ts`, `secret-box.ts`, `session-store.ts`,
 * `oidc.ts`, `src/approvals.ts`, `src/admin/audit.ts`) — every one of them hashed
 * with the same algorithm/encoding, so this is the single place that does it.
 * Callers needing raw bytes (e.g. for `timingSafeEqual`) should
 * `Buffer.from(sha256Hex(x), "hex")` rather than reimplementing the digest.
 */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
