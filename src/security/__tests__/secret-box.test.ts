import { describe, expect, test } from "bun:test";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";

import { decryptSecret, encryptSecret, isSecretBoxConfigured } from "../secret-box.js";
import { sha256Hex } from "../../lib/crypto.js";
import { withConfig } from "../../__tests__/_utils/with-config.js";

// ---------------------------------------------------------------------------
// secret-box — direct unit tests (Stryker mutation backstop for
// src/security/secret-box.ts, AES-256-GCM secrets-at-rest). At the P2-3
// baseline 11 mutants survived on only indirect (upstream-auth) coverage.
// Each test below names the mutant(s) it kills.
//
// NOTE — the `cipher.update(pt, "utf8")` → `""` StringLiteral is an EQUIVALENT
// mutant, left unkilled on purpose: Bun's `cipher.update(str, "")` produces
// byte-identical output to `cipher.update(str, "utf8")` (the empty string falls
// back to the utf8 default), so no input can distinguish them. Proven
// empirically.
// ---------------------------------------------------------------------------

// A valid base64-encoded 32-byte key. getKey() must use these bytes verbatim
// (the `decoded.length === 32` fast path), NOT stretch them as a passphrase.
const KEY_BYTES = Buffer.alloc(32, 0xab);
const KEY_B64 = KEY_BYTES.toString("base64");

// Anything that isn't 32 base64 bytes is treated as an operator passphrase.
const PASSPHRASE = "correct horse battery staple";

/** The v1 (legacy, unsalted single-SHA-256) derivation, reproduced here. */
const legacyKey = (raw: string): Buffer => Buffer.from(sha256Hex(raw), "hex");

/** The v2 (scrypt) derivation — must match secret-box's KDF_* constants exactly. */
const scryptKey = (raw: string): Buffer =>
  scryptSync(raw, "mcp-rest-bridge/secret-box/v2", 32, { N: 1 << 16, r: 8, p: 1, maxmem: 128 * 8 * (1 << 16) * 2 });

