import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { applyCommand, USAGE as APPLY_USAGE } from "../apply.js";
import * as clientMod from "../../client.js";
import * as configFileMod from "../../config-file.js";
import { CliApiError, type CliClient } from "../../client.js";
import type { GatewayFile } from "../../config-file.js";

// Stryker mutation backstop — src/cli/commands/apply.ts (92 LOC): the --file
// flag default/override/bare-boolean handling, the --dry-run boolean-equality
// handling (a truthy-but-non-`true` value must NOT count as dry-run), the
// loadGatewayFile-then-makeClient ordering, the per-server clientExists loop
// (already-registered skip / dry-run "would register" / real POST /register
// with the exact per-kind payload shape / registration failure -> exit code),
// the config-import phase (POST /admin-api/config/import, applied/skipped
// reporting, the CliApiError-and-message-matches "unsupported export
// version" branch vs. the generic-failure branch vs. a non-CliApiError whose
// message happens to match the same regex — a deliberate "convergent
// masking" probe), and the final anyServerFailed || importFailed exit code.
//
// makeClient/loadGatewayFile are mocked at their owning module's namespace
// object (same technique as plan-mutation.test.ts / login-mutation.test.ts).
// clientExists is deliberately left UNMOCKED — it's exercised for real
// against a hand-rolled fake CliClient, so the actual
// /admin-api/clients/:name + CliApiError(404) contract is what decides
// "registered" vs "not registered", exactly like plan-mutation.test.ts does.

interface FakeClientOptions {
  /** Server names for which clientExists() should resolve true (200 response). Anything else 404s. */
  existingServerNames?: Set<string>;
  /** Overrides the default POST behavior entirely (both /register and /admin-api/config/import calls flow through this). */
  postImpl?: (path: string, body: unknown) => Promise<unknown>;
}

/** A fake CliClient whose `get`/`post` recognize exactly the paths applyCommand/clientExists actually hit, and record every call. */
function makeFakeClient(opts: FakeClientOptions = {}): CliClient & { postCalls: { path: string; body: unknown }[] } {
  const postCalls: { path: string; body: unknown }[] = [];
  return {
    postCalls,
    get: (path: string) => {
      const m = /^\/admin-api\/clients\/(.+)$/.exec(path);
      if (m) {
        const name = decodeURIComponent(m[1]!);
        if (opts.existingServerNames?.has(name)) return Promise.resolve({ name });
        return Promise.reject(new CliApiError(404, "not found"));
      }
      return Promise.reject(new Error(`fake client: unexpected get path ${path}`));
    },
    post: (path: string, body: unknown) => {
      postCalls.push({ path, body });
      if (opts.postImpl) return opts.postImpl(path, body);
      return Promise.resolve({ applied: {}, skipped: [] });
    },
  } as unknown as CliClient & { postCalls: { path: string; body: unknown }[] };
}

let consoleLogSpy: ReturnType<typeof spyOn>;
let consoleErrorSpy: ReturnType<typeof spyOn>;

/** Every string a spied console.log/error call was made with, in call order. */
function loggedLines(spy: ReturnType<typeof spyOn>): unknown[] {
  return spy.mock.calls.map((c: unknown[]) => c[0]);
}

beforeEach(() => {
  consoleLogSpy = spyOn(console, "log").mockImplementation(() => undefined);
  consoleErrorSpy = spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});

/** Mocks loadGatewayFile + makeClient in one shot; returns both spies plus the fake client for further assertions. */
function mockDeps(gatewayFile: GatewayFile, clientOpts: FakeClientOptions = {}) {
  const loadGatewayFileSpy = spyOn(configFileMod, "loadGatewayFile").mockResolvedValue(gatewayFile);
  const fakeClient = makeFakeClient(clientOpts);
  const makeClientSpy = spyOn(clientMod, "makeClient").mockResolvedValue(fakeClient);
  return { loadGatewayFileSpy, makeClientSpy, fakeClient };
}

