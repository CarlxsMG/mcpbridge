import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "../config.js";

/**
 * Authenticated symmetric encryption for secrets at rest (AES-256-GCM).
 *
 * The key comes from `config.secretEncryptionKey` (env `SECRET_ENCRYPTION_KEY`).
 * A base64-encoded 32-byte value is used directly; anything else is hashed to
 * 32 bytes via SHA-256 so operators can supply a passphrase. When no key is
 * configured, encryption/decryption throw — callers must check
 * `isSecretBoxConfigured()` first and surface a clear error.
 *
 * Blob format: `v1.<iv-b64>.<tag-b64>.<ciphertext-b64>`.
 */

function getKey(): Buffer | null {
  const raw = config.secretEncryptionKey;
  if (!raw) return null;
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length === 32) return decoded;
  return createHash("sha256").update(raw, "utf8").digest();
}

export function isSecretBoxConfigured(): boolean {
  return getKey() !== null;
}

export function encryptSecret(plaintext: string): string {
  const key = getKey();
  if (!key) throw new Error("SECRET_ENCRYPTION_KEY is not configured");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}

export function decryptSecret(blob: string): string {
  const key = getKey();
  if (!key) throw new Error("SECRET_ENCRYPTION_KEY is not configured");
  const parts = blob.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("Malformed secret blob");
  const iv = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const ct = Buffer.from(parts[3], "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
