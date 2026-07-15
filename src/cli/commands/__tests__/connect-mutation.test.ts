import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { connectCommand } from "../connect.js";
import * as clientMod from "../../client.js";
import { CliApiError, type CliClient } from "../../client.js";
import * as fsPromisesMod from "fs/promises";
import { CONNECT_CLIENT_IDS, CONNECT_TEMPLATES, type ConnectTemplateInput } from "../../connect-templates.js";

// Stryker mutation backstop — src/cli/commands/connect.ts (117 LOC).
//
// Coverage map:
//  - --client / --scope / --name / --out flag guards, incl. the
//    typeof-string-vs-truthy-boolean edge case for each, and the exact
//    check ORDER (client -> scope -> name-required) via combined-invalid
//    inputs that prove which error wins.
//  - scope "client"/"bundle" detail-lookup: enabled vs. disabled (warning,
//    non-fatal — still exits 0), 404 (specific not-found message, exit 1),
//    non-404 CliApiError (rethrown), non-CliApiError Error (rethrown) — a
//    convergent-masking probe for the `err instanceof CliApiError` clause.
//  - scope "system" never calls apiClient.get at all.
//  - loadCliCredentials()-then-makeClient() ordering and error propagation.
//  - wiring into ../../connect-templates.js: correct CONNECT_TEMPLATES[id]
//    selected per --client, exact ConnectTemplateInput fields passed
//    (name-or-"gateway" fallback, url from resolveGatewayEndpoint, the
//    fixed "streamable-http" transport, the fixed apiKeyPlaceholder), and
//    the exact `# n. ` numbered-instructions + blank-line output assembly.
//    connect-templates.ts's OWN per-client template content/logic is a
//    sibling agent's responsibility and is deliberately not re-tested here
//    — only that connect.ts feeds it the right input and reassembles its
//    output correctly.
//  - --out: real fs writeFile (mocked) vs. console.log, exact args/encoding.
//
// makeClient/loadCliCredentials are mocked at their owning module's
// namespace object (same technique as apply-mutation.test.ts /
// pull-mutation.test.ts / login-mutation.test.ts); writeFile is mocked the
// same way sibling routes-backup-mutation.test.ts mocks other fs/promises
// named exports (spyOn(fsPromisesMod, ...)) — no real filesystem or network
// I/O happens in this file.

const GATEWAY_URL = "https://gw.example.com";

function makeFakeApiClient(getImpl?: (path: string) => Promise<unknown>): CliClient {
  return {
    get: (path: string) => {
      if (getImpl) return getImpl(path);
      return Promise.reject(new Error(`fake apiClient.get should not have been called for path ${path}`));
    },
    post: () => Promise.reject(new Error("connectCommand should never POST")),
  } as unknown as CliClient;
}

/**
 * Independently reproduces connect.ts's own output assembly (header line,
 * 1-based numbered instructions, blank line, snippet, blank line) so tests
 * can assert on it without hand-duplicating every template's instruction
 * text. This is deliberately separate code from connect.ts (only connect.ts
 * is mutated by Stryker), so a mutant that changes the numbering base,
 * join separator, or header format still causes a real mismatch.
 */
function buildExpectedOutput(clientId: (typeof CONNECT_CLIENT_IDS)[number], input: ConnectTemplateInput): string {
  const template = CONNECT_TEMPLATES[clientId];
  const result = template.generate(input);
  return [
    `# ${template.label} — save as ${result.filename}`,
    ...result.instructions.map((line, i) => `# ${i + 1}. ${line}`),
    "",
    result.snippet,
    "",
  ].join("\n");
}

const USAGE = `Usage: gateway connect --client <${CONNECT_CLIENT_IDS.join("|")}> --scope <client|bundle|system> [--name <clientOrBundleName>] [--out <file>]`;

let loadCliCredentialsSpy: ReturnType<typeof spyOn>;
let makeClientSpy: ReturnType<typeof spyOn>;
let writeFileSpy: ReturnType<typeof spyOn>;
let consoleLogSpy: ReturnType<typeof spyOn>;
let consoleErrorSpy: ReturnType<typeof spyOn>;

function loggedLines(spy: ReturnType<typeof spyOn>): unknown[] {
  return spy.mock.calls.map((c: unknown[]) => c[0]);
}

