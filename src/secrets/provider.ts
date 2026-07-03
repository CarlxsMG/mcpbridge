/**
 * Pluggable external-secrets-manager abstraction.
 *
 * The built-in [secret-box] (src/security/secret-box.ts) is synchronous and
 * keyed by a local `SECRET_ENCRYPTION_KEY` — fine for self-hosters, but some
 * operators are required by policy to keep secret material inside an
 * external KMS/secrets manager instead. `SecretsProvider` is the seam: one
 * async encrypt/decrypt contract, implemented by the zero-config local
 * default (src/secrets/local-provider.ts) and by HashiCorp Vault's Transit
 * engine (src/secrets/vault-provider.ts). Callers should never import either
 * implementation directly — use `getSecretsProvider()` (src/secrets/index.ts).
 *
 * The interface is async (unlike secret-box's plain functions) because a
 * real external provider means a network round-trip; the local provider just
 * wraps the synchronous secret-box calls in a resolved Promise.
 */
export interface SecretsProvider {
  /** Which provider this is — useful for logging/diagnostics, never for branching call-site behavior. */
  readonly name: "local" | "vault";

  /**
   * Whether this provider has the configuration it needs to operate (env
   * vars present). This is a cheap, local check only — for `local` it mirrors
   * `isSecretBoxConfigured()`; for `vault` it only checks that VAULT_ADDR and
   * VAULT_TOKEN are set, NOT that Vault is actually reachable. Callers use
   * this to fail fast with a clean, typed error before attempting a mutation,
   * exactly as the pre-existing `isSecretBoxConfigured()` check did.
   */
  isConfigured(): boolean;

  /** Encrypts `plaintext`, returning an opaque blob safe to store in a TEXT column. */
  encryptSecret(plaintext: string): Promise<string>;

  /** Decrypts a blob previously returned by `encryptSecret`. Throws on a malformed/foreign blob. */
  decryptSecret(blob: string): Promise<string>;
}
