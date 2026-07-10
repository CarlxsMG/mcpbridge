/**
 * Stryker mutation-testing backstop for src/secrets/vault-provider.ts.
 *
 * `src/secrets/__tests__/vault-provider.test.ts` (hand-written, left untouched)
 * already covers isConfigured(), the happy-path encrypt/decrypt round trip, and
 * the broad error-handling shape. This file gap-fills the specific mutants that
 * survived a Stryker baseline scan against that file alone:
 *
 *  - VaultProviderError's `cause` wiring (the `cause !== undefined ? {cause} :
 *    undefined` ternary — distinguished via `"cause" in err`, since an
 *    explicit `{cause: undefined}` still installs an own `cause` property
 *    per the Error-cause spec, unlike omitting the options object entirely).
 *  - vaultConfig()'s partial-config branches (only addr set / only token set)
 *    and the exact "VAULT_ADDR and/or VAULT_TOKEN" message text.
 *  - The trailing-slash-stripping regex on VAULT_ADDR (multiple trailing
 *    slashes, not just one).
 *  - encodeURIComponent(keyName) actually being applied (a key name with
 *    characters that must be escaped).
 *  - The exact HTTP method/Content-Type header/request body sent to Vault.
 *  - A hung Vault response actually being aborted via AbortSignal.timeout.
 *  - The `!resp.ok` branch's detail-message assembly: Array.isArray guard
 *    (not duck-typing), the "; " join separator, the ": <detail>" vs ""
 *    ternary, and the exact message text end to end.
 *  - Every clause of the 5-clause `typeof json !== object || ... ` shape
 *    guard, exercised so each clause is independently the *only* true one
 *    (json = a bare string / null / {data: "not-an-object"} / {data: null}),
 *    including cases that only diverge from a coalesced/&&-mutated guard by
 *    letting a raw (non-VaultProviderError) TypeError escape when a
 *    downstream clause is wrongly skipped.
 *  - The "vault:" ciphertext-prefix check and both final error messages.
 *
 * Follows the existing test file's technique: a real `Bun.serve` stand-in for
 * Vault, never a real network call, config fields saved/restored per test.
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

function pointAt(server: ReturnType<typeof Bun.serve>, keyName = "mcp-rest-bridge"): void {
  const c = config as Record<string, unknown>;
  c.vaultAddr = `http://localhost:${server.port}`;
  c.vaultToken = "test-vault-token";
  c.vaultTransitKeyName = keyName;
  c.vaultRequestTimeoutMs = 2_000;
}

describe("VaultProviderError — cause wiring", () => {
  test("without a cause, `cause` is not installed as an own property at all", () => {
    const err = new VaultProviderError("boom");
    expect(err.name).toBe("VaultProviderError");
    expect(err.message).toBe("boom");
    expect("cause" in err).toBe(false);
  });

  test("with a cause, it is installed verbatim and is an own property", () => {
    const underlying = new Error("underlying failure");
    const err = new VaultProviderError("boom", underlying);
    expect("cause" in err).toBe(true);
    expect(err.cause).toBe(underlying);
  });
});

describe("vaultConfig() — partial configuration", () => {
  test("throws with the exact message when only VAULT_ADDR is set (VAULT_TOKEN missing)", async () => {
    const c = config as Record<string, unknown>;
    c.vaultAddr = "http://vault.example.internal:8200";
    c.vaultToken = undefined;
    await expect(vaultProvider.encryptSecret("x")).rejects.toThrow(
      "Vault secrets provider is selected (SECRETS_PROVIDER=vault) but VAULT_ADDR and/or VAULT_TOKEN is not set",
    );
  });

  test("throws with the exact message when only VAULT_TOKEN is set (VAULT_ADDR missing)", async () => {
    const c = config as Record<string, unknown>;
    c.vaultAddr = undefined;
    c.vaultToken = "some-token";
    await expect(vaultProvider.decryptSecret("vault:v1:x")).rejects.toThrow(
      "Vault secrets provider is selected (SECRETS_PROVIDER=vault) but VAULT_ADDR and/or VAULT_TOKEN is not set",
    );
  });
});

describe("vaultConfig() — trailing-slash stripping", () => {
  test("multiple trailing slashes on VAULT_ADDR are fully stripped, not just one", async () => {
    let seenPath = "";
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seenPath = new URL(req.url).pathname;
        return Response.json({ data: { ciphertext: "vault:v1:x" } });
      },
    });
    try {
      const c = config as Record<string, unknown>;
      c.vaultAddr = `http://localhost:${server.port}///`;
      c.vaultToken = "t";
      c.vaultTransitKeyName = "mcp-rest-bridge";
      c.vaultRequestTimeoutMs = 2_000;
      await vaultProvider.encryptSecret("x");
      expect(seenPath).toBe("/v1/transit/encrypt/mcp-rest-bridge");
    } finally {
      server.stop(true);
    }
  });

  // The Bun.serve round trip above cannot, on its own, distinguish "/\/+$/"
  // (strip one-or-more trailing slashes) from "/\/$/" (strip exactly one) —
  // confirmed empirically: fetch()/Bun's HTTP client silently collapses a
  // run of redundant slashes right after the authority before the request
  // ever reaches the wire, so a leftover slash from an under-stripped addr
  // never shows up in the server's `req.url`. Mocking `fetch` directly (the
  // established technique elsewhere in this repo, e.g.
  // src/proxy/__tests__/proxy-mutation-c9-pinip-request.test.ts) captures the
  // exact URL string `transitCall` builds, before any such normalization.
  test("the raw fetch() URL has no leftover slash after stripping multiple trailing slashes", async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    try {
      globalThis.fetch = (async (url: string) => {
        capturedUrl = url;
        return Response.json({ data: { ciphertext: "vault:v1:x" } });
      }) as typeof fetch;
      const c = config as Record<string, unknown>;
      c.vaultAddr = "http://vault.example.internal:8200///";
      c.vaultToken = "t";
      c.vaultTransitKeyName = "mcp-rest-bridge";
      c.vaultRequestTimeoutMs = 2_000;
      await vaultProvider.encryptSecret("x");
      expect(capturedUrl).toBe("http://vault.example.internal:8200/v1/transit/encrypt/mcp-rest-bridge");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("transitCall() — URL / method / header / body wire format", () => {
  test("encodeURIComponent is applied to the transit key name", async () => {
    let seenPath = "";
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seenPath = new URL(req.url).pathname;
        return Response.json({ data: { ciphertext: "vault:v1:x" } });
      },
    });
    try {
      pointAt(server, "a/b c");
      await vaultProvider.encryptSecret("x");
      expect(seenPath).toBe(`/v1/transit/encrypt/${encodeURIComponent("a/b c")}`);
      expect(seenPath).toBe("/v1/transit/encrypt/a%2Fb%20c");
    } finally {
      server.stop(true);
    }
  });

  test("sends method POST, Content-Type application/json, and the exact JSON body", async () => {
    const seen: { method: string; contentType: string | null; body: unknown } = {
      method: "",
      contentType: null,
      body: undefined,
    };
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seen.method = req.method;
        seen.contentType = req.headers.get("content-type");
        seen.body = await req.json();
        return Response.json({ data: { plaintext: Buffer.from("hi", "utf8").toString("base64") } });
      },
    });
    try {
      pointAt(server);
      await vaultProvider.decryptSecret("vault:v1:whatever");
      expect(seen.method).toBe("POST");
      expect(seen.contentType).toBe("application/json");
      expect(seen.body).toEqual({ ciphertext: "vault:v1:whatever" });
    } finally {
      server.stop(true);
    }
  });

  test("aborts and throws VaultProviderError when Vault hangs past the configured timeout", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch() {
        // Never resolves — the request must be aborted by AbortSignal.timeout,
        // not by the response ever actually arriving.
        await new Promise(() => {});
        return new Response("unreachable");
      },
    });
    try {
      const c = config as Record<string, unknown>;
      c.vaultAddr = `http://localhost:${server.port}`;
      c.vaultToken = "t";
      c.vaultTransitKeyName = "mcp-rest-bridge";
      c.vaultRequestTimeoutMs = 100;
      await expect(vaultProvider.encryptSecret("x")).rejects.toThrow(VaultProviderError);
    } finally {
      server.stop(true);
    }
  }, 3_000);

  test("the unreachable-connection error message names the operation and URL", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const port = server.port;
    server.stop(true);
    const c = config as Record<string, unknown>;
    c.vaultAddr = `http://localhost:${port}`;
    c.vaultToken = "t";
    c.vaultTransitKeyName = "mcp-rest-bridge";
    c.vaultRequestTimeoutMs = 2_000;
    await expect(vaultProvider.encryptSecret("x")).rejects.toThrow(
      `Vault Transit encrypt request to http://localhost:${port}/v1/transit/encrypt/mcp-rest-bridge failed (unreachable, DNS, or timeout)`,
    );
  });
});

describe("transitCall() — !resp.ok detail-message assembly", () => {
  test("HTTP-status-only message when the error body has no usable errors array", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("plain text failure", { status: 503 }) });
    try {
      pointAt(server);
      await expect(vaultProvider.encryptSecret("x")).rejects.toThrow(
        /^Vault Transit encrypt request failed with HTTP 503$/,
      );
    } finally {
      server.stop(true);
    }
  });

  test("does not append detail via duck-typing — only a genuine array triggers Array.isArray", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ errors: { join: () => "should-not-appear" } }, { status: 500 }),
    });
    try {
      pointAt(server);
      await expect(vaultProvider.encryptSecret("x")).rejects.toThrow(
        /^Vault Transit encrypt request failed with HTTP 500$/,
      );
    } finally {
      server.stop(true);
    }
  });

  test("a genuine multi-element errors array is joined with '; ' and appended after ': '", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ errors: ["permission denied", "second reason"] }, { status: 403 }),
    });
    try {
      pointAt(server);
      await expect(vaultProvider.encryptSecret("x")).rejects.toThrow(
        "Vault Transit encrypt request failed with HTTP 403: permission denied; second reason",
      );
    } finally {
      server.stop(true);
    }
  });
});

describe("transitCall() — response-shape guard (typeof json !== object || ...)", () => {
  test("top-level JSON is a bare string (not an object at all)", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json("just a string") });
    try {
      pointAt(server);
      await expect(vaultProvider.encryptSecret("x")).rejects.toThrow(VaultProviderError);
      await expect(vaultProvider.encryptSecret("x")).rejects.toThrow(
        'Vault Transit encrypt response is missing the expected "data" object',
      );
    } finally {
      server.stop(true);
    }
  });

  test("top-level JSON is null", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json(null) });
    try {
      pointAt(server);
      await expect(vaultProvider.encryptSecret("x")).rejects.toThrow(VaultProviderError);
      await expect(vaultProvider.encryptSecret("x")).rejects.toThrow(
        'Vault Transit encrypt response is missing the expected "data" object',
      );
    } finally {
      server.stop(true);
    }
  });

  test("data is present but is not an object (a string)", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ data: "oops-a-string" }) });
    try {
      pointAt(server);
      await expect(vaultProvider.encryptSecret("x")).rejects.toThrow(VaultProviderError);
      await expect(vaultProvider.encryptSecret("x")).rejects.toThrow(
        'Vault Transit encrypt response is missing the expected "data" object',
      );
    } finally {
      server.stop(true);
    }
  });

  test("data is explicitly null", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ data: null }) });
    try {
      pointAt(server);
      await expect(vaultProvider.encryptSecret("x")).rejects.toThrow(VaultProviderError);
      await expect(vaultProvider.encryptSecret("x")).rejects.toThrow(
        'Vault Transit encrypt response is missing the expected "data" object',
      );
    } finally {
      server.stop(true);
    }
  });
});

describe("transitCall() — invalid-JSON response message", () => {
  test("a 200 OK response with a non-JSON body throws with the exact 'not valid JSON' message", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("<html>not json</html>", { status: 200 }) });
    try {
      pointAt(server);
      await expect(vaultProvider.encryptSecret("x")).rejects.toThrow(
        "Vault Transit encrypt response was not valid JSON",
      );
    } finally {
      server.stop(true);
    }
  });
});

describe("encryptSecret() — 'vault:' ciphertext-prefix check", () => {
  test("throws when ciphertext is a valid string but lacks the vault: prefix", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ data: { ciphertext: "not-vault-prefixed" } }) });
    try {
      pointAt(server);
      await expect(vaultProvider.encryptSecret("x")).rejects.toThrow(
        'Vault Transit encrypt response is missing a valid "ciphertext" string',
      );
    } finally {
      server.stop(true);
    }
  });

  test("throws with the exact message when ciphertext is absent", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ data: {} }) });
    try {
      pointAt(server);
      await expect(vaultProvider.encryptSecret("x")).rejects.toThrow(
        'Vault Transit encrypt response is missing a valid "ciphertext" string',
      );
    } finally {
      server.stop(true);
    }
  });
});

describe("decryptSecret() — plaintext-field message", () => {
  test("throws with the exact message when the plaintext field is absent", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ data: { notPlaintext: "x" } }) });
    try {
      pointAt(server);
      await expect(vaultProvider.decryptSecret("vault:v1:whatever")).rejects.toThrow(
        'Vault Transit decrypt response is missing a "plaintext" string',
      );
    } finally {
      server.stop(true);
    }
  });

  test("throws with the exact message when the plaintext field is present but not a string", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ data: { plaintext: 12345 } }) });
    try {
      pointAt(server);
      await expect(vaultProvider.decryptSecret("vault:v1:whatever")).rejects.toThrow(
        'Vault Transit decrypt response is missing a "plaintext" string',
      );
    } finally {
      server.stop(true);
    }
  });
});
