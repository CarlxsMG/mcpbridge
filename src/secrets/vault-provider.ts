import { config } from "../config.js";
import type { SecretsProvider } from "./provider.js";

/**
 * HashiCorp Vault Transit-engine `SecretsProvider`.
 *
 * Uses Transit (not the KV secrets engine) because Transit's
 * encrypt/decrypt-a-string contract matches `SecretsProvider` exactly, with
 * no path/versioning bookkeeping to invent on this project's side:
 *
 *   POST {VAULT_ADDR}/v1/transit/encrypt/{VAULT_TRANSIT_KEY_NAME}
 *     body:     { "plaintext": "<base64>" }
 *     response: { "data": { "ciphertext": "vault:v1:...." } }
 *
 *   POST {VAULT_ADDR}/v1/transit/decrypt/{VAULT_TRANSIT_KEY_NAME}
 *     body:     { "ciphertext": "vault:v1:...." }
 *     response: { "data": { "plaintext": "<base64>" } }
 *
 * (Verified against Vault's own Transit API docs — the ciphertext returned by
 * encrypt is passed back to decrypt unmodified.)
 *
 * Auth is a Vault token sent as `X-Vault-Token`. Per the hard security
 * requirement for this feature: if Vault is unreachable, mis-configured, or
 * returns an error, every call here throws a typed `VaultProviderError` —
 * it NEVER falls back to storing/returning plaintext.
 */

export class VaultProviderError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "VaultProviderError";
  }
}

function vaultConfig(): { addr: string; token: string; keyName: string } {
  const addr = config.vaultAddr;
  const token = config.vaultToken;
  if (!addr || !token) {
    throw new VaultProviderError(
      "Vault secrets provider is selected (SECRETS_PROVIDER=vault) but VAULT_ADDR and/or VAULT_TOKEN is not set",
    );
  }
  return { addr: addr.replace(/\/+$/, ""), token, keyName: config.vaultTransitKeyName };
}

/** POSTs to /v1/transit/{op}/{key} and returns the parsed `data` object. Throws VaultProviderError on any failure. */
async function transitCall(op: "encrypt" | "decrypt", body: Record<string, string>): Promise<Record<string, unknown>> {
  const { addr, token, keyName } = vaultConfig();
  const url = `${addr}/v1/transit/${op}/${encodeURIComponent(keyName)}`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Vault-Token": token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.vaultRequestTimeoutMs),
    });
  } catch (err) {
    throw new VaultProviderError(`Vault Transit ${op} request to ${url} failed (unreachable, DNS, or timeout)`, err);
  }

  if (!resp.ok) {
    let detail = "";
    try {
      const errBody = (await resp.json()) as { errors?: unknown };
      if (Array.isArray(errBody.errors)) detail = errBody.errors.join("; ");
    } catch {
      // Body wasn't JSON (or was empty) — fall through with just the status.
    }
    throw new VaultProviderError(
      `Vault Transit ${op} request failed with HTTP ${resp.status}${detail ? `: ${detail}` : ""}`,
    );
  }

  let json: unknown;
  try {
    json = await resp.json();
  } catch (err) {
    throw new VaultProviderError(`Vault Transit ${op} response was not valid JSON`, err);
  }
  if (
    typeof json !== "object" ||
    json === null ||
    !("data" in json) ||
    typeof (json as { data: unknown }).data !== "object" ||
    (json as { data: unknown }).data === null
  ) {
    throw new VaultProviderError(`Vault Transit ${op} response is missing the expected "data" object`);
  }
  return (json as { data: Record<string, unknown> }).data;
}

export const vaultProvider: SecretsProvider = {
  name: "vault",

  isConfigured(): boolean {
    return Boolean(config.vaultAddr && config.vaultToken);
  },

  async encryptSecret(plaintext: string): Promise<string> {
    const data = await transitCall("encrypt", { plaintext: Buffer.from(plaintext, "utf8").toString("base64") });
    const ciphertext = data.ciphertext;
    if (typeof ciphertext !== "string" || !ciphertext.startsWith("vault:")) {
      throw new VaultProviderError('Vault Transit encrypt response is missing a valid "ciphertext" string');
    }
    return ciphertext;
  },

  async decryptSecret(blob: string): Promise<string> {
    const data = await transitCall("decrypt", { ciphertext: blob });
    const plaintextB64 = data.plaintext;
    if (typeof plaintextB64 !== "string") {
      throw new VaultProviderError('Vault Transit decrypt response is missing a "plaintext" string');
    }
    return Buffer.from(plaintextB64, "base64").toString("utf8");
  },
};