beforeEach(() => {
  loadCliCredentialsSpy = spyOn(clientMod, "loadCliCredentials").mockResolvedValue({ url: GATEWAY_URL, token: "tok" });
  makeClientSpy = spyOn(clientMod, "makeClient").mockResolvedValue(makeFakeApiClient());
  writeFileSpy = spyOn(fsPromisesMod, "writeFile").mockResolvedValue(undefined);
  consoleLogSpy = spyOn(console, "log").mockImplementation(() => undefined);
  consoleErrorSpy = spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  loadCliCredentialsSpy.mockRestore();
  makeClientSpy.mockRestore();
  writeFileSpy.mockRestore();
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});

describe("connectCommand — --client validation", () => {
  test("missing --client entirely: usage error, returns 1, never reaches loadCliCredentials/makeClient", async () => {
    const code = await connectCommand(["--scope", "system"]);

    expect(code).toBe(1);
    expect(loggedLines(consoleErrorSpy)).toEqual([`Unknown or missing --client "".\n${USAGE}`]);
    expect(loadCliCredentialsSpy).not.toHaveBeenCalled();
    expect(makeClientSpy).not.toHaveBeenCalled();
  });

  test("unknown --client value: usage error names the bad value, returns 1", async () => {
    const code = await connectCommand(["--client", "not-a-real-client", "--scope", "system"]);

    expect(code).toBe(1);
    expect(loggedLines(consoleErrorSpy)).toEqual([`Unknown or missing --client "not-a-real-client".\n${USAGE}`]);
  });

  test("--client given as a bare boolean flag (truthy, non-string) is treated as missing", async () => {
    const code = await connectCommand(["--scope", "system", "--client"]);

    expect(code).toBe(1);
    expect(loggedLines(consoleErrorSpy)).toEqual([`Unknown or missing --client "".\n${USAGE}`]);
    expect(makeClientSpy).not.toHaveBeenCalled();
  });

  test("an invalid --client wins over an also-invalid --scope (client check runs first)", async () => {
    const code = await connectCommand(["--client", "bogus", "--scope", "bogus-too"]);

    expect(code).toBe(1);
    expect(loggedLines(consoleErrorSpy)).toEqual([`Unknown or missing --client "bogus".\n${USAGE}`]);
  });
});

describe("connectCommand — --scope validation", () => {
  test("missing --scope entirely (valid --client): usage error, returns 1", async () => {
    const code = await connectCommand(["--client", "cursor"]);

    expect(code).toBe(1);
    expect(loggedLines(consoleErrorSpy)).toEqual([`Unknown or missing --scope "".\n${USAGE}`]);
    expect(makeClientSpy).not.toHaveBeenCalled();
  });

  test("unsupported --scope value: usage error names the bad value, returns 1", async () => {
    const code = await connectCommand(["--client", "cursor", "--scope", "everything"]);

    expect(code).toBe(1);
    expect(loggedLines(consoleErrorSpy)).toEqual([`Unknown or missing --scope "everything".\n${USAGE}`]);
  });

  test("--scope given as a bare boolean flag (truthy, non-string) is treated as missing", async () => {
    const code = await connectCommand(["--client", "cursor", "--scope"]);

    expect(code).toBe(1);
    expect(loggedLines(consoleErrorSpy)).toEqual([`Unknown or missing --scope "".\n${USAGE}`]);
  });

  test("an invalid --scope wins over a missing --name (scope check runs before the name-required check)", async () => {
    const code = await connectCommand(["--client", "cursor", "--scope", "invalid-scope"]);

    expect(code).toBe(1);
    expect(loggedLines(consoleErrorSpy)).toEqual([`Unknown or missing --scope "invalid-scope".\n${USAGE}`]);
  });
});