/** Seals `pt` under `key` and tags the blob `version` — i.e. what an older build would have written. */
function seal(version: string, key: Buffer, pt: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(pt, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${version}.${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}

describe("secret-box — roundtrip", () => {
  // Kills the `"v2"` StringLiteral in encryptSecret's template (→ ""): the
  // version check would reject a freshly-sealed blob, so a successful roundtrip
  // proves the tag is "v2".
  test("encrypt→decrypt returns the original plaintext, including unicode (kills the 'v2' StringLiteral)", () => {
    withConfig({ secretEncryptionKey: KEY_B64 }, () => {
      const pt = "héllo-🔑-cañón";
      const blob = encryptSecret(pt);
      expect(blob.startsWith("v2.")).toBe(true);
      expect(decryptSecret(blob)).toBe(pt);
    });
  });

  test("isSecretBoxConfigured tracks key presence", () => {
    withConfig({ secretEncryptionKey: KEY_B64 }, () => expect(isSecretBoxConfigured()).toBe(true));
    withConfig({ secretEncryptionKey: "" }, () => expect(isSecretBoxConfigured()).toBe(false));
  });
});

describe("secret-box — a 32-byte base64 key is used verbatim, not stretched", () => {
  // Kills the `if (decoded.length === 32)` ConditionalExpression (→ false): the
  // mutant forces getKey() down the passphrase branch even for a valid 32-byte
  // base64 key. We seal a blob OUTSIDE the module with the raw 32 bytes; only
  // the verbatim-key path authenticates it — the stretched-key mutant derives a
  // different key, fails the GCM auth tag, and throws.
  test("decrypts a v2 blob sealed with the raw 32 bytes (kills the length ConditionalExpression)", () => {
    const blob = seal("v2", KEY_BYTES, "payload");
    withConfig({ secretEncryptionKey: KEY_B64 }, () => {
      expect(decryptSecret(blob)).toBe("payload");
    });
  });

  // A 32-byte base64 key needs no stretching, so the KDF change must not affect
  // it: its pre-existing v1 blobs have to keep decrypting byte-for-byte.
  test("a v1 blob sealed with the raw 32 bytes still decrypts unchanged", () => {
    const blob = seal("v1", KEY_BYTES, "payload");
    withConfig({ secretEncryptionKey: KEY_B64 }, () => {
      expect(decryptSecret(blob)).toBe("payload");
    });
  });
});

describe("secret-box — passphrase keys: scrypt for v2, legacy SHA-256 preserved for v1", () => {
  // The point of the KDF change: a passphrase must be stretched with scrypt, not
  // a single SHA-256 pass. Kills the version→key mutants that would route a v2
  // blob at the legacy derivation.
  test("a fresh blob under a passphrase is v2 and is keyed by scrypt, not sha256", () => {
    withConfig({ secretEncryptionKey: PASSPHRASE }, () => {
      const blob = encryptSecret("secret-value");
      expect(blob.startsWith("v2.")).toBe(true);
      expect(decryptSecret(blob)).toBe("secret-value");
    });
    // Sealed with the scrypt key outside the module → only the scrypt branch
    // authenticates it. If v2 still used sha256Hex, the auth tag would fail.
    const external = seal("v2", scryptKey(PASSPHRASE), "external");
    withConfig({ secretEncryptionKey: PASSPHRASE }, () => {
      expect(decryptSecret(external)).toBe("external");
    });
  });

  // Backwards compatibility: an existing deployment's v1 blobs were sealed under
  // the old sha256 derivation and must keep decrypting across the upgrade — the
  // whole reason decryptSecret still accepts "v1".
  test("a v1 blob under a passphrase still decrypts via the legacy sha256 derivation", () => {
    const blob = seal("v1", legacyKey(PASSPHRASE), "legacy-value");
    withConfig({ secretEncryptionKey: PASSPHRASE }, () => {
      expect(decryptSecret(blob)).toBe("legacy-value");
    });
  });

  // The two derivations must not be interchangeable — proves the version tag
  // actually selects the key rather than both branches collapsing to one.
  test("the v1 and v2 passphrase derivations are distinct keys", () => {
    expect(legacyKey(PASSPHRASE).equals(scryptKey(PASSPHRASE))).toBe(false);
    // A v1-keyed payload mislabelled v2 must fail the GCM auth tag.
    const mislabelled = seal("v2", legacyKey(PASSPHRASE), "x");
    withConfig({ secretEncryptionKey: PASSPHRASE }, () => {
      expect(() => decryptSecret(mislabelled)).toThrow();
    });
  });
});

describe("secret-box — fails closed when no key is configured", () => {
  // Kills the `if (!key) throw` ConditionalExpression (→ false) and the message
  // StringLiteral (→ ""). Asserting the EXACT message is what kills both: the
  // conditional mutant skips the throw and dies later on createCipheriv(null),
  // whose message differs; the string mutant throws an empty message.
  test("encryptSecret throws the exact configured-key error (kills Conditional + StringLiteral)", () => {
    withConfig({ secretEncryptionKey: "" }, () => {
      expect(() => encryptSecret("x")).toThrow("SECRET_ENCRYPTION_KEY is not configured");
    });
  });

  // Kills the same pair on the decrypt path. The blob must be well-formed:
  // decryptSecret now parses the version BEFORE deriving the key (so that an
  // unconfigured box never pays for a scrypt run on a blob it can't read
  // anyway), which means a malformed blob would short-circuit this assertion.
  test("decryptSecret throws the exact configured-key error (kills Conditional + StringLiteral)", () => {
    withConfig({ secretEncryptionKey: "" }, () => {
      expect(() => decryptSecret("v1.a.b.c")).toThrow("SECRET_ENCRYPTION_KEY is not configured");
    });
  });
});

describe("secret-box — rejects malformed blobs", () => {
  // The guard is `if (parts.length !== 4 || (version !== "v1" && version !== "v2")) throw`.
  // A blob that trips exactly ONE sub-condition must still throw "Malformed
  // secret blob"; asserting that message kills the Conditional/Logical mutants:
  //
  //   * "v1.only.three" (3 parts, accepted tag) relies on the length branch alone.
  //   * "v3.a.b.c" (4 parts, unknown tag) relies on the version branch alone.
  test("wrong part count throws Malformed (kills the length conditional and ||→&&)", () => {
    withConfig({ secretEncryptionKey: KEY_B64 }, () => {
      expect(() => decryptSecret("v1.only.three")).toThrow("Malformed secret blob");
    });
  });

  test("an unknown version tag throws Malformed (kills the version conditionals and &&→||)", () => {
    withConfig({ secretEncryptionKey: KEY_B64 }, () => {
      expect(() => decryptSecret("v3.a.b.c")).toThrow("Malformed secret blob");
      // "v0" too — a single accepted-tag comparison flipped to `true` would let
      // one of these through.
      expect(() => decryptSecret("v0.a.b.c")).toThrow("Malformed secret blob");
    });
  });
});
