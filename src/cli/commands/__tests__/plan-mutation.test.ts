import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { planCommand } from "../plan.js";
import * as clientMod from "../../client.js";
import * as configFileMod from "../../config-file.js";
import { CliApiError, type CliClient } from "../../client.js";
import type { GatewayFile } from "../../config-file.js";
import type { ConfigExport } from "../../../admin/config/config-io.js";
import { diffConfigs } from "../../../admin/config/config-diff.js";

// Stryker mutation backstop — src/cli/commands/plan.ts (44 LOC): the --file
// flag default/override/bare-boolean handling, the loadGatewayFile-then-
// makeClient ordering, the per-server clientExists loop (both the
// "already registered" / "would be registered" log lines and the drift
// flag they set), the config-drift branch (GET /admin-api/config/export +
// stripVolatile(exportedAt) + diffConfigs wiring, the "no drift" vs
// "N diff(s)" messages and the per-entry `KIND    path` log line), and the
// final "Up to date." message + drift-based exit code.
//
// makeClient/loadGatewayFile are mocked at their owning module's namespace
// object (same technique as pull-mutation.test.ts / login-mutation.test.ts).
// clientExists and diffConfigs are deliberately left UNMOCKED — clientExists
// is exercised for real against a hand-rolled fake CliClient (so the actual
// /admin-api/clients/:name + CliApiError(404) contract is what decides
// "registered" vs "not registered"), and diffConfigs is the real,
// already-mutation-tested (domain 9) implementation from
// admin/config/config-diff.ts — it is used here only as an oracle to
// compute the expected diff entries for a given LIVE/FILE config pair, not
// re-tested for its own internal correctness.

const BASE_CONFIG: ConfigExport = {
  version: 1,
  exportedAt: 111,
  bundles: [],
  alertRules: [],
  clients: [],
  guardrails: [],
  consumers: [],
};

interface FakeClientOptions {
  /** Server names for which clientExists() should resolve true (200 response). Anything else 404s. */
  existingServerNames?: Set<string>;
  /** Payload GET /admin-api/config/export resolves to. */
  configExport?: ConfigExport;
  /** If set, GET /admin-api/config/export rejects with this instead of resolving. */
  configError?: Error;
}

/** A fake CliClient whose `get` recognizes exactly the two paths planCommand/clientExists actually hit, and records every path it was called with. */
function makeFakeClient(opts: FakeClientOptions = {}): CliClient & { getCalls: string[] } {
  const getCalls: string[] = [];
  return {
    getCalls,
    get: (path: string) => {
      getCalls.push(path);
      if (path === "/admin-api/config/export") {
        if (opts.configError) return Promise.reject(opts.configError);
        return Promise.resolve(opts.configExport);
      }
      const m = /^\/admin-api\/clients\/(.+)$/.exec(path);
      if (m) {
        const name = decodeURIComponent(m[1]!);
        if (opts.existingServerNames?.has(name)) return Promise.resolve({ name });
        return Promise.reject(new CliApiError(404, "not found"));
      }
      return Promise.reject(new Error(`fake client: unexpected path ${path}`));
    },
    post: () => Promise.resolve({}),
  } as unknown as CliClient & { getCalls: string[] };
}

/** Mirrors plan.ts's private stripVolatile — used only to build the expected diffConfigs input for oracle comparisons below, never to test stripVolatile itself. */
function stripExportedAt(c: ConfigExport): Omit<ConfigExport, "exportedAt"> {
  const { exportedAt: _exportedAt, ...rest } = c;
  return rest;
}

let consoleLogSpy: ReturnType<typeof spyOn>;

/** Every string a spied console.log call was made with, in call order. */
function loggedLines(spy: ReturnType<typeof spyOn>): unknown[] {
  return spy.mock.calls.map((c: unknown[]) => c[0]);
}

beforeEach(() => {
  consoleLogSpy = spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  consoleLogSpy.mockRestore();
});