function restoreDeps(deps: { loadGatewayFileSpy: ReturnType<typeof spyOn>; makeClientSpy: ReturnType<typeof spyOn> }) {
  deps.loadGatewayFileSpy.mockRestore();
  deps.makeClientSpy.mockRestore();
}

describe("applyCommand — help", () => {
  test("--help prints usage, returns 0, and never touches loadGatewayFile or makeClient", async () => {
    const deps = mockDeps({ version: 1 });
    try {
      const code = await applyCommand(["--help"]);

      expect(code).toBe(0);
      expect(deps.loadGatewayFileSpy).not.toHaveBeenCalled();
      expect(deps.makeClientSpy).not.toHaveBeenCalled();
      expect(loggedLines(consoleLogSpy)).toEqual([APPLY_USAGE]);
      expect(loggedLines(consoleErrorSpy)).toEqual([]);
    } finally {
      restoreDeps(deps);
    }
  });

  test("-h behaves the same as --help", async () => {
    const deps = mockDeps({ version: 1 });
    try {
      const code = await applyCommand(["-h"]);

      expect(code).toBe(0);
      expect(deps.loadGatewayFileSpy).not.toHaveBeenCalled();
      expect(deps.makeClientSpy).not.toHaveBeenCalled();
      expect(loggedLines(consoleLogSpy)).toEqual([APPLY_USAGE]);
    } finally {
      restoreDeps(deps);
    }
  });
});

describe("applyCommand — --file flag handling", () => {
  test("defaults to gateway.yaml when --file is absent", async () => {
    const deps = mockDeps({ version: 1 });
    try {
      const code = await applyCommand([]);

      expect(deps.loadGatewayFileSpy).toHaveBeenCalledWith("gateway.yaml");
      expect(deps.makeClientSpy).toHaveBeenCalledTimes(1);
      expect(code).toBe(0);
    } finally {
      restoreDeps(deps);
    }
  });

  test("uses --file <path> verbatim", async () => {
    const deps = mockDeps({ version: 1 });
    try {
      await applyCommand(["--file", "custom/gateway.yaml"]);

      expect(deps.loadGatewayFileSpy).toHaveBeenCalledWith("custom/gateway.yaml");
    } finally {
      restoreDeps(deps);
    }
  });

  test("a bare --file flag with no following value is a truthy boolean, not a string — falls back to the default", async () => {
    const deps = mockDeps({ version: 1 });
    try {
      await applyCommand(["--file"]);

      expect(deps.loadGatewayFileSpy).toHaveBeenCalledWith("gateway.yaml");
    } finally {
      restoreDeps(deps);
    }
  });
});

describe("applyCommand — ordering and error propagation", () => {
  test("loadGatewayFile runs before makeClient, and a loadGatewayFile failure prevents makeClient from ever being called", async () => {
    const loadGatewayFileSpy = spyOn(configFileMod, "loadGatewayFile").mockRejectedValue(
      new Error("cannot read gateway.yaml"),
    );
    const makeClientSpy = spyOn(clientMod, "makeClient").mockResolvedValue(makeFakeClient());
    try {
      await expect(applyCommand([])).rejects.toThrow("cannot read gateway.yaml");
      expect(makeClientSpy).not.toHaveBeenCalled();
    } finally {
      loadGatewayFileSpy.mockRestore();
      makeClientSpy.mockRestore();
    }
  });

  test("propagates a makeClient() failure (e.g. not logged in) after loadGatewayFile has already succeeded", async () => {
    const loadGatewayFileSpy = spyOn(configFileMod, "loadGatewayFile").mockResolvedValue({ version: 1 });
    const makeClientSpy = spyOn(clientMod, "makeClient").mockRejectedValue(new Error("not logged in"));
    try {
      await expect(applyCommand([])).rejects.toThrow("not logged in");
      expect(loadGatewayFileSpy).toHaveBeenCalledTimes(1);
    } finally {
      loadGatewayFileSpy.mockRestore();
      makeClientSpy.mockRestore();
    }
  });
});

