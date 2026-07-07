import { describe, expect, test } from "bun:test";
import { createCipheriv, randomBytes } from "node:crypto";

import { decryptSecret, encryptSecret, isSecretBoxConfigured } from "../secret-box.js";
import { withConfig } from "../../__tests__/_utils/with-config.js";

// ---------------------------------------------------------------------------
// secret-box — direct unit tests (Stryker mutation backstop for
// src/security/secret-box.ts, AES-256-GCM secrets-at-rest). At the P2-3
// baseline 11 mutants survived on only indirect (upstream-auth) coverage.
// Each test below names the mutant(s) it kills by line + replacement.
//
// NOTE — the L35 `"utf8"` → `""` StringLiteral is an EQUIVALENT mutant, left
// unkilled on purpose: Bun's `cipher.update(str, "")` produces byte-identical
// output to `cipher.update(str, "utf8")` (the empty string falls back to the
// utf8 default), so no input can distinguish them. Proven empirically. This is
// why P2-3 lands at 98.21% (110/112) and not 100%.
// ---------------------------------------------------------------------------

// A valid base64-encoded 32-byte key. getKey() must use these bytes verbatim
// (the `decoded.length === 32` fast path), NOT hash them as a passphrase.
const KEY_BYTES = Buffer.alloc(32, 0xab);
const KEY_B64 = KEY_BYTES.toString("base64");

describe("secret-box — roundtrip", () => {
  // Kills L45 StringLiteral (`"v1"` → `""`): the version check would reject a
  // freshly-sealed `v1.` blob, so a successful roundtrip proves the tag is "v1".
  // (The L35 `"utf8"` → `""` mutant is NOT killed here — it is equivalent in
  // Bun; see the header note.)
  test("encrypt→decrypt returns the original plaintext, including unicode (kills L45 'v1' StringLiteral)", () => {
    withConfig({ secretEncryptionKey: KEY_B64 }, () => {
      const pt = "héllo-🔑-cañón";
      const blob = encryptSecret(pt);
      expect(blob.startsWith("v1.")).toBe(true);
      expect(decryptSecret(blob)).toBe(pt);
    });
  });

  test("isSecretBoxConfigured tracks key presence", () => {
    withConfig({ secretEncryptionKey: KEY_B64 }, () => expect(isSecretBoxConfigured()).toBe(true));
    withConfig({ secretEncryptionKey: "" }, () => expect(isSecretBoxConfigured()).toBe(false));
  });
});

describe("secret-box — a 32-byte base64 key is used verbatim, not hashed", () => {
  // Kills L21 ConditionalExpression (`if (decoded.length === 32)` → `if (false)`):
  // the mutant forces getKey() down the sha256(raw) passphrase branch even for a
  // valid 32-byte base64 key. We seal a blob OUTSIDE the module with the raw 32
  // bytes; only the verbatim-key path authenticates it — the hashed-key mutant
  // derives a different key, fails the GCM auth tag, and throws.
  test("decrypts a blob sealed with the raw 32 bytes (kills L21 ConditionalExpression)", () => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", KEY_BYTES, iv);
    const enc = Buffer.concat([cipher.update("payload", "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const blob = `v1.${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
    withConfig({ secretEncryptionKey: KEY_B64 }, () => {
      expect(decryptSecret(blob)).toBe("payload");
    });
  });
});

describe("secret-box — fails closed when no key is configured", () => {
  // Kills L32 ConditionalExpression (`if (!key) throw` → `if (false)`) and L32
  // StringLiteral (message → ""). Asserting the EXACT message is what kills both:
  // the conditional mutant skips the throw and dies later on createCipheriv(null),
  // whose message differs; the string mutant throws an empty message.
  test("encryptSecret throws the exact configured-key error (kills L32 Conditional + StringLiteral)", () => {
    withConfig({ secretEncryptionKey: "" }, () => {
      expect(() => encryptSecret("x")).toThrow("SECRET_ENCRYPTION_KEY is not configured");
    });
  });

  // Kills the same pair on L43 for the decrypt path.
  test("decryptSecret throws the exact configured-key error (kills L43 Conditional + StringLiteral)", () => {
    withConfig({ secretEncryptionKey: "" }, () => {
      expect(() => decryptSecret("v1.a.b.c")).toThrow("SECRET_ENCRYPTION_KEY is not configured");
    });
  });
});

describe("secret-box — rejects malformed blobs", () => {
  // The L45 guard is `if (parts.length !== 4 || parts[0] !== "v1") throw`. Stryker
  // left 3 ConditionalExpression variants (whole/left/right → false) plus the
  // LogicalOperator (`||` → `&&`). A blob that trips exactly ONE sub-condition
  // must still throw "Malformed secret blob"; asserting that message kills them:
  //
  //   * "v1.only.three" (3 parts, right tag "v1") kills whole→false, the length
  //     check→false, and ||→&& — all rely on the length branch firing alone.
  //   * "v2.a.b.c" (4 parts, wrong tag) kills the parts[0] check→false — only the
  //     version branch fires there.
  test("wrong part count throws Malformed (kills L45 whole + length conditionals and ||→&&)", () => {
    withConfig({ secretEncryptionKey: KEY_B64 }, () => {
      expect(() => decryptSecret("v1.only.three")).toThrow("Malformed secret blob");
    });
  });

  test("wrong version tag throws Malformed (kills L45 parts[0] conditional)", () => {
    withConfig({ secretEncryptionKey: KEY_B64 }, () => {
      expect(() => decryptSecret("v2.a.b.c")).toThrow("Malformed secret blob");
    });
  });
});