describe("planCommand — --file flag handling", () => {
  test("defaults to gateway.yaml when --file is absent", async () => {
    const loadGatewayFileSpy = spyOn(configFileMod, "loadGatewayFile").mockResolvedValue({
      version: 1,
    } as GatewayFile);
    const makeClientSpy = spyOn(clientMod, "makeClient").mockResolvedValue(makeFakeClient());
    try {
      const code = await planCommand([]);

      expect(loadGatewayFileSpy).toHaveBeenCalledWith("gateway.yaml");
      expect(makeClientSpy).toHaveBeenCalledTimes(1);
      expect(code).toBe(0);
    } finally {
      loadGatewayFileSpy.mockRestore();
      makeClientSpy.mockRestore();
    }
  });

  test("uses --file <path> verbatim", async () => {
    const loadGatewayFileSpy = spyOn(configFileMod, "loadGatewayFile").mockResolvedValue({
      version: 1,
    } as GatewayFile);
    const makeClientSpy = spyOn(clientMod, "makeClient").mockResolvedValue(makeFakeClient());
    try {
      await planCommand(["--file", "custom/gateway.yaml"]);

      expect(loadGatewayFileSpy).toHaveBeenCalledWith("custom/gateway.yaml");
    } finally {
      loadGatewayFileSpy.mockRestore();
      makeClientSpy.mockRestore();
    }
  });

  test("a bare --file flag with no following value is a truthy boolean, not a string — falls back to the default", async () => {
    const loadGatewayFileSpy = spyOn(configFileMod, "loadGatewayFile").mockResolvedValue({
      version: 1,
    } as GatewayFile);
    const makeClientSpy = spyOn(clientMod, "makeClient").mockResolvedValue(makeFakeClient());
    try {
      await planCommand(["--file"]);

      expect(loadGatewayFileSpy).toHaveBeenCalledWith("gateway.yaml");
    } finally {
      loadGatewayFileSpy.mockRestore();
      makeClientSpy.mockRestore();
    }
  });
});

describe("planCommand — ordering and error propagation", () => {
  test("loadGatewayFile runs before makeClient, and a loadGatewayFile failure prevents makeClient from ever being called", async () => {
    const loadGatewayFileSpy = spyOn(configFileMod, "loadGatewayFile").mockRejectedValue(
      new Error("cannot read gateway.yaml"),
    );
    const makeClientSpy = spyOn(clientMod, "makeClient").mockResolvedValue(makeFakeClient());
    try {
      await expect(planCommand([])).rejects.toThrow("cannot read gateway.yaml");
      expect(makeClientSpy).not.toHaveBeenCalled();
    } finally {
      loadGatewayFileSpy.mockRestore();
      makeClientSpy.mockRestore();
    }
  });

  test("propagates a makeClient() failure (e.g. not logged in) after loadGatewayFile has already succeeded", async () => {
    const loadGatewayFileSpy = spyOn(configFileMod, "loadGatewayFile").mockResolvedValue({
      version: 1,
    } as GatewayFile);
    const makeClientSpy = spyOn(clientMod, "makeClient").mockRejectedValue(new Error("not logged in"));
    try {
      await expect(planCommand([])).rejects.toThrow("not logged in");
      expect(loadGatewayFileSpy).toHaveBeenCalledTimes(1);
    } finally {
      loadGatewayFileSpy.mockRestore();
      makeClientSpy.mockRestore();
    }
  });
});

describe("planCommand — empty gateway file", () => {
  test("no servers and no config: never calls the client, logs only 'Up to date.', returns 0", async () => {
    const loadGatewayFileSpy = spyOn(configFileMod, "loadGatewayFile").mockResolvedValue({
      version: 1,
    } as GatewayFile);
    const fakeClient = makeFakeClient();
    const makeClientSpy = spyOn(clientMod, "makeClient").mockResolvedValue(fakeClient);
    try {
      const code = await planCommand([]);

      expect(fakeClient.getCalls).toEqual([]);
      expect(loggedLines(consoleLogSpy)).toEqual(["Up to date."]);
      expect(code).toBe(0);
    } finally {
      loadGatewayFileSpy.mockRestore();
      makeClientSpy.mockRestore();
    }
  });

  test("an explicit empty servers array behaves the same as an absent one — no iteration, no drift from servers", async () => {
    const loadGatewayFileSpy = spyOn(configFileMod, "loadGatewayFile").mockResolvedValue({
      version: 1,
      servers: [],
    } as GatewayFile);
    const fakeClient = makeFakeClient();
    const makeClientSpy = spyOn(clientMod, "makeClient").mockResolvedValue(fakeClient);
    try {
      const code = await planCommand([]);

      expect(fakeClient.getCalls).toEqual([]);
      expect(loggedLines(consoleLogSpy)).toEqual(["Up to date."]);
      expect(code).toBe(0);
    } finally {
      loadGatewayFileSpy.mockRestore();
      makeClientSpy.mockRestore();
    }
  });
});

