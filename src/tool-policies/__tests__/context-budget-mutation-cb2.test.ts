/**
 * Stryker gap-closer: forces setToolContextBudget's llm_summarize try/catch
 * around `getSecretsProvider().encryptSecret()` (context-budget.ts, ~L155-166)
 * to genuinely throw. No test in context-budget.test.ts ever drives a real
 * encryptSecret failure — that file only ever exercises the
 * "provider not configured" branch (isConfigured() === false), so the whole
 * catch body was a live Stryker survivor:
 *
 *   } catch (err) {
 *     return { ok: false, error: "SECRETS_PROVIDER_ERROR", reason: err instanceof Error ? err.message : String(err) };
 *   }
 *
 * Why spyOn instead of a "genuine" config-driven failure: the real local
 * provider (src/secrets/local-provider.ts -> src/security/secret-box.ts)
 * can't be made to fail encryptSecret while isConfigured() stays true —
 * both calls read the exact same `config.secretEncryptionKey` via the same
 * `getKey()` helper, so there is no key value that satisfies one and not
 * the other. Instead this spies on `getSecretsProvider()` itself
 * (src/secrets/index.ts), mirroring the `import * as xMod from "...";
 * spyOn(xMod, "fn")` pattern used throughout src/**\/__tests__ (e.g.
 * registration-mutation-rg2.test.ts spying on
 * ipValidatorMod.validateBackendUrl) to intercept a call made *inside* the
 * module under test via its live ESM binding.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import { setToolContextBudget } from "../../tool-policies/context-budget.js";
import * as secretsMod from "../../secrets/index.js";
import type { SecretsProvider } from "../../secrets/provider.js";
import type { RestToolDefinition } from "../../mcp/types.js";

const CLIENT = "cbsvc-cb2";
const getTool: RestToolDefinition = {
  name: "get-thing",
  method: "GET",
  endpoint: "/thing",
  description: "d",
  inputSchema: { type: "object", properties: {} },
};

async function reg(): Promise<void> {
  await registry.register(CLIENT, [getTool], "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

const origKey = config.secretEncryptionKey;

function configureSecretBox(): void {
  (config as Record<string, unknown>).secretEncryptionKey = Buffer.alloc(32, 9).toString("base64");
}

function resetAll(): void {
  __resetDbForTesting();
  (config as Record<string, unknown>).secretEncryptionKey = origKey;
  removeCircuitBreaker(CLIENT);
}

beforeEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  resetAll();
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  resetAll();
});

/** A `SecretsProvider` that reports configured but always fails to encrypt with `thrown`. */
function throwingProvider(thrown: unknown): SecretsProvider {
  return {
    name: "local",
    isConfigured: () => true,
    encryptSecret: async () => {
      throw thrown;
    },
    decryptSecret: async () => {
      throw new Error("decryptSecret should not be called in this test");
    },
  };
}

describe("setToolContextBudget — llm_summarize: genuine encryptSecret failure -> SECRETS_PROVIDER_ERROR", () => {
  test("thrown value is a real Error -> reason is err.message exactly", async () => {
    await reg();
    configureSecretBox();
    const spy = spyOn(secretsMod, "getSecretsProvider").mockReturnValue(
      throwingProvider(new Error("kms temporarily unavailable")),
    );
    try {
      const result = await setToolContextBudget(CLIENT, getTool.name, {
        mode: "llm_summarize",
        maxResponseBytes: 500,
        llm: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "sk-raw-key" },
      });
      expect(result).toEqual({
        ok: false,
        error: "SECRETS_PROVIDER_ERROR",
        reason: "kms temporarily unavailable",
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("thrown value is a non-Error (raw string) -> reason is String(err) exactly", async () => {
    await reg();
    configureSecretBox();
    const spy = spyOn(secretsMod, "getSecretsProvider").mockReturnValue(throwingProvider("raw string failure"));
    try {
      const result = await setToolContextBudget(CLIENT, getTool.name, {
        mode: "llm_summarize",
        maxResponseBytes: 500,
        llm: {
          provider: "anthropic",
          baseUrl: "https://api.anthropic.com",
          model: "claude-haiku-4-5",
          apiKey: "sk-raw-key-2",
        },
      });
      expect(result).toEqual({
        ok: false,
        error: "SECRETS_PROVIDER_ERROR",
        reason: String("raw string failure"),
      });
    } finally {
      spy.mockRestore();
    }
  });
});
