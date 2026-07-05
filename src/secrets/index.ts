import { config } from "../config.js";
import { localProvider } from "./local-provider.js";
import { vaultProvider } from "./vault-provider.js";
import type { SecretsProvider } from "./provider.js";

export type { SecretsProvider } from "./provider.js";
export { VaultProviderError } from "./vault-provider.js";

/**
 * Returns the active `SecretsProvider`, selected by the `SECRETS_PROVIDER` env
 * var ('local' default | 'vault', parsed once in src/config.ts). This is the
 * ONLY entry point call sites should use — never import local-provider.ts or
 * vault-provider.ts directly.
 *
 * Deliberately re-reads `config.secretsProvider` on every call rather than
 * memoizing a singleton: it's a cheap property read, and tests throughout
 * this codebase already mutate `config.*` fields directly between cases
 * (e.g. `config.secretEncryptionKey`), so a live read keeps this consistent
 * with that convention with no extra reset-for-testing hook to remember.
 *
 * Note: the returned provider's `encryptSecret`/`decryptSecret` (used by
 * oidc.ts for OIDC client secrets) are a separate, pluggable implementation —
 * not the same-named raw functions in security/secret-box.ts that
 * backend-auth/upstream-auth.ts calls directly.
 */
export function getSecretsProvider(): SecretsProvider {
  return config.secretsProvider === "vault" ? vaultProvider : localProvider;
}