describe("applyCommand — empty gateway file", () => {
  test("no servers and no config: no client calls at all, returns 0", async () => {
    const deps = mockDeps({ version: 1 });
    try {
      const code = await applyCommand([]);

      expect(deps.fakeClient.postCalls).toEqual([]);
      expect(loggedLines(consoleLogSpy)).toEqual([]);
      expect(code).toBe(0);
    } finally {
      restoreDeps(deps);
    }
  });

  test("an explicit empty servers array behaves the same as an absent one", async () => {
    const deps = mockDeps({ version: 1, servers: [] });
    try {
      const code = await applyCommand([]);

      expect(deps.fakeClient.postCalls).toEqual([]);
      expect(code).toBe(0);
    } finally {
      restoreDeps(deps);
    }
  });
});

describe("applyCommand — --dry-run flag equality (=== true, not truthiness)", () => {
  test("no --dry-run at all: a not-yet-registered server is actually registered (real POST)", async () => {
    const deps = mockDeps({ version: 1, servers: [{ name: "svc-a", base_url: "https://svc-a.example.com" }] });
    try {
      const code = await applyCommand([]);

      expect(deps.fakeClient.postCalls).toEqual([
        { path: "/register", body: expect.objectContaining({ name: "svc-a" }) },
      ]);
      expect(loggedLines(consoleLogSpy)).toEqual(["  + svc-a (registered)"]);
      expect(code).toBe(0);
    } finally {
      restoreDeps(deps);
    }
  });

  test("bare --dry-run (boolean true): no real POST, 'would register' logged", async () => {
    const deps = mockDeps({ version: 1, servers: [{ name: "svc-a", base_url: "https://svc-a.example.com" }] });
    try {
      const code = await applyCommand(["--dry-run"]);

      expect(deps.fakeClient.postCalls).toEqual([]);
      expect(loggedLines(consoleLogSpy)).toEqual(["  + svc-a (would register)"]);
      expect(code).toBe(0);
    } finally {
      restoreDeps(deps);
    }
  });

  test("--dry-run given a following non-'--' value (a truthy STRING, not the boolean `true`) does NOT count as dry-run — real POST still happens", async () => {
    const deps = mockDeps({ version: 1, servers: [{ name: "svc-a", base_url: "https://svc-a.example.com" }] });
    try {
      const code = await applyCommand(["--dry-run", "false"]);

      // flags["dry-run"] === "false" (a string) here, which is truthy but
      // !== the boolean `true`; a mutant that drops the `=== true` check
      // (or flips it to `!==`) would flip this outcome.
      expect(deps.fakeClient.postCalls).toEqual([
        { path: "/register", body: expect.objectContaining({ name: "svc-a" }) },
      ]);
      expect(loggedLines(consoleLogSpy)).toEqual(["  + svc-a (registered)"]);
      expect(code).toBe(0);
    } finally {
      restoreDeps(deps);
    }
  });
});

