import { sha256Hex } from "../lib/crypto.js";
import { safeCompare } from "./compare.js";

/**
 * SHA-256 hex digest of an API key. Used to persist `tool_guards.allowed_key_hashes`
 * without ever writing a raw `mcpApiKeys` secret to disk.
 */
export function hashApiKey(key: string): string {
  return sha256Hex(key);
}

/**
 * Returns true when `token`'s hash constant-time-matches one of `allowedHashes`.
 * Returns false (fail closed) when `token` is undefined/empty or `allowedHashes`
 * is empty — callers should only invoke this when a restriction is actually
 * configured, since an empty allow-list means "no restriction" at the call site,
 * not "allow nothing".
 */
export function isKeyAllowed(token: string | undefined, allowedHashes: string[] | undefined): boolean {
  if (!token || !allowedHashes || allowedHashes.length === 0) return false;
  const candidate = hashApiKey(token);
  return allowedHashes.some((h) => safeCompare(h, candidate));
}
