/**
 * Stryker mutation-testing backstop for src/secrets/local-provider.ts.
 *
 * `localProvider` is a thin, zero-config `SecretsProvider` (see
 * src/secrets/provider.ts) that wraps src/security/secret-box.ts's
 * synchronous encrypt/decrypt/isConfigured functions in `async` shims,
 * changing nothing about their behavior. This file exercises the object
 * directly (no Express harness, no bun:sqlite — pure delegator, no I/O of
 * its own) and cross-checks every result against the real secret-box
 * functions imported independently, so a mutant that breaks the delegation
 * (wrong argument, swapped function, dropped `await`/return) is caught even
 * though the *behavior* superficially still "looks like" encryption/decryption.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { config } from "../../config.js";
import { localProvider } from "../../secrets/local-provider.js";
import {
  encryptSecret as boxEncrypt,
  decryptSecret as boxDecrypt,
  isSecretBoxConfigured,
} from "../../security/secret-box.js";

const orig = { secretEncryptionKey: config.secretEncryptionKey };

afterEach(() => {
  (config as Record<string, unknown>).secretEncryptionKey = orig.secretEncryptionKey;
});

const KEY_A = Buffer.alloc(32, 7).toString("base64");
const KEY_B = Buffer.alloc(32, 9).toString("base64");

describe("localProvider — name", () => {
  test("name is the literal 'local'", () => {
    expect(localProvider.name).toBe("local");
    // Guards against a StringLiteral mutant flipping this to "" or "vault".
    expect(localProvider.name).not.toBe("vault");
    expect(localProvider.name.length).toBeGreaterThan(0);
  });
});

describe("localProvider.isConfigured()", () => {
  test("false when SECRET_ENCRYPTION_KEY is unset — mirrors isSecretBoxConfigured()", () => {
    (config as Record<string, unknown>).secretEncryptionKey = undefined;
    expect(localProvider.isConfigured()).toBe(false);
    expect(localProvider.isConfigured()).toBe(isSecretBoxConfigured());
  });

  test("true when SECRET_ENCRYPTION_KEY is set — mirrors isSecretBoxConfigured()", () => {
    (config as Record<string, unknown>).secretEncryptionKey = KEY_A;
    expect(localProvider.isConfigured()).toBe(true);
    expect(localProvider.isConfigured()).toBe(isSecretBoxConfigured());
  });
});

describe("localProvider.encryptSecret()", () => {
  test("returns a Promise resolving to a v2.<iv>.<tag>.<ct> blob", async () => {
    (config as Record<string, unknown>).secretEncryptionKey = KEY_A;
    const result = localProvider.encryptSecret("hello world");
    expect(result).toBeInstanceOf(Promise);
    const blob = await result;
    expect(typeof blob).toBe("string");
    expect(blob.startsWith("v2.")).toBe(true);
    expect(blob.split(".").length).toBe(4);
  });

  test("delegates the exact plaintext argument through to secret-box (not a fixed/ignored string)", async () => {
    (config as Record<string, unknown>).secretEncryptionKey = KEY_A;
    const blobA = await localProvider.encryptSecret("plaintext-one");
    const blobB = await localProvider.encryptSecret("plaintext-two-different-length");
    // Different plaintexts of different lengths must produce genuinely
    // different ciphertext lengths (catches a mutant that hardcodes the
    // argument or swaps it for something constant).
    expect(blobA).not.toBe(blobB);
    expect(await localProvider.decryptSecret(blobA)).toBe("plaintext-one");
    expect(await localProvider.decryptSecret(blobB)).toBe("plaintext-two-different-length");
  });

  test("round-trips through the real secret-box decrypt (cross-checks the delegation, not just shape)", async () => {
    (config as Record<string, unknown>).secretEncryptionKey = KEY_B;
    const blob = await localProvider.encryptSecret("cross-check value");
    expect(boxDecrypt(blob)).toBe("cross-check value");
  });

  test("throws (rejects) when no key is configured — same as calling secret-box directly", async () => {
    (config as Record<string, unknown>).secretEncryptionKey = undefined;
    await expect(localProvider.encryptSecret("x")).rejects.toThrow("SECRET_ENCRYPTION_KEY is not configured");
  });
});

describe("localProvider.decryptSecret()", () => {
  test("returns a Promise resolving to the original plaintext for a blob produced by secret-box directly", async () => {
    (config as Record<string, unknown>).secretEncryptionKey = KEY_A;
    const blob = boxEncrypt("produced-by-secret-box-directly");
    const result = localProvider.decryptSecret(blob);
    expect(result).toBeInstanceOf(Promise);
    expect(await result).toBe("produced-by-secret-box-directly");
  });

  test("delegates the exact blob argument through (two distinct blobs decrypt to two distinct plaintexts)", async () => {
    (config as Record<string, unknown>).secretEncryptionKey = KEY_A;
    const blobA = boxEncrypt("first-secret");
    const blobB = boxEncrypt("second-secret-value");
    expect(await localProvider.decryptSecret(blobA)).toBe("first-secret");
    expect(await localProvider.decryptSecret(blobB)).toBe("second-secret-value");
  });

  test("throws (rejects) on a malformed blob — same error as secret-box directly", async () => {
    (config as Record<string, unknown>).secretEncryptionKey = KEY_A;
    await expect(localProvider.decryptSecret("not-a-real-blob")).rejects.toThrow("Malformed secret blob");
  });

  test("throws (rejects) when no key is configured — same as calling secret-box directly", async () => {
    (config as Record<string, unknown>).secretEncryptionKey = KEY_A;
    const blob = boxEncrypt("value");
    (config as Record<string, unknown>).secretEncryptionKey = undefined;
    await expect(localProvider.decryptSecret(blob)).rejects.toThrow("SECRET_ENCRYPTION_KEY is not configured");
  });
});
