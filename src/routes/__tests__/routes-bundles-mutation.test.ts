/**
 * Stryker mutation-testing gap-fill for src/routes/bundles.ts — domain 8.
 * The existing hand-written src/routes/__tests__/routes-bundles.test.ts (and
 * its sibling src/routes/__tests__/routes-bundle-install-links.test.ts, which
 * covers the install-link sub-routes end to end) already exercise the
 * happy-path + a handful of error branches. This file gap-fills what those
 * two leave uncovered, per a baseline Stryker scan (255 mutants, 121 killed /
 * 132 survived / 2 timeout):
 *   - validateExpiresAt / validateToolRefs / validateCompositeRefs: neither
 *     existing file drives every branch of these three shared validators, and
 *     several "400" assertions in the existing files check status only, not
 *     the exact code/message — which masks a mutant that reaches the SAME
 *     status via a completely different (wrong) branch.
 *   - PATCH's description/enabled/tools/composites field-by-field validation
 *     (each has its own outer `!== undefined` guard AND its own inner
 *     validity check — same-guard-multiple-call-sites, each needs its own
 *     fixture).
 *   - Exact recordAudit() argument assertions (POST/PATCH/DELETE bundle,
 *     install-link create/revoke) and exact response-body assertions
 *     (PATCH/DELETE's `{status, name}` / `{status, id}` envelopes) — the
 *     existing files mostly re-fetch state afterward rather than asserting
 *     the mutation response body itself.
 *   - GET /admin-api/bundles/:name/install-links' own 404 (BUNDLE_NOT_FOUND)
 *     branch has zero test coverage in either existing file.
 *
 * Three survivors are accepted EQUIVALENTS (all verified empirically by
 * hand-applying the exact mutation to a backup copy of the source, re-running
 * this file, and confirming it stays green, then restoring the original):
 *   - Mutant 134 (StringLiteral 109:62-109:64): the bundle-name ternary's
 *     `""` fallback replaced with the literal text "Stryker was here!". Both
 *     "" and "Stryker was here!" fail TOOL_NAME_RE
 *     (`/^[a-z0-9][a-z0-9_-]{0,62}$/`, src/lib/identifier.ts) — the
 *     placeholder starts with an uppercase letter and contains a space and
 *     "!" — producing byte-identical 400 INVALID_NAME responses (the error
 *     message is a static string, not derived from the failing name).
 *   - Mutant 17 (ConditionalExpression 45:7-45:32, validateExpiresAt): the
 *     `typeof input !== "number"` clause forced to `false`. Redundant given
 *     the very next clause, `!Number.isFinite(input)` — Number.isFinite()
 *     performs NO coercion and returns `false` for every non-number typeof,
 *     so any input that isn't typeof "number" always already fails via that
 *     second clause regardless of the first.
 *   - Mutant 59 (ConditionalExpression 63:7-63:32, validateToolRefs): the
 *     `typeof entry !== "object"` clause forced to `false`. Over JSON's type
 *     system (string/number/boolean/null/object/array — no functions or
 *     symbols), every non-object value's `.client`/`.tool` property access
 *     yields `undefined`, which the very next clauses
 *     (`typeof entry.client !== "string"` / `.tool`) already reject — there
 *     is no JSON-representable value where this clause's own truth value
 *     changes the final outcome.
 *
 * Four mutants (120, 128, 158, 220 — whole-handler/whole-route-callback
 * BlockStatement on GET /admin-api/bundles/:name, POST /admin-api/bundles,
 * PATCH /admin-api/bundles/:name, and POST .../install-links) are accepted
 * TIMEOUTS: an emptied handler body never sends a response, so the request
 * hangs until Stryker's own 60s per-mutant timeout — a legitimate "killed via
 * timeout", not a real gap.
 */
import { describe, test, expect, spyOn } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { initBundles } from "../../admin/tool-composition/bundles.js";
import { initComposites, createComposite } from "../../admin/tool-composition/composites.js";
import * as auditMod from "../../admin/audit/audit.js";
import type { RestToolDefinition } from "../../mcp/types.js";