describe("applyCommand — server registration loop", () => {
  test("already-registered server: skip message, no POST /register, exit 0", async () => {
    const deps = mockDeps({ version: 1, servers: [{ name: "svc-a" }] }, { existingServerNames: new Set(["svc-a"]) });
    try {
      const code = await applyCommand([]);

      expect(deps.fakeClient.postCalls).toEqual([]);
      expect(loggedLines(consoleLogSpy)).toEqual(["  = svc-a (already registered, skipping)"]);
      expect(code).toBe(0);
    } finally {
      restoreDeps(deps);
    }
  });

  test("mix of already-registered and not-yet-registered servers: correct per-server messages and only the unregistered one is POSTed", async () => {
    const deps = mockDeps(
      {
        version: 1,
        servers: [
          { name: "already", base_url: "https://already.example.com" },
          { name: "newone", base_url: "https://newone.example.com" },
        ],
      },
      { existingServerNames: new Set(["already"]) },
    );
    try {
      const code = await applyCommand([]);

      expect(deps.fakeClient.postCalls.map((c) => c.path)).toEqual(["/register"]);
      expect(deps.fakeClient.postCalls[0]!.body).toEqual(expect.objectContaining({ name: "newone" }));
      expect(loggedLines(consoleLogSpy)).toEqual([
        "  = already (already registered, skipping)",
        "  + newone (registered)",
      ]);
      expect(code).toBe(0);
    } finally {
      restoreDeps(deps);
    }
  });

  test("a clientExists() error that is NOT a 404 CliApiError propagates out of applyCommand rather than being treated as 'not registered'", async () => {
    const loadGatewayFileSpy = spyOn(configFileMod, "loadGatewayFile").mockResolvedValue({
      version: 1,
      servers: [{ name: "broken" }],
    });
    const fakeClient = {
      get: () => Promise.reject(new Error("network blip")),
      post: () => Promise.resolve({}),
    } as unknown as CliClient;
    const makeClientSpy = spyOn(clientMod, "makeClient").mockResolvedValue(fakeClient);
    try {
      await expect(applyCommand([])).rejects.toThrow("network blip");
    } finally {
      loadGatewayFileSpy.mockRestore();
      makeClientSpy.mockRestore();
    }
  });

  test("POST /register throwing an Error: anyServerFailed -> exit 1, exact 'failed: <message>' log via err.message", async () => {
    const deps = mockDeps(
      { version: 1, servers: [{ name: "svc-a", base_url: "https://svc-a.example.com" }] },
      { postImpl: () => Promise.reject(new Error("connection refused")) },
    );
    try {
      const code = await applyCommand([]);

      expect(loggedLines(consoleErrorSpy)).toEqual(["  x svc-a (failed: connection refused)"]);
      expect(code).toBe(1);
    } finally {
      restoreDeps(deps);
    }
  });

  test("POST /register throwing a non-Error value: falls back to String(err), still exit 1", async () => {
    const deps = mockDeps(
      { version: 1, servers: [{ name: "svc-a", base_url: "https://svc-a.example.com" }] },
      { postImpl: () => Promise.reject("boom") },
    );
    try {
      const code = await applyCommand([]);

      expect(loggedLines(consoleErrorSpy)).toEqual(["  x svc-a (failed: boom)"]);
      expect(code).toBe(1);
    } finally {
      restoreDeps(deps);
    }
  });

  test("a registration failure does not stop the loop — a later server in the same run still gets processed", async () => {
    const deps = mockDeps(
      {
        version: 1,
        servers: [
          { name: "fails", base_url: "https://fails.example.com" },
          { name: "succeeds", base_url: "https://succeeds.example.com" },
        ],
      },
      {
        postImpl: (_path, body) => {
          const name = (body as { name: string }).name;
          if (name === "fails") return Promise.reject(new Error("nope"));
          return Promise.resolve({});
        },
      },
    );
    try {
      const code = await applyCommand([]);

      expect(loggedLines(consoleErrorSpy)).toEqual(["  x fails (failed: nope)"]);
      expect(loggedLines(consoleLogSpy)).toEqual(["  + succeeds (registered)"]);
      expect(code).toBe(1);
    } finally {
      restoreDeps(deps);
    }
  });
});

