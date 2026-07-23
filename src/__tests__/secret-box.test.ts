import { describe, test, expect, afterEach } from "bun:test";
import { config } from "../config.js";
import { encryptSecret, decryptSecret, isSecretBoxConfigured } from "../security/secret-box.js";

const originalKey = config.secretEncryptionKey;

function setKey(k: string | undefined): void {
  (config as Record<string, unknown>).secretEncryptionKey = k;
}

afterEach(() => {
  (config as Record<string, unknown>).secretEncryptionKey = originalKey;
});

describe("secret-box", () => {
  test("not configured => isSecretBoxConfigured is false and encrypt throws", () => {
    setKey(undefined);
    expect(isSecretBoxConfigured()).toBe(false);
    expect(() => encryptSecret("x")).toThrow();
  });

  test("roundtrip with a base64 32-byte key", () => {
    setKey(Buffer.alloc(32, 7).toString("base64"));
    const blob = encryptSecret("hello world");
    expect(blob.startsWith("v2.")).toBe(true);
    expect(decryptSecret(blob)).toBe("hello world");
  });

  test("roundtrip with a passphrase (scrypt derived)", () => {
    setKey("some-passphrase");
    const blob = encryptSecret("s3cr3t");
    expect(decryptSecret(blob)).toBe("s3cr3t");
  });

  test("tampering with the ciphertext fails the auth tag", () => {
    setKey("k");
    const blob = encryptSecret("data");
    const parts = blob.split(".");
    const badCt = Buffer.from(parts[3], "base64");
    badCt[0] ^= 0xff;
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]}.${badCt.toString("base64")}`;
    expect(() => decryptSecret(tampered)).toThrow();
  });

  test("decrypting with a different key fails", () => {
    setKey("key-a");
    const blob = encryptSecret("data");
    setKey("key-b");
    expect(() => decryptSecret(blob)).toThrow();
  });
});
