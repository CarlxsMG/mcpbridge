/**
 * Mutation-testing gap-fill for src/secrets/index.ts, on top of the existing
 * hand-written secrets-index.test.ts (which already covers the
 * 'local'/'vault' selection ternary with both literal values, a switching
 * check, and a local-provider blob-format regression). This file targets
 * what that one doesn't touch:
 *
 *  - The `VaultProviderError` re-export — never imported or exercised by the
 *    existing test, so a mutant that broke the re-export (or a refactor that
 *    silently forked a second, non-identical class) would go unnoticed.
 *  - The documented fallback-to-local behavior for any `secretsProvider`
 *    value that isn't the literal string `"vault"` — the existing test only
 *    ever sets the exact literals `"local"` or `"vault"`, so the ternary's
 *    `=== "vault"` comparison (as opposed to, say, a truthy/falsy check) was
 *    never exercised with a THIRD, non-"local" non-"vault" value, nor with
 *    `undefined` (the real-world unset case `config.ts`'s own default
 *    resolves to `"local"` for, per the JSDoc on getSecretsProvider()).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { config } from "../../config.js";
import { getSecretsProvider, VaultProviderError } from "../../secrets/index.js";
import { localProvider } from "../../secrets/local-provider.js";
import { vaultProvider, VaultProviderError as VaultProviderErrorDirect } from "../../secrets/vault-provider.js";

const orig = {
  secretsProvider: config.secretsProvider,
  vaultAddr: config.vaultAddr,
  vaultToken: config.vaultToken,
};

afterEach(() => {
  const c = config as Record<string, unknown>;
  c.secretsProvider = orig.secretsProvider;
  c.vaultAddr = orig.vaultAddr;
  c.vaultToken = orig.vaultToken;
});

describe("secrets/index.ts — VaultProviderError re-export", () => {
  test("index.ts re-exports the exact same class object as vault-provider.ts (not a lookalike copy)", () => {
    expect(VaultProviderError).toBe(VaultProviderErrorDirect);
  });

  test("the re-exported class is what a real vaultProvider failure actually throws", async () => {
    const c = config as Record<string, unknown>;
    c.secretsProvider = "vault";
    c.vaultAddr = undefined;
    c.vaultToken = undefined;

    const provider = getSecretsProvider();
    expect(provider).toBe(vaultProvider);

    // vaultConfig() throws VaultProviderError synchronously (wrapped in the
    // async fn's rejection) when VAULT_ADDR/VAULT_TOKEN are unset.
    await expect(provider.encryptSecret("some plaintext")).rejects.toBeInstanceOf(VaultProviderError);
  });
});

describe("getSecretsProvider — fallback-to-local for anything other than the literal 'vault'", () => {
  test("an arbitrary truthy string that is NOT 'vault' still selects local, proving the check is === 'vault' and not a generic truthiness/presence check", () => {
    (config as Record<string, unknown>).secretsProvider = "bogus-provider-name";
    expect(getSecretsProvider()).toBe(localProvider);
    expect(getSecretsProvider().name).toBe("local");
  });

  test("undefined secretsProvider selects local (the documented real-world default)", () => {
    (config as Record<string, unknown>).secretsProvider = undefined;
    expect(getSecretsProvider()).toBe(localProvider);
  });

  test("empty-string secretsProvider selects local", () => {
    (config as Record<string, unknown>).secretsProvider = "";
    expect(getSecretsProvider()).toBe(localProvider);
  });
});