describe("applyCommand — toRegistrationPayload per-kind shape", () => {
  test("rest (default/no kind): exact payload fields, nothing extra", async () => {
    const deps = mockDeps({
      version: 1,
      servers: [
        {
          name: "rest-svc",
          health_url: "https://rest-svc.example.com/health",
          base_url: "https://rest-svc.example.com",
          openapi_url: "https://rest-svc.example.com/openapi.json",
          include_tags: ["public"],
          exclude_operations: ["deleteAll"],
        },
      ],
    });
    try {
      await applyCommand([]);

      expect(deps.fakeClient.postCalls).toEqual([
        {
          path: "/register",
          body: {
            name: "rest-svc",
            health_url: "https://rest-svc.example.com/health",
            base_url: "https://rest-svc.example.com",
            openapi_url: "https://rest-svc.example.com/openapi.json",
            include_tags: ["public"],
            exclude_operations: ["deleteAll"],
          },
        },
      ]);
    } finally {
      restoreDeps(deps);
    }
  });

  test("kind: 'rest' explicit falls through to the same default shape as absent kind", async () => {
    const deps = mockDeps({
      version: 1,
      servers: [{ name: "rest-svc2", kind: "rest", base_url: "https://rest-svc2.example.com" }],
    });
    try {
      await applyCommand([]);

      expect(deps.fakeClient.postCalls[0]!.body).toEqual({
        name: "rest-svc2",
        health_url: undefined,
        base_url: "https://rest-svc2.example.com",
        openapi_url: undefined,
        include_tags: undefined,
        exclude_operations: undefined,
      });
    } finally {
      restoreDeps(deps);
    }
  });

  test("kind: 'mcp': exact mcp-shaped payload, no REST/graphql fields leak in", async () => {
    const deps = mockDeps({
      version: 1,
      servers: [
        { name: "mcp-svc", kind: "mcp", mcp_url: "https://mcp-svc.example.com/mcp", mcp_transport: "streamable-http" },
      ],
    });
    try {
      await applyCommand([]);

      expect(deps.fakeClient.postCalls).toEqual([
        {
          path: "/register",
          body: {
            kind: "mcp",
            name: "mcp-svc",
            mcp_url: "https://mcp-svc.example.com/mcp",
            mcp_transport: "streamable-http",
          },
        },
      ]);
    } finally {
      restoreDeps(deps);
    }
  });

  test("kind: 'graphql': exact graphql-shaped payload, no REST/mcp fields leak in", async () => {
    const deps = mockDeps({
      version: 1,
      servers: [
        {
          name: "gql-svc",
          kind: "graphql",
          graphql_url: "https://gql-svc.example.com/graphql",
          health_url: "https://gql-svc.example.com/health",
          include_mutations: true,
        },
      ],
    });
    try {
      await applyCommand([]);

      expect(deps.fakeClient.postCalls).toEqual([
        {
          path: "/register",
          body: {
            kind: "graphql",
            name: "gql-svc",
            graphql_url: "https://gql-svc.example.com/graphql",
            health_url: "https://gql-svc.example.com/health",
            include_mutations: true,
          },
        },
      ]);
    } finally {
      restoreDeps(deps);
    }
  });
});

