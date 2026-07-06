/**
 * HashiCorp Vault Transit-engine `SecretsProvider` (src/secrets/vault-provider.ts).
 *
 * Spins up a real HTTP server via Bun.serve to stand in for Vault — mirroring
 * how src/__tests__/backends.test.ts already does this for WS tests — rather
 * than mocking `fetch`, so the actual request/response wire format (path,
 * headers, JSON shape) that vault-provider.ts sends/expects is exercised for
 * real, not just a stubbed call.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { config } from "../../config.js";
import { vaultProvider, VaultProviderError } from "../../secrets/vault-provider.js";

const orig = {
  vaultAddr: config.vaultAddr,
  vaultToken: config.vaultToken,
  vaultTransitKeyName: config.vaultTransitKeyName,
  vaultRequestTimeoutMs: config.vaultRequestTimeoutMs,
};

afterEach(() => {
  const c = config as Record<string, unknown>;
  c.vaultAddr = orig.vaultAddr;
  c.vaultToken = orig.vaultToken;
  c.vaultTransitKeyName = orig.vaultTransitKeyName;
  c.vaultRequestTimeoutMs = orig.vaultRequestTimeoutMs;
});

function pointAt(server: ReturnType<typeof Bun.serve>): void {
  const c = config as Record<string, unknown>;
  c.vaultAddr = `http://localhost:${server.port}`;
  c.vaultToken = "test-vault-token";
  c.vaultTransitKeyName = "mcp-rest-bridge";
  c.vaultRequestTimeoutMs = 2_000;
}

/**
 * A minimal fake Transit engine: POST /v1/transit/encrypt/:key and
 * /v1/transit/decrypt/:key, gated on X-Vault-Token, with real (if trivial)
 * state so a round trip actually has to go encrypt -> decrypt to succeed —
 * it isn't just structurally shaped like Vault's response.
 */
function fakeVault(expectedToken = "test-vault-token"): ReturnType<typeof Bun.serve> {
  const store = new Map<string, string>();
  let counter = 0;
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.headers.get("x-vault-token") !== expectedToken) {
        return Response.json({ errors: ["permission denied"] }, { status: 403 });
      }
      const body = (await req.json()) as Record<string, string>;

      const encryptMatch = url.pathname.match(/^\/v1\/transit\/encrypt\/(.+)$/);
      if (encryptMatch) {
        counter++;
        const ciphertext = `vault:v1:fake-${counter}`;
        store.set(ciphertext, body.plaintext);
        return Response.json({ data: { ciphertext } });
      }

      const decryptMatch = url.pathname.match(/^\/v1\/transit\/decrypt\/(.+)$/);
      if (decryptMatch) {
        const plaintext = store.get(body.ciphertext);
        if (plaintext === undefined) {
          return Response.json({ errors: ["no value found at that key"] }, { status: 400 });
        }
        return Response.json({ data: { plaintext } });
      }

      return new Response("not found", { status: 404 });
    },
  });
}

describe("vaultProvider.isConfigured", () => {
  test("false when VAULT_ADDR/VAULT_TOKEN are unset", () => {
    const c = config as Record<string, unknown>;
    c.vaultAddr = undefined;
    c.vaultToken = undefined;
    expect(vaultProvider.isConfigured()).toBe(false);
  });

  test("true once both VAULT_ADDR and VAULT_TOKEN are set", () => {
    const c = config as Record<string, unknown>;
    c.vaultAddr = "http://vault.example.internal:8200";
    c.vaultToken = "t";
    expect(vaultProvider.isConfigured()).toBe(true);
  });

  test("false when only one of the two is set", () => {
    const c = config as Record<string, unknown>;
    c.vaultAddr = "http://vault.example.internal:8200";
    c.vaultToken = undefined;
    expect(vaultProvider.isConfigured()).toBe(false);
  });
});