describe("planCommand — server drift", () => {
  test("a mix of an already-registered and a not-yet-registered server: correct per-server messages, drift, exit code 1, and the config branch is never touched", async () => {
    const loadGatewayFileSpy = spyOn(configFileMod, "loadGatewayFile").mockResolvedValue({
      version: 1,
      servers: [{ name: "already" }, { name: "newone" }],
    } as GatewayFile);
    const fakeClient = makeFakeClient({ existingServerNames: new Set(["already"]) });
    const makeClientSpy = spyOn(clientMod, "makeClient").mockResolvedValue(fakeClient);
    try {
      const code = await planCommand([]);

      expect(fakeClient.getCalls).toEqual(["/admin-api/clients/already", "/admin-api/clients/newone"]);
      expect(loggedLines(consoleLogSpy)).toEqual([
        "  = already (already registered)",
        "  + newone (would be registered)",
      ]);
      expect(code).toBe(1);
    } finally {
      loadGatewayFileSpy.mockRestore();
      makeClientSpy.mockRestore();
    }
  });

  test("every server already registered: no drift from servers, 'Up to date.' logged, exit code 0", async () => {
    const loadGatewayFileSpy = spyOn(configFileMod, "loadGatewayFile").mockResolvedValue({
      version: 1,
      servers: [{ name: "a" }, { name: "b" }],
    } as GatewayFile);
    const fakeClient = makeFakeClient({ existingServerNames: new Set(["a", "b"]) });
    const makeClientSpy = spyOn(clientMod, "makeClient").mockResolvedValue(fakeClient);
    try {
      const code = await planCommand([]);

      expect(loggedLines(consoleLogSpy)).toEqual([
        "  = a (already registered)",
        "  = b (already registered)",
        "Up to date.",
      ]);
      expect(code).toBe(0);
    } finally {
      loadGatewayFileSpy.mockRestore();
      makeClientSpy.mockRestore();
    }
  });

  test("a clientExists() error that is NOT a 404 CliApiError propagates out of planCommand rather than being treated as 'not registered'", async () => {
    const loadGatewayFileSpy = spyOn(configFileMod, "loadGatewayFile").mockResolvedValue({
      version: 1,
      servers: [{ name: "broken" }],
    } as GatewayFile);
    const fakeClient = {
      get: () => Promise.reject(new Error("network blip")),
      post: () => Promise.resolve({}),
    } as unknown as CliClient;
    const makeClientSpy = spyOn(clientMod, "makeClient").mockResolvedValue(fakeClient);
    try {
      await expect(planCommand([])).rejects.toThrow("network blip");
    } finally {
      loadGatewayFileSpy.mockRestore();
      makeClientSpy.mockRestore();
    }
  });
});

