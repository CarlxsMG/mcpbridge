import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { config } from "../config.js";
import { sha256Hex } from "../lib/crypto.js";

/**
 * Authenticated symmetric encryption for secrets at rest (AES-256-GCM).
 *
 * The key comes from `config.secretEncryptionKey` (env `SECRET_ENCRYPTION_KEY`).
 * A base64-encoded 32-byte value is used directly — that is the recommended
 * form, and it skips key derivation entirely. Anything else is treated as an
 * operator-chosen *passphrase* and stretched to 32 bytes (see `deriveFromPassphrase`).
 * When no key is configured, encryption/decryption throw — callers must check
 * `isSecretBoxConfigured()` first and surface a clear error.
 *
 * Blob format: `v2.<iv-b64>.<tag-b64>.<ciphertext-b64>`, and the byte-identical
 * `v1.…` for blobs written before the KDF change (see below).
 */

/**
 * Fixed application salt for the passphrase KDF.
 *
 * v1 stretched a passphrase with a single unsalted SHA-256 pass. SHA-256 is
 * built to be *fast*, which is exactly wrong here: anyone who obtained the
 * database could brute-force a human-chosen passphrase against the stored
 * ciphertext at billions of guesses per second. scrypt's memory-hardness raises
 * the per-guess cost by orders of magnitude.
 *
 * The salt is a compile-time constant rather than a per-blob random value on
 * purpose. `decryptSecret` runs on the proxy dispatch hot path (every tool call
 * for a client with upstream auth, via getUpstreamAuthHeaders), so the derived
 * key has to be memoisable — a per-blob salt would force a fresh ~100 ms scrypt
 * on every proxied request. The tradeoff is that the salt no longer separates
 * *this* deployment from other mcpbridge deployments, only from other
 * applications; scrypt's cost is what defends the passphrase, and an operator
 * who supplies a proper base64 32-byte key never touches this path at all.
 */
const KDF_SALT = "mcp-rest-bridge/secret-box/v2";

/** scrypt cost parameters: ~64 MiB and ~100 ms per derivation, paid once per process. */
const KDF_N = 1 << 16;
const KDF_BLOCK_SIZE = 8;
const KDF_PARALLELISM = 1;
const KDF_MAXMEM = 128 * KDF_BLOCK_SIZE * KDF_N * 2;

/**
 * Memoised passphrase derivations, keyed by the raw passphrase.
 *
 * Keyed by the passphrase itself rather than being a single cached value
 * because `config.secretEncryptionKey` is mutable and tests swap it between
 * cases (`withConfig()`); a plain one-shot cache would hand back the previous
 * deployment's key after a swap. In production this holds exactly one entry.
 */
const derivedKeys = new Map<string, Buffer>();

function deriveFromPassphrase(raw: string): Buffer {
  const cached = derivedKeys.get(raw);
  if (cached) return cached;
  const key = scryptSync(raw, KDF_SALT, 32, {
    N: KDF_N,
    r: KDF_BLOCK_SIZE,
    p: KDF_PARALLELISM,
    maxmem: KDF_MAXMEM,
  });
  derivedKeys.set(raw, key);
  return key;
}

/**
 * The key for a given blob version. A base64 32-byte `SECRET_ENCRYPTION_KEY` is
 * used as-is for both versions — it needs no stretching, so the KDF change
 * doesn't affect it and its v1 blobs keep decrypting unchanged. Only the
 * passphrase branch differs: v1 = one SHA-256 pass, v2 = scrypt.
 */
function getKey(version: "v1" | "v2" = "v2"): Buffer | null {
  const raw = config.secretEncryptionKey;
  if (!raw) return null;
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length === 32) return decoded;
  return version === "v2" ? deriveFromPassphrase(raw) : Buffer.from(sha256Hex(raw), "hex");
}

/**
 * Deliberately checks the raw config value rather than calling `getKey()`:
 * this is a cheap "is the feature on?" probe used by route handlers, and
 * routing it through getKey() would trigger the scrypt derivation just to
 * answer a question that only depends on whether the env var is set.
 */
export function isSecretBoxConfigured(): boolean {
  return Boolean(config.secretEncryptionKey);
}

/** Raw AES-256-GCM encrypt used directly by backend-auth/upstream-auth.ts — distinct from the differently-implemented, pluggable `encryptSecret` exposed via getSecretsProvider() (src/secrets/index.ts), despite the identical name. */
export function encryptSecret(plaintext: string): string {
  const key = getKey();
  if (!key) throw new Error("SECRET_ENCRYPTION_KEY is not configured");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v2.${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}

/**
 * Raw AES-256-GCM decrypt used directly by backend-auth/upstream-auth.ts — distinct from the differently-implemented, pluggable `decryptSecret` exposed via getSecretsProvider() (src/secrets/index.ts), despite the identical name.
 *
 * Reads both blob versions. `v1` is still accepted so an existing deployment's
 * secrets at rest keep working across the KDF change without a re-encryption
 * migration; anything written from here on is `v2`, so a v1 blob upgrades the
 * next time its secret is rewritten.
 */
export function decryptSecret(blob: string): string {
  const parts = blob.split(".");
  const version = parts[0];
  if (parts.length !== 4 || (version !== "v1" && version !== "v2")) throw new Error("Malformed secret blob");
  const key = getKey(version);
  if (!key) throw new Error("SECRET_ENCRYPTION_KEY is not configured");
  const iv = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const ct = Buffer.from(parts[3], "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