describe("vaultProvider — encrypt/decrypt round trip", () => {
  test("encryptSecret returns a vault:-prefixed ciphertext; decryptSecret inverts it", async () => {
    const server = fakeVault();
    try {
      pointAt(server);
      const ciphertext = await vaultProvider.encryptSecret("hello world");
      expect(ciphertext.startsWith("vault:")).toBe(true);
      expect(await vaultProvider.decryptSecret(ciphertext)).toBe("hello world");
    } finally {
      server.stop(true);
    }
  });

  test("plaintext is base64-encoded on the wire, not sent raw", async () => {
    let seenBody: Record<string, string> | undefined;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seenBody = (await req.json()) as Record<string, string>;
        return Response.json({ data: { ciphertext: "vault:v1:whatever" } });
      },
    });
    try {
      pointAt(server);
      await vaultProvider.encryptSecret("hello world");
      expect(seenBody?.plaintext).toBe(Buffer.from("hello world", "utf8").toString("base64"));
    } finally {
      server.stop(true);
    }
  });

  test("sends the configured Vault token as X-Vault-Token and the key name in the URL path", async () => {
    const seen: { token: string | null; path: string } = { token: null, path: "" };
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seen.token = req.headers.get("x-vault-token");
        seen.path = new URL(req.url).pathname;
        return Response.json({ data: { ciphertext: "vault:v1:whatever" } });
      },
    });
    try {
      pointAt(server);
      (config as Record<string, unknown>).vaultTransitKeyName = "my-custom-key";
      await vaultProvider.encryptSecret("x");
      expect(seen.token).toBe("test-vault-token");
      expect(seen.path).toBe("/v1/transit/encrypt/my-custom-key");
    } finally {
      server.stop(true);
    }
  });
});

describe("vaultProvider — error handling", () => {
  test("throws VaultProviderError (never falls back to plaintext) when VAULT_ADDR/VAULT_TOKEN are unset", async () => {
    const c = config as Record<string, unknown>;
    c.vaultAddr = undefined;
    c.vaultToken = undefined;
    await expect(vaultProvider.encryptSecret("secret")).rejects.toThrow(VaultProviderError);
    await expect(vaultProvider.decryptSecret("vault:v1:x")).rejects.toThrow(VaultProviderError);
  });

  test("throws VaultProviderError when Vault is unreachable", async () => {
    // Start a server to claim a free port, then immediately stop it — nothing
    // is listening there anymore, so the connection is refused quickly rather
    // than needing a full timeout to elapse.
    const server = fakeVault();
    const port = server.port;
    server.stop(true);
    const c = config as Record<string, unknown>;
    c.vaultAddr = `http://localhost:${port}`;
    c.vaultToken = "t";
    c.vaultTransitKeyName = "mcp-rest-bridge";
    c.vaultRequestTimeoutMs = 2_000;
    await expect(vaultProvider.encryptSecret("secret")).rejects.toThrow(VaultProviderError);
  });

  test("throws VaultProviderError on a 403 (bad/rejected token)", async () => {
    const server = fakeVault("the-real-token");
    try {
      pointAt(server); // pointAt sets "test-vault-token", which doesn't match "the-real-token"
      await expect(vaultProvider.encryptSecret("secret")).rejects.toThrow(VaultProviderError);
    } finally {
      server.stop(true);
    }
  });

  test("throws VaultProviderError when the response body isn't valid JSON", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("<html>not json</html>", { status: 200 }) });
    try {
      pointAt(server);
      await expect(vaultProvider.encryptSecret("secret")).rejects.toThrow(VaultProviderError);
    } finally {
      server.stop(true);
    }
  });

  test("throws VaultProviderError when the response is missing the expected data.ciphertext field", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ data: {} }) });
    try {
      pointAt(server);
      await expect(vaultProvider.encryptSecret("secret")).rejects.toThrow(VaultProviderError);
    } finally {
      server.stop(true);
    }
  });

  test("throws VaultProviderError when the response is missing the expected data.plaintext field on decrypt", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ data: { notPlaintext: "x" } }) });
    try {
      pointAt(server);
      await expect(vaultProvider.decryptSecret("vault:v1:whatever")).rejects.toThrow(VaultProviderError);
    } finally {
      server.stop(true);
    }
  });

  test('throws VaultProviderError when the top-level "data" object itself is missing', async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ nope: true }) });
    try {
      pointAt(server);
      await expect(vaultProvider.encryptSecret("secret")).rejects.toThrow(VaultProviderError);
    } finally {
      server.stop(true);
    }
  });
});