describe("applyCommand — config import phase", () => {
  test("no config: property at all — config/import is never called", async () => {
    const deps = mockDeps({ version: 1, servers: [] });
    try {
      const code = await applyCommand([]);

      expect(deps.fakeClient.postCalls).toEqual([]);
      expect(code).toBe(0);
    } finally {
      restoreDeps(deps);
    }
  });

  test("config present, dryRun=false, no skips: applied summary logged, exact POST body ({dryRun, data}), exit 0", async () => {
    const config = {
      version: 1,
      exportedAt: 1,
      bundles: [],
      alertRules: [],
      clients: [],
      guardrails: [],
      consumers: [],
    };
    const deps = mockDeps(
      { version: 1, config },
      { postImpl: () => Promise.resolve({ applied: { clients: 2, guardrails: 1 }, skipped: [] }) },
    );
    try {
      const code = await applyCommand([]);

      expect(deps.fakeClient.postCalls).toEqual([
        { path: "/admin-api/config/import", body: { dryRun: false, data: config } },
      ]);
      expect(loggedLines(consoleLogSpy)).toEqual(['config: applied {"clients":2,"guardrails":1}']);
      expect(loggedLines(consoleErrorSpy)).toEqual([]);
      expect(code).toBe(0);
    } finally {
      restoreDeps(deps);
    }
  });

  test("config present with --dry-run: the POST body's dryRun field is true", async () => {
    const config = {
      version: 1,
      exportedAt: 1,
      bundles: [],
      alertRules: [],
      clients: [],
      guardrails: [],
      consumers: [],
    };
    const deps = mockDeps({ version: 1, config }, { postImpl: () => Promise.resolve({ applied: {}, skipped: [] }) });
    try {
      await applyCommand(["--dry-run"]);

      expect(deps.fakeClient.postCalls).toEqual([
        { path: "/admin-api/config/import", body: { dryRun: true, data: config } },
      ]);
    } finally {
      restoreDeps(deps);
    }
  });

  test("config present with >=2 skipped entries: importFailed -> exit 1, exact header count + per-entry lines in order", async () => {
    const config = {
      version: 1,
      exportedAt: 1,
      bundles: [],
      alertRules: [],
      clients: [],
      guardrails: [],
      consumers: [],
    };
    const deps = mockDeps(
      { version: 1, config },
      {
        postImpl: () =>
          Promise.resolve({
            applied: {},
            skipped: [
              { type: "guardrail", id: "gr-1", reason: "unknown client" },
              { type: "bundle", id: "b-2", reason: "duplicate name" },
            ],
          }),
      },
    );
    try {
      const code = await applyCommand([]);

      expect(loggedLines(consoleErrorSpy)).toEqual([
        "config: 2 entrie(s) skipped:",
        "  - guardrail gr-1: unknown client",
        "  - bundle b-2: duplicate name",
      ]);
      expect(code).toBe(1);
    } finally {
      restoreDeps(deps);
    }
  });

  test("config present with exactly 0 skipped entries: no skip header logged, importFailed stays false", async () => {
    const config = {
      version: 1,
      exportedAt: 1,
      bundles: [],
      alertRules: [],
      clients: [],
      guardrails: [],
      consumers: [],
    };
    const deps = mockDeps({ version: 1, config }, { postImpl: () => Promise.resolve({ applied: {}, skipped: [] }) });
    try {
      const code = await applyCommand([]);

      expect(loggedLines(consoleErrorSpy)).toEqual([]);
      expect(code).toBe(0);
    } finally {
      restoreDeps(deps);
    }
  });

  test("config/import rejects with a CliApiError matching /unsupported export version/i: the specific re-pull hint is logged, referencing --file", async () => {
    const config = {
      version: 1,
      exportedAt: 1,
      bundles: [],
      alertRules: [],
      clients: [],
      guardrails: [],
      consumers: [],
    };
    const deps = mockDeps(
      { version: 1, config },
      { postImpl: () => Promise.reject(new CliApiError(409, "Unsupported Export Version 3")) },
    );
    try {
      const code = await applyCommand(["--file", "my-gateway.yaml"]);

      expect(loggedLines(consoleErrorSpy)).toEqual([
        `config: my-gateway.yaml was exported from a different gateway version — run "gateway pull --file my-gateway.yaml" to refresh, then re-apply your edits.`,
      ]);
      expect(code).toBe(1);
    } finally {
      restoreDeps(deps);
    }
  });

  test("config/import rejects with a CliApiError NOT matching the unsupported-version regex: falls to the generic 'import failed' branch", async () => {
    const config = {
      version: 1,
      exportedAt: 1,
      bundles: [],
      alertRules: [],
      clients: [],
      guardrails: [],
      consumers: [],
    };
    const deps = mockDeps(
      { version: 1, config },
      { postImpl: () => Promise.reject(new CliApiError(500, "internal server error")) },
    );
    try {
      const code = await applyCommand([]);

      expect(loggedLines(consoleErrorSpy)).toEqual(["config: import failed: internal server error"]);
      expect(code).toBe(1);
    } finally {
      restoreDeps(deps);
    }
  });

  // Convergent-masking probe: a plain Error (NOT a CliApiError) whose message
  // happens to match the "unsupported export version" text must still take
  // the generic branch — the `err instanceof CliApiError` half of the `&&`
  // condition is load-bearing on its own, independent of the regex test.
  test("config/import rejects with a plain Error (not CliApiError) whose message matches the regex text: still takes the generic branch, not the CliApiError one", async () => {
    const config = {
      version: 1,
      exportedAt: 1,
      bundles: [],
      alertRules: [],
      clients: [],
      guardrails: [],
      consumers: [],
    };
    const deps = mockDeps(
      { version: 1, config },
      { postImpl: () => Promise.reject(new Error("unsupported export version")) },
    );
    try {
      const code = await applyCommand([]);

      expect(loggedLines(consoleErrorSpy)).toEqual(["config: import failed: unsupported export version"]);
      expect(code).toBe(1);
    } finally {
      restoreDeps(deps);
    }
  });

  test("config/import rejects with a non-Error value: falls back to String(err) in the generic branch", async () => {
    const config = {
      version: 1,
      exportedAt: 1,
      bundles: [],
      alertRules: [],
      clients: [],
      guardrails: [],
      consumers: [],
    };
    const deps = mockDeps({ version: 1, config }, { postImpl: () => Promise.reject("weird failure") });
    try {
      const code = await applyCommand([]);

      expect(loggedLines(consoleErrorSpy)).toEqual(["config: import failed: weird failure"]);
      expect(code).toBe(1);
    } finally {
      restoreDeps(deps);
    }
  });
});

