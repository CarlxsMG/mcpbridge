import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { pullCommand } from "../pull.js";
import * as clientMod from "../../client.js";
import * as configFileMod from "../../config-file.js";
import type { CliClient } from "../../client.js";
import type { GatewayFile } from "../../config-file.js";
import type { ConfigExport } from "../../../admin/config/config-io.js";

// Stryker mutation backstop — src/cli/commands/pull.ts (24 LOC): pullCommand's
// --file flag default/override, the makeClient() + GET /admin-api/config/export
// round trip, the try/catch around loadGatewayFile that decides whether
// "servers:" is preserved or omitted from the written file, and the final
// saveGatewayFile payload + console.log message + return code.
//
// makeClient/loadGatewayFile/saveGatewayFile are all mocked at their owning
// module's namespace object — same technique used elsewhere in this program
// (e.g. src/mcp/__tests__/registration-mutation-rg3.test.ts) — so no real
// network call or filesystem write ever happens. The CliClient returned by
// the mocked makeClient() is a plain hand-rolled fake (not itself a spy),
// with its own call-tracking arrays, since CliClient's methods are generic
// and don't need bun:test's mock() machinery.

const SAMPLE_CONFIG: ConfigExport = {
  version: 1,
  exportedAt: 12345,
  bundles: [],
  alertRules: [],
  clients: [],
  guardrails: [],
  consumers: [],
};

let getCalls: string[];

/** A fake CliClient whose `get` records every path it was called with and always resolves to `result`. */
function makeFakeClient(result: unknown = SAMPLE_CONFIG): CliClient {
  return {
    get: (path: string) => {
      getCalls.push(path);
      return Promise.resolve(result);
    },
    post: () => Promise.resolve({}),
  } as unknown as CliClient;
}

let makeClientSpy: ReturnType<typeof spyOn>;
let loadGatewayFileSpy: ReturnType<typeof spyOn>;
let saveGatewayFileSpy: ReturnType<typeof spyOn>;
let consoleLogSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  getCalls = [];
  makeClientSpy = spyOn(clientMod, "makeClient").mockImplementation(async () => makeFakeClient());
  saveGatewayFileSpy = spyOn(configFileMod, "saveGatewayFile").mockImplementation(async () => undefined);
  // Default: no existing gateway.yaml on disk (the common case — most repos
  // run `pull` for the very first time before any `apply`/`plan`).
  loadGatewayFileSpy = spyOn(configFileMod, "loadGatewayFile").mockImplementation(async () => {
    throw new Error("ENOENT (fixture default — no existing file)");
  });
  consoleLogSpy = spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  makeClientSpy.mockRestore();
  saveGatewayFileSpy.mockRestore();
  loadGatewayFileSpy.mockRestore();
  consoleLogSpy.mockRestore();
});

