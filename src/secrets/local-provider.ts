import { encryptSecret, decryptSecret, isSecretBoxConfigured } from "../security/secret-box.js";
import type { SecretsProvider } from "./provider.js";

/**
 * Default, zero-config `SecretsProvider` — wraps this project's built-in
 * AES-256-GCM secret-box (src/security/secret-box.ts) UNCHANGED, keyed by
 * `SECRET_ENCRYPTION_KEY`. The underlying calls are synchronous; they're
 * just lifted into `async` functions here so this satisfies the same
 * contract as vault-provider.ts (whose calls are real network I/O).
 */
export const localProvider: SecretsProvider = {
  name: "local",

  isConfigured(): boolean {
    return isSecretBoxConfigured();
  },

  async encryptSecret(plaintext: string): Promise<string> {
    return encryptSecret(plaintext);
  },

  async decryptSecret(blob: string): Promise<string> {
    return decryptSecret(blob);
  },
};