describe("applyCommand — combined exit code (anyServerFailed || importFailed)", () => {
  test("both phases succeed: exit 0", async () => {
    const config = {
      version: 1,
      exportedAt: 1,
      bundles: [],
      alertRules: [],
      clients: [],
      guardrails: [],
      consumers: [],
    };
    const deps = mockDeps(
      { version: 1, servers: [{ name: "svc-a", base_url: "https://svc-a.example.com" }], config },
      { postImpl: () => Promise.resolve({ applied: {}, skipped: [] }) },
    );
    try {
      const code = await applyCommand([]);
      expect(code).toBe(0);
    } finally {
      restoreDeps(deps);
    }
  });

  test("server registration fails but config import succeeds cleanly: exit 1 (server failure alone is enough), and the config phase still runs to completion", async () => {
    const config = {
      version: 1,
      exportedAt: 1,
      bundles: [],
      alertRules: [],
      clients: [],
      guardrails: [],
      consumers: [],
    };
    const deps = mockDeps(
      { version: 1, servers: [{ name: "svc-a", base_url: "https://svc-a.example.com" }], config },
      {
        postImpl: (path) => {
          if (path === "/register") return Promise.reject(new Error("register failed"));
          return Promise.resolve({ applied: { clients: 1 }, skipped: [] });
        },
      },
    );
    try {
      const code = await applyCommand([]);

      expect(deps.fakeClient.postCalls.map((c) => c.path)).toEqual(["/register", "/admin-api/config/import"]);
      expect(loggedLines(consoleLogSpy)).toEqual(['config: applied {"clients":1}']);
      expect(code).toBe(1);
    } finally {
      restoreDeps(deps);
    }
  });

  test("server registration succeeds but config import has skips: exit 1 (import failure alone is enough)", async () => {
    const config = {
      version: 1,
      exportedAt: 1,
      bundles: [],
      alertRules: [],
      clients: [],
      guardrails: [],
      consumers: [],
    };
    const deps = mockDeps(
      { version: 1, servers: [{ name: "svc-a", base_url: "https://svc-a.example.com" }], config },
      {
        postImpl: (path) => {
          if (path === "/register") return Promise.resolve({});
          return Promise.resolve({ applied: {}, skipped: [{ type: "bundle", id: "b-1", reason: "bad ref" }] });
        },
      },
    );
    try {
      const code = await applyCommand([]);
      expect(code).toBe(1);
    } finally {
      restoreDeps(deps);
    }
  });

  test("both phases fail: exit 1", async () => {
    const config = {
      version: 1,
      exportedAt: 1,
      bundles: [],
      alertRules: [],
      clients: [],
      guardrails: [],
      consumers: [],
    };
    const deps = mockDeps(
      { version: 1, servers: [{ name: "svc-a", base_url: "https://svc-a.example.com" }], config },
      {
        postImpl: (path) => {
          if (path === "/register") return Promise.reject(new Error("register failed"));
          return Promise.reject(new Error("import failed too"));
        },
      },
    );
    try {
      const code = await applyCommand([]);
      expect(code).toBe(1);
    } finally {
      restoreDeps(deps);
    }
  });
});