describe("planCommand — config drift", () => {
  test("config present and matching apart from exportedAt: 'config: no drift', no server drift => 'Up to date.', exit code 0", async () => {
    const fileConfig: ConfigExport = { ...BASE_CONFIG, exportedAt: 999 };
    const loadGatewayFileSpy = spyOn(configFileMod, "loadGatewayFile").mockResolvedValue({
      version: 1,
      config: fileConfig,
    } as GatewayFile);
    const fakeClient = makeFakeClient({ configExport: BASE_CONFIG });
    const makeClientSpy = spyOn(clientMod, "makeClient").mockResolvedValue(fakeClient);
    try {
      const code = await planCommand([]);

      expect(fakeClient.getCalls).toEqual(["/admin-api/config/export"]);
      expect(loggedLines(consoleLogSpy)).toEqual(["config: no drift", "Up to date."]);
      expect(code).toBe(0);
    } finally {
      loadGatewayFileSpy.mockRestore();
      makeClientSpy.mockRestore();
    }
  });

  test("config with real differences (beyond exportedAt): drift, exit code 1, exact 'config: N diff(s)' + per-entry KIND/path lines match the real diffConfigs output", async () => {
    const liveConfig: ConfigExport = {
      ...BASE_CONFIG,
      exportedAt: 111,
      consumers: [{ name: "a", monthlyQuota: null }],
    };
    const fileConfig: ConfigExport = {
      ...BASE_CONFIG,
      exportedAt: 999,
      clients: [{ name: "newclient", enabled: true, guards: null, tools: [] }],
      consumers: [{ name: "a", monthlyQuota: 5 }],
    };
    // Oracle: the real diffConfigs, fed the same stripVolatile-shaped inputs
    // planCommand itself builds. Not re-testing diffConfigs — just using it
    // to derive the correct expected entries/count/order without hand
    // re-deriving diffConfigs's own traversal logic.
    const expectedEntries = diffConfigs(stripExportedAt(liveConfig), stripExportedAt(fileConfig));
    expect(expectedEntries.length).toBeGreaterThan(0);

    const loadGatewayFileSpy = spyOn(configFileMod, "loadGatewayFile").mockResolvedValue({
      version: 1,
      config: fileConfig,
    } as GatewayFile);
    const fakeClient = makeFakeClient({ configExport: liveConfig });
    const makeClientSpy = spyOn(clientMod, "makeClient").mockResolvedValue(fakeClient);
    try {
      const code = await planCommand([]);

      const expectedLines = [
        `config: ${expectedEntries.length} diff(s)`,
        ...expectedEntries.map((e) => `  ${e.kind.toUpperCase().padEnd(8)} ${e.path}`),
      ];
      expect(loggedLines(consoleLogSpy)).toEqual(expectedLines);
      expect(loggedLines(consoleLogSpy)).not.toContain("Up to date.");
      expect(loggedLines(consoleLogSpy)).not.toContain("config: no drift");
      expect(code).toBe(1);
    } finally {
      loadGatewayFileSpy.mockRestore();
      makeClientSpy.mockRestore();
    }
  });

  test("servers cause drift even when config itself has none — the config branch's 'no drift' doesn't clear a drift flag already set by the server loop", async () => {
    const fileConfig: ConfigExport = { ...BASE_CONFIG, exportedAt: 999 };
    const loadGatewayFileSpy = spyOn(configFileMod, "loadGatewayFile").mockResolvedValue({
      version: 1,
      servers: [{ name: "newsvc" }],
      config: fileConfig,
    } as GatewayFile);
    const fakeClient = makeFakeClient({ existingServerNames: new Set(), configExport: BASE_CONFIG });
    const makeClientSpy = spyOn(clientMod, "makeClient").mockResolvedValue(fakeClient);
    try {
      const code = await planCommand([]);

      expect(loggedLines(consoleLogSpy)).toEqual(["  + newsvc (would be registered)", "config: no drift"]);
      expect(loggedLines(consoleLogSpy)).not.toContain("Up to date.");
      expect(code).toBe(1);
    } finally {
      loadGatewayFileSpy.mockRestore();
      makeClientSpy.mockRestore();
    }
  });

  test("config drift is honored even when every server is already registered (drift isn't tied exclusively to the server loop)", async () => {
    const liveConfig: ConfigExport = { ...BASE_CONFIG, exportedAt: 111 };
    const fileConfig: ConfigExport = {
      ...BASE_CONFIG,
      exportedAt: 999,
      alertRules: [
        {
          name: "rule-x",
          eventType: "circuit_breaker_open",
          enabled: true,
          webhookUrl: "https://hooks.example.com/x",
          threshold: null,
          minCalls: null,
        },
      ],
    };
    const loadGatewayFileSpy = spyOn(configFileMod, "loadGatewayFile").mockResolvedValue({
      version: 1,
      servers: [{ name: "a" }],
      config: fileConfig,
    } as GatewayFile);
    const fakeClient = makeFakeClient({ existingServerNames: new Set(["a"]), configExport: liveConfig });
    const makeClientSpy = spyOn(clientMod, "makeClient").mockResolvedValue(fakeClient);
    try {
      const code = await planCommand([]);

      const logs = loggedLines(consoleLogSpy);
      expect(logs[0]).toBe("  = a (already registered)");
      expect(logs).not.toContain("Up to date.");
      expect(logs.some((l: unknown) => typeof l === "string" && l.startsWith("config: 1 diff(s)"))).toBe(true);
      expect(code).toBe(1);
    } finally {
      loadGatewayFileSpy.mockRestore();
      makeClientSpy.mockRestore();
    }
  });

  test("a client.get() failure for the config export propagates rather than being swallowed", async () => {
    const loadGatewayFileSpy = spyOn(configFileMod, "loadGatewayFile").mockResolvedValue({
      version: 1,
      config: BASE_CONFIG,
    } as GatewayFile);
    const fakeClient = makeFakeClient({ configError: new Error("export failed") });
    const makeClientSpy = spyOn(clientMod, "makeClient").mockResolvedValue(fakeClient);
    try {
      await expect(planCommand([])).rejects.toThrow("export failed");
    } finally {
      loadGatewayFileSpy.mockRestore();
      makeClientSpy.mockRestore();
    }
  });
});