describe("pullCommand", () => {
  test("defaults to gateway.yaml when --file is absent, and omits servers: when no existing file can be loaded", async () => {
    const code = await pullCommand([]);

    expect(code).toBe(0);
    expect(loadGatewayFileSpy).toHaveBeenCalledWith("gateway.yaml");
    expect(getCalls).toEqual(["/admin-api/config/export"]);
    expect(saveGatewayFileSpy).toHaveBeenCalledTimes(1);

    const [savedPath, savedFile] = saveGatewayFileSpy.mock.calls[0] as [string, GatewayFile];
    expect(savedPath).toBe("gateway.yaml");
    // toStrictEqual (not toEqual) so a mutant that always includes a
    // `servers: undefined` key is caught — toEqual alone treats an
    // undefined-valued key as equivalent to an absent one.
    expect(savedFile).toStrictEqual({ version: 1, config: SAMPLE_CONFIG });
    expect("servers" in savedFile).toBe(false);
    expect(consoleLogSpy).toHaveBeenCalledWith("Wrote gateway.yaml");
  });

  test("uses --file <path> verbatim for load, get, save, and the final log line, and preserves a non-empty servers list", async () => {
    const servers: GatewayFile["servers"] = [
      { name: "svc", kind: "rest", base_url: "https://svc.example.com" },
      { name: "other-svc", kind: "mcp", mcp_url: "https://other.example.com" },
    ];
    loadGatewayFileSpy.mockImplementation(async () => ({ version: 1, servers }) as GatewayFile);

    const code = await pullCommand(["--file", "custom/gateway.yaml"]);

    expect(code).toBe(0);
    expect(loadGatewayFileSpy).toHaveBeenCalledWith("custom/gateway.yaml");
    expect(getCalls).toEqual(["/admin-api/config/export"]);

    const [savedPath, savedFile] = saveGatewayFileSpy.mock.calls[0] as [string, GatewayFile];
    expect(savedPath).toBe("custom/gateway.yaml");
    expect(savedFile).toStrictEqual({ version: 1, servers, config: SAMPLE_CONFIG });
    expect(consoleLogSpy).toHaveBeenCalledWith("Wrote custom/gateway.yaml");
  });

  test("a bare --file flag with no following value is a truthy boolean, not a string — falls back to the gateway.yaml default", async () => {
    // parseFlags treats a trailing --file with nothing after it as `true`
    // (boolean), never a string — pullCommand must not use it as a path.
    const code = await pullCommand(["--file"]);

    expect(code).toBe(0);
    expect(loadGatewayFileSpy).toHaveBeenCalledWith("gateway.yaml");
    expect(saveGatewayFileSpy.mock.calls[0]?.[0]).toBe("gateway.yaml");
    expect(consoleLogSpy).toHaveBeenCalledWith("Wrote gateway.yaml");
  });

  test("preserves an existing but EMPTY servers array as its own key — not omitted just because it's empty", async () => {
    loadGatewayFileSpy.mockImplementation(async () => ({ version: 1, servers: [] }) as GatewayFile);

    await pullCommand([]);

    const savedFile = saveGatewayFileSpy.mock.calls[0]?.[1] as GatewayFile;
    expect("servers" in savedFile).toBe(true);
    expect(savedFile).toStrictEqual({ version: 1, servers: [], config: SAMPLE_CONFIG });
  });

  test("omits servers: entirely when the loaded file resolves without throwing but has no servers field", async () => {
    loadGatewayFileSpy.mockImplementation(async () => ({ version: 1 }) as GatewayFile);

    await pullCommand([]);

    const savedFile = saveGatewayFileSpy.mock.calls[0]?.[1] as GatewayFile;
    expect("servers" in savedFile).toBe(false);
    expect(savedFile).toStrictEqual({ version: 1, config: SAMPLE_CONFIG });
  });

  test("propagates a makeClient() failure (e.g. not logged in) and never reaches loadGatewayFile or saveGatewayFile", async () => {
    makeClientSpy.mockImplementation(async () => {
      throw new Error("not logged in");
    });

    await expect(pullCommand([])).rejects.toThrow("not logged in");
    expect(saveGatewayFileSpy).not.toHaveBeenCalled();
  });

  test("propagates a client.get() failure and never reaches saveGatewayFile", async () => {
    makeClientSpy.mockImplementation(async () => ({
      get: () => Promise.reject(new Error("export failed")),
      post: () => Promise.resolve({}),
    }));

    await expect(pullCommand([])).rejects.toThrow("export failed");
    expect(saveGatewayFileSpy).not.toHaveBeenCalled();
  });

  test("writes the exact config payload returned by client.get, byte for byte", async () => {
    const distinctiveConfig: ConfigExport = {
      ...SAMPLE_CONFIG,
      exportedAt: 999999,
      consumers: [{ name: "team-x", monthlyQuota: 42, endUserRateLimitPerMin: null }],
    };
    makeClientSpy.mockImplementation(async () => makeFakeClient(distinctiveConfig));

    await pullCommand([]);

    const savedFile = saveGatewayFileSpy.mock.calls[0]?.[1] as GatewayFile;
    expect(savedFile.config).toStrictEqual(distinctiveConfig);
  });
});