describe("connectCommand — --name required for client/bundle scope only", () => {
  test("scope client, no --name: error, returns 1, never reaches loadCliCredentials/makeClient", async () => {
    const code = await connectCommand(["--client", "cursor", "--scope", "client"]);

    expect(code).toBe(1);
    expect(loggedLines(consoleErrorSpy)).toEqual([`--name is required for --scope client.\n${USAGE}`]);
    expect(loadCliCredentialsSpy).not.toHaveBeenCalled();
    expect(makeClientSpy).not.toHaveBeenCalled();
  });

  test("scope bundle, no --name: error, returns 1", async () => {
    const code = await connectCommand(["--client", "cursor", "--scope", "bundle"]);

    expect(code).toBe(1);
    expect(loggedLines(consoleErrorSpy)).toEqual([`--name is required for --scope bundle.\n${USAGE}`]);
  });

  test("scope system, no --name at all: NOT an error — proceeds normally", async () => {
    const code = await connectCommand(["--client", "cursor", "--scope", "system"]);

    expect(code).toBe(0);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(loadCliCredentialsSpy).toHaveBeenCalledTimes(1);
    expect(makeClientSpy).toHaveBeenCalledTimes(1);
  });

  test("--name given as a bare boolean flag (truthy, non-string) counts as absent for scope client", async () => {
    const code = await connectCommand(["--client", "cursor", "--scope", "client", "--name"]);

    expect(code).toBe(1);
    expect(loggedLines(consoleErrorSpy)).toEqual([`--name is required for --scope client.\n${USAGE}`]);
  });
});

describe("connectCommand — loadCliCredentials/makeClient ordering and propagation", () => {
  test("a loadCliCredentials() failure prevents makeClient from ever being called", async () => {
    loadCliCredentialsSpy.mockRejectedValue(new Error("not logged in"));

    await expect(connectCommand(["--client", "cursor", "--scope", "system"])).rejects.toThrow("not logged in");
    expect(makeClientSpy).not.toHaveBeenCalled();
  });

  test("a makeClient() failure propagates after loadCliCredentials already succeeded", async () => {
    makeClientSpy.mockRejectedValue(new Error("network blip"));

    await expect(connectCommand(["--client", "cursor", "--scope", "system"])).rejects.toThrow("network blip");
    expect(loadCliCredentialsSpy).toHaveBeenCalledTimes(1);
  });
});

