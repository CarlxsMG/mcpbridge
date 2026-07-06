/**
 * The `getSecretsProvider()` factory (src/secrets/index.ts) — selection by
 * `config.secretsProvider` ('local' default | 'vault'), plus a regression
 * check that the default local provider still produces exactly the same
 * blob format as calling src/security/secret-box.ts directly (i.e. routing
 * through the abstraction changes nothing about the default behavior).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { config } from "../config.js";
import { getSecretsProvider } from "../secrets/index.js";
import { localProvider } from "../secrets/local-provider.js";
import { vaultProvider } from "../secrets/vault-provider.js";

import { withConfig } from "./_utils/with-config.js";
const orig = {
  secretsProvider: config.secretsProvider,
  secretEncryptionKey: config.secretEncryptionKey,
};

afterEach(() => {
  const c = config as Record<string, unknown>;
  c.secretsProvider = orig.secretsProvider;
  c.secretEncryptionKey = orig.secretEncryptionKey;
});

describe("getSecretsProvider — selection", () => {
  test("'local' (default) selects the local provider", async () => {
    await withConfig({ secretsProvider: "local" }, async () => {
      const provider = getSecretsProvider();
      expect(provider).toBe(localProvider);
      expect(provider.name).toBe("local");
    });
  });

  test("'vault' selects the vault provider", async () => {
    await withConfig({ secretsProvider: "vault" }, async () => {
      const provider = getSecretsProvider();
      expect(provider).toBe(vaultProvider);
      expect(provider.name).toBe("vault");
    });
  });

  test("switches when config.secretsProvider changes (no stale singleton cached)", () => {
    (config as Record<string, unknown>).secretsProvider = "local";
    expect(getSecretsProvider().name).toBe("local");
    (config as Record<string, unknown>).secretsProvider = "vault";
    expect(getSecretsProvider().name).toBe("vault");
    (config as Record<string, unknown>).secretsProvider = "local";
    expect(getSecretsProvider().name).toBe("local");
  });
});

describe("getSecretsProvider — default-local regression", () => {
  test("the local provider's blob format is unchanged from calling secret-box directly (v1.<iv>.<tag>.<ct>)", async () => {
    const c = config as Record<string, unknown>;
    c.secretsProvider = "local";
    c.secretEncryptionKey = Buffer.alloc(32, 3).toString("base64");

    const provider = getSecretsProvider();
    const blob = await provider.encryptSecret("a very secret value");
    expect(blob.startsWith("v1.")).toBe(true);
    expect(blob.split(".").length).toBe(4);
    expect(await provider.decryptSecret(blob)).toBe("a very secret value");
  });

  test("isConfigured() reflects SECRET_ENCRYPTION_KEY presence, same as isSecretBoxConfigured()", () => {
    const c = config as Record<string, unknown>;
    c.secretsProvider = "local";
    c.secretEncryptionKey = undefined;
    expect(getSecretsProvider().isConfigured()).toBe(false);
    c.secretEncryptionKey = "some-passphrase";
    expect(getSecretsProvider().isConfigured()).toBe(true);
  });
});