const ADMIN_KEY = "test-admin-key-bundles-mut";
const originalSecretKey = config.secretEncryptionKey;

let baseUrl = "";
let activeServer: Server | null = null;

async function startApp(): Promise<void> {
  __resetDbForTesting();
  initBundles();
  initComposites();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  // A real 32-byte key so POST .../install-links' SECRET_BOX_NOT_CONFIGURED
  // branch is never in play here (it's already covered by the sibling file).
  (config as Record<string, unknown>).secretEncryptionKey = Buffer.alloc(32, 7).toString("base64");
  (config as Record<string, unknown>).maxToolsPerClient = 100;

  const { bundleRoutes } = await import("../../routes/bundles.js");
  const app = express();
  app.use(express.json({ limit: "64kb", strict: true }));
  bundleRoutes(app);

  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      activeServer = srv;
      resolve();
    });
    srv.on("error", reject);
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (activeServer) {
      activeServer.close(() => {
        activeServer = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" };
}

function makeTool(overrides: Partial<RestToolDefinition> = {}): RestToolDefinition {
  return {
    name: "get-things",
    method: "GET",
    endpoint: "/things",
    description: "Returns a list of things",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

async function reg(name: string, tools: RestToolDefinition[] = [makeTool()]): Promise<void> {
  await registry.register(name, tools, "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

/** Registers a fresh client with one real tool and wraps it in a valid, existing composite. */
async function makeValidComposite(compositeName: string, clientName: string): Promise<void> {
  await reg(clientName, [makeTool({ name: "step-tool" })]);
  const r = await createComposite(
    compositeName,
    undefined,
    { type: "object", properties: {} },
    [{ targetClient: clientName, targetTool: "step-tool", argsTemplate: {} }],
    "tester",
  );
  expect(r.ok).toBe(true);
}

async function teardown(): Promise<void> {
  for (const c of registry.listClients()) {
    await registry.unregister(c.name);
  }
  await stopServer();
  (config as Record<string, unknown>).secretEncryptionKey = originalSecretKey;
}

async function withApp(fn: () => Promise<void>): Promise<void> {
  await startApp();
  try {
    await fn();
  } finally {
    await teardown();
  }
}

// ── GET /admin-api/bundles/:name — success detail (existing file only covers 404) ──

describe("GET /admin-api/bundles/:name", () => {
  test("returns the full bundle detail shape, including composites, on success", async () => {
    await withApp(async () => {
      await makeValidComposite("comp-a", "svc-detail");
      await reg("svc-detail-tools", [makeTool({ name: "t1" })]);
      const create = await fetch(`${baseUrl}/admin-api/bundles`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          name: "detail-bundle",
          description: "a detail bundle",
          tools: [{ client: "svc-detail-tools", tool: "t1" }],
          composites: ["comp-a"],
        }),
      });
      expect(create.status).toBe(201);

      const res = await fetch(`${baseUrl}/admin-api/bundles/detail-bundle`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        name: string;
        description: string | null;
        enabled: boolean;
        createdAt: number;
        updatedAt: number;
        tools: { client: string; tool: string }[];
        composites: string[];
      };
      expect(body.name).toBe("detail-bundle");
      expect(body.description).toBe("a detail bundle");
      expect(body.enabled).toBe(true);
      expect(typeof body.createdAt).toBe("number");
      expect(typeof body.updatedAt).toBe("number");
      expect(body.tools).toEqual([{ client: "svc-detail-tools", tool: "t1" }]);
      expect(body.composites).toEqual(["comp-a"]);
    });
  });

  test("404 for an unknown bundle carries the exact code AND message", async () => {
    await withApp(async () => {
      const res = await fetch(`${baseUrl}/admin-api/bundles/nobody`, { headers: bearer() });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("BUNDLE_NOT_FOUND");
      expect(body.error.message).toBe("Bundle not found");
    });
  });
});

// ── POST /admin-api/bundles — name/description ternaries, tools[]/composites[] validators ──

describe("POST /admin-api/bundles — name/description coercion", () => {
  test("a non-string, truthy name is treated as absent (empty string), not coerced -> INVALID_NAME", async () => {
    await withApp(async () => {
      const res = await fetch(`${baseUrl}/admin-api/bundles`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: 42, tools: [] }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_NAME");
    });
  });

  test("a valid string description is preserved verbatim in the created bundle", async () => {
    await withApp(async () => {
      const res = await fetch(`${baseUrl}/admin-api/bundles`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "desc-bundle", description: "hello there", tools: [] }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { description: string | null };
      expect(body.description).toBe("hello there");
    });
  });

  test("a non-string, truthy description is treated as absent (stored as null), not coerced", async () => {
    await withApp(async () => {
      const res = await fetch(`${baseUrl}/admin-api/bundles`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "desc-bundle-2", description: 42, tools: [] }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { description: string | null };
      expect(body.description).toBeNull();
    });
  });

  test("omitting tools[] entirely defaults to an empty array, not a placeholder entry", async () => {
    await withApp(async () => {
      const res = await fetch(`${baseUrl}/admin-api/bundles`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "no-tools-bundle" }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { tools: unknown[] };
      expect(body.tools).toEqual([]);
    });
  });
});

describe("POST /admin-api/bundles — tools[] validation", () => {
  test("400 (exact message) when tools is not an array", async () => {
    await withApp(async () => {
      const res = await fetch(`${baseUrl}/admin-api/bundles`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "b", tools: "not-an-array" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("tools must be an array");
    });
  });

  test("400 (exact code+message, not a different downstream 400) when tools[] exceeds the max-tools cap", async () => {
    await withApp(async () => {
      (config as Record<string, unknown>).maxToolsPerClient = 2;
      const res = await fetch(`${baseUrl}/admin-api/bundles`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          name: "b",
          tools: [
            { client: "a", tool: "x" },
            { client: "a", tool: "y" },
            { client: "a", tool: "z" },
          ],
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      // If the cap check were bypassed (e.g. its guard block emptied), the
      // three (nonexistent) tool refs would instead fail existence
      // validation inside createBundle with a DIFFERENT code (UNKNOWN_TOOL) —
      // asserting VALIDATION_ERROR here is what actually proves the cap
      // check itself fired.
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("tools exceeds maximum of 2");
    });
  });

  test("exactly at the max-tools cap succeeds (boundary: > not >=)", async () => {
    await withApp(async () => {
      (config as Record<string, unknown>).maxToolsPerClient = 2;
      await reg("svc-cap", [makeTool({ name: "t1" }), makeTool({ name: "t2" })]);
      const res = await fetch(`${baseUrl}/admin-api/bundles`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          name: "cap-boundary",
          tools: [
            { client: "svc-cap", tool: "t1" },
            { client: "svc-cap", tool: "t2" },
          ],
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { tools: unknown[] };
      expect(body.tools).toHaveLength(2);
    });
  });

  test.each([
    ["a non-object entry", [42]],
    ["a null entry", [null]],
    ["a non-string client", [{ client: 42, tool: "x" }]],
    ["a non-string tool", [{ client: "x", tool: 42 }]],
    ["an empty-string client", [{ client: "", tool: "x" }]],
    ["an empty-string tool", [{ client: "x", tool: "" }]],
  ])("400 (exact message) for %s", async (_label, tools) => {
    await withApp(async () => {
      const res = await fetch(`${baseUrl}/admin-api/bundles`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "b", tools }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("each tools[] entry must be {client: string, tool: string}");
    });
  });
});

describe("POST /admin-api/bundles — composites[] validation", () => {
  test("400 (exact message) when composites is not an array", async () => {
    await withApp(async () => {
      const res = await fetch(`${baseUrl}/admin-api/bundles`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "b", tools: [], composites: "not-an-array" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("composites must be an array");
    });
  });

  test("400 (exact code+message) when composites[] exceeds the max-tools cap", async () => {
    await withApp(async () => {
      (config as Record<string, unknown>).maxToolsPerClient = 1;
      const res = await fetch(`${baseUrl}/admin-api/bundles`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "b", tools: [], composites: ["ghost-a", "ghost-b"] }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("composites exceeds maximum of 1");
    });
  });

  test("exactly at the max-tools cap succeeds (boundary: > not >=)", async () => {
    await withApp(async () => {
      (config as Record<string, unknown>).maxToolsPerClient = 1;
      await makeValidComposite("comp-boundary", "svc-comp-boundary");
      const res = await fetch(`${baseUrl}/admin-api/bundles`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "comp-cap-bundle", tools: [], composites: ["comp-boundary"] }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { composites: string[] };
      expect(body.composites).toEqual(["comp-boundary"]);
    });
  });

  test.each([
    ["a non-string entry", [42]],
    ["an empty-string entry", [""]],
    // A non-string entry that nonetheless has a truthy `.length` (unlike a
    // number or empty string) — needed to kill a mutant that forces the
    // `typeof x === "string"` half of the `&&` to always-true: with [42] or
    // [""] alone, the `.length > 0` half independently still rejects (42
    // has no .length; "".length is 0), so those two fixtures can't by
    // themselves prove the typeof half is actually being checked.
    ["a non-string entry with a truthy .length (array)", [[1, 2, 3]]],
  ])("400 (exact message) for %s", async (_label, composites) => {
    await withApp(async () => {
      const res = await fetch(`${baseUrl}/admin-api/bundles`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "b", tools: [], composites }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("each composites[] entry must be a non-empty string");
    });
  });

  test("400 (UNKNOWN_TOOL) for a well-formed but nonexistent composite name", async () => {
    await withApp(async () => {
      const res = await fetch(`${baseUrl}/admin-api/bundles`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "b", tools: [], composites: ["ghost"] }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("UNKNOWN_TOOL");
      expect(body.error.message).toBe('Unknown composite tool "ghost"');
    });
  });

  test("a valid composites[] + tools[] create records the exact audit detail (tools_count, composites_count)", async () => {
    await withApp(async () => {
      await makeValidComposite("comp-audit", "svc-audit");
      await reg("svc-audit-tools", [makeTool({ name: "t1" }), makeTool({ name: "t2" })]);

      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/bundles`, {
          method: "POST",
          headers: bearer(),
          body: JSON.stringify({
            name: "audit-bundle",
            tools: [
              { client: "svc-audit-tools", tool: "t1" },
              { client: "svc-audit-tools", tool: "t2" },
            ],
            composites: ["comp-audit"],
          }),
        });
        expect(res.status).toBe(201);
        expect(spy).toHaveBeenCalledWith("bearer:admin-api-key", "bundle.create", "audit-bundle", {
          tools_count: 2,
          composites_count: 1,
        });
      } finally {
        spy.mockRestore();
      }
    });
  });
});

// ── PATCH /admin-api/bundles/:name — per-field validation + exact audit/response body ──

describe("PATCH /admin-api/bundles/:name — description", () => {
  test("updates description to a valid string", async () => {
    await withApp(async () => {
      await fetch(`${baseUrl}/admin-api/bundles`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "b", description: "old", tools: [] }),
      });
      const res = await fetch(`${baseUrl}/admin-api/bundles/b`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ description: "new-desc" }),
      });
      expect(res.status).toBe(200);
      const detail = (await (await fetch(`${baseUrl}/admin-api/bundles/b`, { headers: bearer() })).json()) as {
        description: string | null;
      };
      expect(detail.description).toBe("new-desc");
    });
  });

  test("updates description to explicit null (allowed, distinct from a type error)", async () => {
    await withApp(async () => {
      await fetch(`${baseUrl}/admin-api/bundles`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "b", description: "old", tools: [] }),
      });
      const res = await fetch(`${baseUrl}/admin-api/bundles/b`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ description: null }),
      });
      expect(res.status).toBe(200);
      const detail = (await (await fetch(`${baseUrl}/admin-api/bundles/b`, { headers: bearer() })).json()) as {
        description: string | null;
      };
      expect(detail.description).toBeNull();
    });
  });

  test("400 (exact message) for a non-string, non-null description", async () => {
    await withApp(async () => {
      await fetch(`${baseUrl}/admin-api/bundles`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "b", tools: [] }),
      });
      const res = await fetch(`${baseUrl}/admin-api/bundles/b`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ description: 42 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("description must be a string or null");
    });
  });
});

describe("PATCH /admin-api/bundles/:name — enabled", () => {
  test("400 (exact message) for a truthy, non-boolean enabled value", async () => {
    await withApp(async () => {
      await fetch(`${baseUrl}/admin-api/bundles`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "b", tools: [] }),
      });
      const res = await fetch(`${baseUrl}/admin-api/bundles/b`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ enabled: "yes" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("enabled must be a boolean");

      // And the bundle must be untouched — the invalid PATCH must not have
      // silently coerced "yes" into `enabled: true`.
      const detail = (await (await fetch(`${baseUrl}/admin-api/bundles/b`, { headers: bearer() })).json()) as {
        enabled: boolean;
      };
      expect(detail.enabled).toBe(true);
    });
  });
});

describe("PATCH /admin-api/bundles/:name — tools[]", () => {
  test("updates tools[] to a new valid set", async () => {
    await withApp(async () => {
      await reg("svc-patch-tools", [makeTool({ name: "t1" }), makeTool({ name: "t2" })]);
      await fetch(`${baseUrl}/admin-api/bundles`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "b", tools: [{ client: "svc-patch-tools", tool: "t1" }] }),
      });
      const res = await fetch(`${baseUrl}/admin-api/bundles/b`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ tools: [{ client: "svc-patch-tools", tool: "t2" }] }),
      });
      expect(res.status).toBe(200);
      const detail = (await (await fetch(`${baseUrl}/admin-api/bundles/b`, { headers: bearer() })).json()) as {
        tools: { client: string; tool: string }[];
      };
      expect(detail.tools).toEqual([{ client: "svc-patch-tools", tool: "t2" }]);
    });
  });

  test("400 (exact message) when the new tools[] fails validation", async () => {
    await withApp(async () => {
      await fetch(`${baseUrl}/admin-api/bundles`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "b", tools: [] }),
      });
      const res = await fetch(`${baseUrl}/admin-api/bundles/b`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ tools: "not-an-array" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("tools must be an array");
    });
  });
});

describe("PATCH /admin-api/bundles/:name — composites[]", () => {
  test("updates composites[] to a new valid set", async () => {
    await withApp(async () => {
      await makeValidComposite("comp-patch", "svc-comp-patch");
      await fetch(`${baseUrl}/admin-api/bundles`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "b", tools: [] }),
      });
      const res = await fetch(`${baseUrl}/admin-api/bundles/b`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ composites: ["comp-patch"] }),
      });
      expect(res.status).toBe(200);
      const detail = (await (await fetch(`${baseUrl}/admin-api/bundles/b`, { headers: bearer() })).json()) as {
        composites: string[];
      };
      expect(detail.composites).toEqual(["comp-patch"]);
    });
  });

  test("400 (exact message) when the new composites[] fails validation", async () => {
    await withApp(async () => {
      await fetch(`${baseUrl}/admin-api/bundles`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "b", tools: [] }),
      });
      const res = await fetch(`${baseUrl}/admin-api/bundles/b`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ composites: "not-an-array" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("composites must be an array");
    });
  });
});

describe("PATCH /admin-api/bundles/:name — omitted fields are left untouched", () => {
  test("a description-only PATCH leaves tools/composites/enabled unchanged", async () => {
    await withApp(async () => {
      await reg("svc-untouched", [makeTool({ name: "t1" })]);
      await makeValidComposite("comp-untouched", "svc-untouched-comp");
      await fetch(`${baseUrl}/admin-api/bundles`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          name: "b",
          tools: [{ client: "svc-untouched", tool: "t1" }],
          composites: ["comp-untouched"],
        }),
      });
      const res = await fetch(`${baseUrl}/admin-api/bundles/b`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ description: "only-this" }),
      });
      expect(res.status).toBe(200);
      const detail = (await (await fetch(`${baseUrl}/admin-api/bundles/b`, { headers: bearer() })).json()) as {
        description: string | null;
        enabled: boolean;
        tools: unknown[];
        composites: string[];
      };
      expect(detail.description).toBe("only-this");
      expect(detail.enabled).toBe(true);
      expect(detail.tools).toEqual([{ client: "svc-untouched", tool: "t1" }]);
      expect(detail.composites).toEqual(["comp-untouched"]);
    });
  });
});

describe("PATCH /admin-api/bundles/:name — exact audit detail + response body", () => {
  test("a combined update records recordAudit with the exact fields[] list, in call order", async () => {
    await withApp(async () => {
      await reg("svc-combined", [makeTool({ name: "t1" })]);
      await makeValidComposite("comp-combined", "svc-combined-comp");
      await fetch(`${baseUrl}/admin-api/bundles`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "b", tools: [] }),
      });

      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/bundles/b`, {
          method: "PATCH",
          headers: bearer(),
          body: JSON.stringify({
            description: "d",
            enabled: false,
            tools: [{ client: "svc-combined", tool: "t1" }],
            composites: ["comp-combined"],
          }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; name: string };
        expect(body).toEqual({ status: "updated", name: "b" });

        expect(spy).toHaveBeenCalledWith("bearer:admin-api-key", "bundle.update", "b", {
          fields: ["description", "enabled", "tools", "composites"],
        });
      } finally {
        spy.mockRestore();
      }
    });
  });

  test("404 for an unknown bundle carries the exact code AND message", async () => {
    await withApp(async () => {
      const res = await fetch(`${baseUrl}/admin-api/bundles/nobody`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      // Unlike GET/DELETE (which hardcode notFound(res, "BUNDLE_NOT_FOUND", ...)),
      // PATCH's 404 flows through updateBundle()'s own mutation-error shape,
      // whose code is "NOT_FOUND" (mapped via BUNDLE_ERROR_STATUS), not
      // "BUNDLE_NOT_FOUND".
      expect(body.error.code).toBe("NOT_FOUND");
      expect(body.error.message).toBe(`Bundle "nobody" not found`);
    });
  });
});

// ── DELETE /admin-api/bundles/:name — exact audit detail + response body ──

describe("DELETE /admin-api/bundles/:name", () => {
  test("records recordAudit with no detail argument at all, and returns the exact response body", async () => {
    await withApp(async () => {
      await fetch(`${baseUrl}/admin-api/bundles`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "b", tools: [] }),
      });

      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/bundles/b`, { method: "DELETE", headers: bearer() });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; name: string };
        expect(body).toEqual({ status: "deleted", name: "b" });
        expect(spy).toHaveBeenCalledWith("bearer:admin-api-key", "bundle.delete", "b");
        expect(spy.mock.calls[0]).toHaveLength(3);
      } finally {
        spy.mockRestore();
      }
    });
  });

  test("404 for an unknown bundle carries the exact code AND message", async () => {
    await withApp(async () => {
      const res = await fetch(`${baseUrl}/admin-api/bundles/nobody`, { method: "DELETE", headers: bearer() });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("BUNDLE_NOT_FOUND");
      expect(body.error.message).toBe("Bundle not found");
    });
  });
});

// ── POST /admin-api/bundles/:name/install-links — validateExpiresAt via the real route ──

describe("POST /admin-api/bundles/:name/install-links — expiresAt validation", () => {
  async function makeBundleWithTool(bundleName: string, clientName: string): Promise<void> {
    await reg(clientName, [makeTool({ name: "link-tool" })]);
    const res = await fetch(`${baseUrl}/admin-api/bundles`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name: bundleName, tools: [{ client: clientName, tool: "link-tool" }] }),
    });
    expect(res.status).toBe(201);
  }

  test("no Content-Type / no body at all defaults expiresAt to null and still succeeds", async () => {
    await withApp(async () => {
      await makeBundleWithTool("il-a", "svc-il-a");
      const res = await fetch(`${baseUrl}/admin-api/bundles/il-a/install-links`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { expiresAt: number | null };
      expect(body.expiresAt).toBeNull();
    });
  });

  test("an explicit null expiresAt is allowed (equivalent to omitted)", async () => {
    await withApp(async () => {
      await makeBundleWithTool("il-b", "svc-il-b");
      const res = await fetch(`${baseUrl}/admin-api/bundles/il-b/install-links`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ expiresAt: null }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { expiresAt: number | null };
      expect(body.expiresAt).toBeNull();
    });
  });

  test("a valid positive epoch-ms number is preserved verbatim", async () => {
    await withApp(async () => {
      await makeBundleWithTool("il-c", "svc-il-c");
      const future = Date.now() + 1000 * 60 * 60;
      const res = await fetch(`${baseUrl}/admin-api/bundles/il-c/install-links`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ expiresAt: future }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { expiresAt: number | null };
      expect(body.expiresAt).toBe(future);
    });
  });

  test.each([
    ["a non-numeric string", '{"expiresAt":"tomorrow"}'],
    ["zero", '{"expiresAt":0}'],
    ["a negative number", '{"expiresAt":-100}'],
    // 1e400 is valid JSON number syntax that overflows to +Infinity once
    // parsed — the only way to exercise the !Number.isFinite() branch
    // through a real HTTP request body (JSON has no Infinity literal, and
    // JSON.stringify(Infinity) serializes to "null", which would defeat this
    // fixture).
    ["a non-finite number (overflowing exponent)", '{"expiresAt":1e400}'],
  ])("400 (exact message) for %s", async (_label, rawBody) => {
    await withApp(async () => {
      await makeBundleWithTool("il-d", "svc-il-d");
      const res = await fetch(`${baseUrl}/admin-api/bundles/il-d/install-links`, {
        method: "POST",
        headers: bearer(),
        body: rawBody,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("expiresAt must be a positive epoch-ms number or null");
    });
  });

  test("records recordAudit with the exact installLinkId detail", async () => {
    await withApp(async () => {
      await makeBundleWithTool("il-e", "svc-il-e");
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/bundles/il-e/install-links`, {
          method: "POST",
          headers: bearer(),
        });
        expect(res.status).toBe(201);
        const created = (await res.json()) as { id: number };
        expect(spy).toHaveBeenCalledWith("bearer:admin-api-key", "bundle.install_link.create", "il-e", {
          installLinkId: created.id,
        });
      } finally {
        spy.mockRestore();
      }
    });
  });
});

// ── GET /admin-api/bundles/:name/install-links — 404 branch (zero coverage in either existing file) ──

describe("GET /admin-api/bundles/:name/install-links", () => {
  test("404 (exact code+message) for an unknown bundle", async () => {
    await withApp(async () => {
      const res = await fetch(`${baseUrl}/admin-api/bundles/nobody/install-links`, { headers: bearer() });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("BUNDLE_NOT_FOUND");
      expect(body.error.message).toBe("Bundle not found");
    });
  });
});

// ── DELETE /admin-api/bundles/:name/install-links/:id — exact audit detail + response body ──

describe("DELETE /admin-api/bundles/:name/install-links/:id", () => {
  test("records recordAudit with the exact installLinkId detail, and returns the exact response body", async () => {
    await withApp(async () => {
      await reg("svc-revoke", [makeTool({ name: "link-tool" })]);
      await fetch(`${baseUrl}/admin-api/bundles`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "il-revoke", tools: [{ client: "svc-revoke", tool: "link-tool" }] }),
      });
      const createRes = await fetch(`${baseUrl}/admin-api/bundles/il-revoke/install-links`, {
        method: "POST",
        headers: bearer(),
      });
      const created = (await createRes.json()) as { id: number };

      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/bundles/il-revoke/install-links/${created.id}`, {
          method: "DELETE",
          headers: bearer(),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; id: number };
        expect(body).toEqual({ status: "revoked", id: created.id });
        expect(spy).toHaveBeenCalledWith("bearer:admin-api-key", "bundle.install_link.revoke", "il-revoke", {
          installLinkId: created.id,
        });
      } finally {
        spy.mockRestore();
      }
    });
  });
});