describe("connectCommand — scope 'client' detail lookup", () => {
  test("enabled client: no warning, exits 0, full output still printed", async () => {
    makeClientSpy.mockResolvedValue(makeFakeApiClient(() => Promise.resolve({ enabled: true })));

    const code = await connectCommand(["--client", "generic-json", "--scope", "client", "--name", "acme"]);

    expect(code).toBe(0);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
  });

  test("disabled client: exact warning text, still exits 0 (non-fatal), output still printed afterward", async () => {
    makeClientSpy.mockResolvedValue(makeFakeApiClient(() => Promise.resolve({ enabled: false })));

    const code = await connectCommand(["--client", "generic-json", "--scope", "client", "--name", "acme"]);

    expect(code).toBe(0);
    expect(loggedLines(consoleErrorSpy)).toEqual([
      `Warning: client "acme" exists but is currently disabled — its tools won't be callable until it's re-enabled.`,
    ]);
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
  });

  test("client not found (404 CliApiError): exact not-found message referencing the name and gateway URL, returns 1, no output printed", async () => {
    makeClientSpy.mockResolvedValue(makeFakeApiClient(() => Promise.reject(new CliApiError(404, "not found"))));

    const code = await connectCommand(["--client", "generic-json", "--scope", "client", "--name", "acme"]);

    expect(code).toBe(1);
    expect(loggedLines(consoleErrorSpy)).toEqual([
      `Client "acme" was not found on ${GATEWAY_URL} — check the name in the admin UI's Servers page.`,
    ]);
    expect(consoleLogSpy).not.toHaveBeenCalled();
    expect(writeFileSpy).not.toHaveBeenCalled();
  });

  test("a non-404 CliApiError from the client lookup is rethrown, not swallowed as a generic not-found", async () => {
    makeClientSpy.mockResolvedValue(makeFakeApiClient(() => Promise.reject(new CliApiError(500, "internal error"))));

    await expect(connectCommand(["--client", "generic-json", "--scope", "client", "--name", "acme"])).rejects.toThrow(
      "internal error",
    );
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  test("a plain (non-CliApiError) Error from the client lookup is rethrown", async () => {
    makeClientSpy.mockResolvedValue(makeFakeApiClient(() => Promise.reject(new Error("boom"))));

    await expect(connectCommand(["--client", "generic-json", "--scope", "client", "--name", "acme"])).rejects.toThrow(
      "boom",
    );
  });

  test("the lookup path is exactly /admin-api/clients/<encodeURIComponent(name)>", async () => {
    const calls: string[] = [];
    makeClientSpy.mockResolvedValue(
      makeFakeApiClient((path) => {
        calls.push(path);
        return Promise.resolve({ enabled: true });
      }),
    );

    await connectCommand(["--client", "generic-json", "--scope", "client", "--name", "my client"]);

    expect(calls).toEqual([`/admin-api/clients/${encodeURIComponent("my client")}`]);
  });
});

describe("connectCommand — scope 'bundle' detail lookup", () => {
  test("enabled bundle: no warning, exits 0", async () => {
    makeClientSpy.mockResolvedValue(makeFakeApiClient(() => Promise.resolve({ enabled: true })));

    const code = await connectCommand(["--client", "generic-json", "--scope", "bundle", "--name", "acme-bundle"]);

    expect(code).toBe(0);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  test("disabled bundle: exact bundle-specific warning text, still exits 0", async () => {
    makeClientSpy.mockResolvedValue(makeFakeApiClient(() => Promise.resolve({ enabled: false })));

    const code = await connectCommand(["--client", "generic-json", "--scope", "bundle", "--name", "acme-bundle"]);

    expect(code).toBe(0);
    expect(loggedLines(consoleErrorSpy)).toEqual([
      `Warning: bundle "acme-bundle" exists but is currently disabled — its endpoint won't serve tools until it's re-enabled.`,
    ]);
  });

  test("bundle not found (404 CliApiError): exact bundle-specific not-found message, returns 1", async () => {
    makeClientSpy.mockResolvedValue(makeFakeApiClient(() => Promise.reject(new CliApiError(404, "not found"))));

    const code = await connectCommand(["--client", "generic-json", "--scope", "bundle", "--name", "acme-bundle"]);

    expect(code).toBe(1);
    expect(loggedLines(consoleErrorSpy)).toEqual([
      `Bundle "acme-bundle" was not found on ${GATEWAY_URL} — check the name in the admin UI's Bundles page.`,
    ]);
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  test("a non-404 CliApiError from the bundle lookup is rethrown", async () => {
    makeClientSpy.mockResolvedValue(makeFakeApiClient(() => Promise.reject(new CliApiError(403, "forbidden"))));

    await expect(
      connectCommand(["--client", "generic-json", "--scope", "bundle", "--name", "acme-bundle"]),
    ).rejects.toThrow("forbidden");
  });

  test("a plain (non-CliApiError) Error from the bundle lookup is rethrown", async () => {
    makeClientSpy.mockResolvedValue(makeFakeApiClient(() => Promise.reject(new Error("boom"))));

    await expect(
      connectCommand(["--client", "generic-json", "--scope", "bundle", "--name", "acme-bundle"]),
    ).rejects.toThrow("boom");
  });

  test("the lookup path is exactly /admin-api/bundles/<encodeURIComponent(name)>", async () => {
    const calls: string[] = [];
    makeClientSpy.mockResolvedValue(
      makeFakeApiClient((path) => {
        calls.push(path);
        return Promise.resolve({ enabled: true });
      }),
    );

    await connectCommand(["--client", "generic-json", "--scope", "bundle", "--name", "my bundle"]);

    expect(calls).toEqual([`/admin-api/bundles/${encodeURIComponent("my bundle")}`]);
  });
});

describe("connectCommand — scope 'system' skips the detail-lookup branches entirely", () => {
  test("apiClient.get is never called for scope system, even with a --name provided", async () => {
    // beforeEach's default makeClientSpy rejects any get() call, so this
    // would throw (and the test would fail via an unhandled rejection) if
    // connect.ts erroneously entered either detail-lookup branch.
    const code = await connectCommand(["--client", "generic-json", "--scope", "system", "--name", "whatever"]);

    expect(code).toBe(0);
  });
});

describe("connectCommand — output wiring into connect-templates.js", () => {
  test("system scope, no --name: template.generate is fed name 'gateway', url '<gw>/mcp', fixed transport + apiKeyPlaceholder — exact full output", async () => {
    const code = await connectCommand(["--client", "generic-json", "--scope", "system"]);

    const expected = buildExpectedOutput("generic-json", {
      name: "gateway",
      url: `${GATEWAY_URL}/mcp`,
      transport: "streamable-http",
      apiKeyPlaceholder: "<YOUR_MCP_API_KEY>",
      scope: "system",
    });

    expect(code).toBe(0);
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy.mock.calls[0]![0]).toBe(expected);
  });

  test("system scope WITH --name given: the provided name wins over the 'gateway' fallback, url still resolves to /mcp (name ignored by resolveGatewayEndpoint for system)", async () => {
    const code = await connectCommand(["--client", "generic-json", "--scope", "system", "--name", "custom-name"]);

    const expected = buildExpectedOutput("generic-json", {
      name: "custom-name",
      url: `${GATEWAY_URL}/mcp`,
      transport: "streamable-http",
      apiKeyPlaceholder: "<YOUR_MCP_API_KEY>",
      scope: "system",
    });

    expect(code).toBe(0);
    expect(consoleLogSpy.mock.calls[0]![0]).toBe(expected);
  });

  test("scope client resolves the url to <gw>/mcp/<name>", async () => {
    makeClientSpy.mockResolvedValue(makeFakeApiClient(() => Promise.resolve({ enabled: true })));

    const code = await connectCommand(["--client", "generic-json", "--scope", "client", "--name", "acme"]);

    const expected = buildExpectedOutput("generic-json", {
      name: "acme",
      url: `${GATEWAY_URL}/mcp/acme`,
      transport: "streamable-http",
      apiKeyPlaceholder: "<YOUR_MCP_API_KEY>",
      scope: "client",
    });

    expect(code).toBe(0);
    expect(consoleLogSpy.mock.calls[0]![0]).toBe(expected);
  });

  test("scope bundle resolves the url to <gw>/mcp-custom/<name>", async () => {
    makeClientSpy.mockResolvedValue(makeFakeApiClient(() => Promise.resolve({ enabled: true })));

    const code = await connectCommand(["--client", "generic-json", "--scope", "bundle", "--name", "acme-bundle"]);

    const expected = buildExpectedOutput("generic-json", {
      name: "acme-bundle",
      url: `${GATEWAY_URL}/mcp-custom/acme-bundle`,
      transport: "streamable-http",
      apiKeyPlaceholder: "<YOUR_MCP_API_KEY>",
      scope: "bundle",
    });

    expect(code).toBe(0);
    expect(consoleLogSpy.mock.calls[0]![0]).toBe(expected);
  });

  test("each supported --client id selects its own matching CONNECT_TEMPLATES entry (not always the same one)", async () => {
    for (const id of CONNECT_CLIENT_IDS) {
      consoleLogSpy.mockClear();

      const code = await connectCommand(["--client", id, "--scope", "system"]);

      const expected = buildExpectedOutput(id, {
        name: "gateway",
        url: `${GATEWAY_URL}/mcp`,
        transport: "streamable-http",
        apiKeyPlaceholder: "<YOUR_MCP_API_KEY>",
        scope: "system",
      });

      expect(code).toBe(0);
      expect(consoleLogSpy.mock.calls[0]![0]).toBe(expected);
    }
  });
});

describe("connectCommand — --out flag: write-to-file vs. print-to-stdout", () => {
  test("no --out: prints the full output via console.log, never touches fs.writeFile", async () => {
    const code = await connectCommand(["--client", "generic-json", "--scope", "system"]);

    expect(code).toBe(0);
    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
  });

  test("--out <file>: writes via fs.writeFile with exact (path, content, 'utf-8') args, logs only 'Wrote <file>' (not the full content)", async () => {
    const code = await connectCommand(["--client", "generic-json", "--scope", "system", "--out", "out/mcp.json"]);

    const expected = buildExpectedOutput("generic-json", {
      name: "gateway",
      url: `${GATEWAY_URL}/mcp`,
      transport: "streamable-http",
      apiKeyPlaceholder: "<YOUR_MCP_API_KEY>",
      scope: "system",
    });

    expect(code).toBe(0);
    expect(writeFileSpy).toHaveBeenCalledTimes(1);
    expect(writeFileSpy).toHaveBeenCalledWith("out/mcp.json", expected, "utf-8");
    expect(loggedLines(consoleLogSpy)).toEqual(["Wrote out/mcp.json"]);
  });

  test("--out given as a bare boolean flag (truthy, non-string) is treated as absent — falls back to console.log", async () => {
    const code = await connectCommand(["--client", "generic-json", "--scope", "system", "--out"]);

    expect(code).toBe(0);
    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
  });

  test("a writeFile() rejection propagates out of connectCommand rather than being swallowed", async () => {
    writeFileSpy.mockRejectedValue(new Error("EACCES"));

    await expect(
      connectCommand(["--client", "generic-json", "--scope", "system", "--out", "readonly/mcp.json"]),
    ).rejects.toThrow("EACCES");
  });
});
