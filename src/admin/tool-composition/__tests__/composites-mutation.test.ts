/**
 * Stryker mutation-testing backstop for
 * src/admin/tool-composition/composites.ts — domain 9. The sibling
 * hand-written suite (composites.test.ts, left untouched) already covers the
 * templating basics, the create/update/delete happy paths, the runComposite
 * threading/short-circuit/disabled cases, and MCP bundle-gated advertising.
 * This file gap-fills what it doesn't reach: every validation error branch
 * (INVALID_SCHEMA, ALREADY_EXISTS, NOT_FOUND, the individual INVALID_STEPS
 * sub-checks), the notifyToolsChanged call-count/scopeChanged conditions, the
 * multi-row listComposites paths, the resolveRef/
 * getByPath/resolveTemplate edge branches (unknown $ref heads, non-integer
 * array indices, non-$ref-shaped objects), and runComposite's own guard
 * clauses (unknown composite, empty-steps, non-object resolved args, the
 * JSON.parse catch path). Direct import+call against an in-memory
 * `bun:sqlite` DB — this module exports no routes of its own.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { config } from "../../../config.js";
import { __resetDbForTesting, getDb } from "../../../db/connection.js";
import { registry } from "../../../mcp/registry.js";
import { removeCircuitBreaker } from "../../../middleware/circuit-breaker.js";
import * as mcpServerMod from "../../../mcp/mcp-server.js";
import * as loggerMod from "../../../logger.js";
import * as proxyMod from "../../../proxy/proxy.js";
import { SEARCH_TOOL_NAME } from "../../../mcp/tool-search.js";
import {
  initComposites,
  createComposite,
  updateComposite,
  deleteComposite,
  getCompositeDetail,
  listComposites,
  runComposite,
  resolveRef,
  resolveTemplate,
  hasComposite,
  isValidCompositeName,
  getAdvertisedComposite,
  type CompositeStep,
} from "../composites.js";
import type { RestToolDefinition } from "../../../mcp/types.js";

function tool(name: string, properties: Record<string, unknown> = {}): RestToolDefinition {
  return {
    name,
    method: "POST",
    endpoint: `/${name}`,
    description: `tool ${name}`,
    inputSchema: { type: "object", properties },
  };
}

async function regSvc(clientName = "svc"): Promise<void> {
  await registry.register(
    clientName,
    [tool("first"), tool("second", { itemId: { type: "number" }, msg: { type: "string" } }), tool("third")],
    `http://1.2.3.4/health`,
    "1.2.3.4",
    "http://1.2.3.4",
    "1.2.3.4",
  );
}

const OBJ_SCHEMA = { type: "object", properties: {} };
const originalFetch = globalThis.fetch;

function oneStep(overrides: Partial<CompositeStep> = {}): CompositeStep[] {
  return [{ targetClient: "svc", targetTool: "first", argsTemplate: {}, ...overrides }];
}

beforeEach(async () => {
  (config as Record<string, unknown>).retryMaxAttempts = 0;
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
  initComposites();
  removeCircuitBreaker("svc");
  globalThis.fetch = originalFetch;
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
  initComposites();
  globalThis.fetch = originalFetch;
});

describe("isValidCompositeName", () => {
  test("accepts a tool-name-shaped string", () => {
    expect(isValidCompositeName("my-flow_1")).toBe(true);
  });
  test("rejects a name containing the __ separator", () => {
    expect(isValidCompositeName("a__b")).toBe(false);
  });
  test("rejects the reserved search-tool name", () => {
    expect(isValidCompositeName(SEARCH_TOOL_NAME)).toBe(false);
  });
  test("rejects a name that doesn't match TOOL_NAME_RE (uppercase)", () => {
    expect(isValidCompositeName("Bad-Name")).toBe(false);
  });
  test("rejects an empty string", () => {
    expect(isValidCompositeName("")).toBe(false);
  });
});

describe("createComposite — validation branches", () => {
  test("INVALID_NAME, exact message, when the name contains the __ separator", async () => {
    await regSvc();
    const r = await createComposite("bad__name", undefined, OBJ_SCHEMA, oneStep(), "t");
    expect(r).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_NAME",
        message: "Composite name must match /^[a-z0-9][a-z0-9_-]{0,62}$/ and not contain '__'",
      },
    });
  });

  test("INVALID_SCHEMA, exact message, when inputSchema is not an object (a string)", async () => {
    await regSvc();
    const r = await createComposite("flow", undefined, "nope" as unknown as Record<string, unknown>, oneStep(), "t");
    expect(r).toMatchObject({
      ok: false,
      error: { code: "INVALID_SCHEMA", message: "inputSchema must be an object schema (type: object)" },
    });
  });

  test("INVALID_SCHEMA when inputSchema is null", async () => {
    await regSvc();
    const r = await createComposite("flow", undefined, null as unknown as Record<string, unknown>, oneStep(), "t");
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_SCHEMA" } });
  });

  test("INVALID_SCHEMA when inputSchema.type isn't 'object'", async () => {
    await regSvc();
    const r = await createComposite("flow", undefined, { type: "string" }, oneStep(), "t");
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_SCHEMA" } });
  });

  test("INVALID_SCHEMA rejects a non-object (function) inputSchema even if it has a spoofed .type === 'object' property", async () => {
    // Discriminates the `typeof inputSchema !== "object"` clause specifically:
    // for every real JS primitive/object shape, a truthy `.type !== "object"`
    // (the third OR-clause) already independently catches an invalid schema,
    // so a naive test can't tell whether the first clause is even being
    // evaluated. A function is typeof "function" (not "object") yet can still
    // carry an own `.type` property — set it to the string "object" so ONLY
    // the first clause would reject it.
    await regSvc();
    const fakeSchema = function fakeSchema() {} as unknown as Record<string, unknown>;
    (fakeSchema as unknown as { type: string }).type = "object";
    const r = await createComposite("flow", undefined, fakeSchema, oneStep(), "t");
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_SCHEMA" } });
  });

  test("ALREADY_EXISTS on a second create with the same name", async () => {
    await regSvc();
    const first = await createComposite("flow", undefined, OBJ_SCHEMA, oneStep(), "t");
    expect(first.ok).toBe(true);
    const second = await createComposite("flow", undefined, OBJ_SCHEMA, oneStep(), "t");
    expect(second).toMatchObject({
      ok: false,
      error: { code: "ALREADY_EXISTS", message: 'Composite "flow" already exists' },
    });
    // A rejected duplicate create must not clobber the original.
    expect(getCompositeDetail("flow")?.steps.length).toBe(1);
  });

  test("INVALID_STEPS, exact message, when a step's targetClient isn't a string", async () => {
    await regSvc();
    const r = await createComposite(
      "flow",
      undefined,
      OBJ_SCHEMA,
      [{ targetClient: 5 as unknown as string, targetTool: "first", argsTemplate: {} }],
      "t",
    );
    expect(r).toMatchObject({
      ok: false,
      error: { code: "INVALID_STEPS", message: "Each step needs targetClient and targetTool" },
    });
  });

  test("INVALID_STEPS when a step's targetTool isn't a string", async () => {
    await regSvc();
    const r = await createComposite(
      "flow",
      undefined,
      OBJ_SCHEMA,
      [{ targetClient: "svc", targetTool: 5 as unknown as string, argsTemplate: {} }],
      "t",
    );
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_STEPS" } });
  });

  test("INVALID_STEPS, exact message, when argsTemplate is not an object (a string)", async () => {
    await regSvc();
    const r = await createComposite(
      "flow",
      undefined,
      OBJ_SCHEMA,
      [{ targetClient: "svc", targetTool: "first", argsTemplate: "nope" as unknown as Record<string, unknown> }],
      "t",
    );
    expect(r).toMatchObject({
      ok: false,
      error: { code: "INVALID_STEPS", message: "Each step's argsTemplate must be an object" },
    });
  });

  test("INVALID_STEPS when argsTemplate is null", async () => {
    await regSvc();
    const r = await createComposite(
      "flow",
      undefined,
      OBJ_SCHEMA,
      [{ targetClient: "svc", targetTool: "first", argsTemplate: null as unknown as Record<string, unknown> }],
      "t",
    );
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_STEPS" } });
  });

  test("INVALID_STEPS when argsTemplate is an array", async () => {
    await regSvc();
    const r = await createComposite(
      "flow",
      undefined,
      OBJ_SCHEMA,
      [{ targetClient: "svc", targetTool: "first", argsTemplate: [] as unknown as Record<string, unknown> }],
      "t",
    );
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_STEPS" } });
  });

  test("INVALID_STEPS, exact message, when steps isn't an array at all", async () => {
    await regSvc();
    const r = await createComposite("flow", undefined, OBJ_SCHEMA, "not-an-array" as unknown as CompositeStep[], "t");
    expect(r).toMatchObject({
      ok: false,
      error: { code: "INVALID_STEPS", message: "A composite needs at least one step" },
    });
  });

  test("UNKNOWN_TOOL, exact message with the client__tool key, for a step referencing a tool that doesn't exist", async () => {
    await regSvc();
    const r = await createComposite(
      "flow",
      undefined,
      OBJ_SCHEMA,
      [{ targetClient: "svc", targetTool: "ghost-tool", argsTemplate: {} }],
      "t",
    );
    expect(r).toMatchObject({
      ok: false,
      error: { code: "UNKNOWN_TOOL", message: 'Unknown tool "svc__ghost-tool"' },
    });
  });
});

describe("createComposite — persistence + cache", () => {
  test("persists description, schema, steps, enabled=true and matching timestamps; populates the live cache", async () => {
    await regSvc();
    const before = Date.now();
    const r = await createComposite(
      "flow",
      "my desc",
      OBJ_SCHEMA,
      [{ targetClient: "svc", targetTool: "first", argsTemplate: { a: 1 } }],
      "tester",
    );
    expect(r.ok).toBe(true);
    const detail = getCompositeDetail("flow");
    expect(detail).toBeDefined();
    expect(detail?.description).toBe("my desc");
    expect(detail?.enabled).toBe(true);
    expect(detail?.inputSchema).toEqual(OBJ_SCHEMA);
    expect(detail?.steps).toEqual([{ targetClient: "svc", targetTool: "first", argsTemplate: { a: 1 } }]);
    expect(detail!.createdAt).toBeGreaterThanOrEqual(before);
    expect(detail!.updatedAt).toBe(detail!.createdAt);
    expect(hasComposite("flow")).toBe(true);
    expect(getAdvertisedComposite("flow")).toEqual({ name: "flow", description: "my desc", inputSchema: OBJ_SCHEMA });
  });

  test("description defaults to null when omitted, and the advertised description falls back to a generated string", async () => {
    await regSvc();
    await createComposite("flow", undefined, OBJ_SCHEMA, oneStep(), "t");
    expect(getCompositeDetail("flow")?.description).toBeNull();
    expect(getAdvertisedComposite("flow")?.description).toBe("Composite tool: flow");
  });

  test("multiple steps persist in step_order, each with its own template", async () => {
    await regSvc();
    const steps: CompositeStep[] = [
      { targetClient: "svc", targetTool: "first", argsTemplate: {} },
      { targetClient: "svc", targetTool: "second", argsTemplate: { itemId: { $ref: "steps.0.json.id" } } },
      { targetClient: "svc", targetTool: "third", argsTemplate: {} },
    ];
    await createComposite("flow", undefined, OBJ_SCHEMA, steps, "t");
    expect(getCompositeDetail("flow")?.steps).toEqual(steps);
  });

  test("calls notifyToolsChanged exactly once on a successful create", async () => {
    await regSvc();
    const spy = spyOn(mcpServerMod, "notifyToolsChanged");
    try {
      await createComposite("flow", undefined, OBJ_SCHEMA, oneStep(), "t");
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("does NOT call notifyToolsChanged when create fails validation", async () => {
    await regSvc();
    const spy = spyOn(mcpServerMod, "notifyToolsChanged");
    try {
      const r = await createComposite("flow", undefined, { type: "string" }, oneStep(), "t");
      expect(r.ok).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("updateComposite — validation branches", () => {
  test("NOT_FOUND for an unknown composite name", async () => {
    const r = await updateComposite("ghost", { enabled: false });
    expect(r).toMatchObject({ ok: false, error: { code: "NOT_FOUND", message: 'Composite "ghost" not found' } });
  });

  test("INVALID_SCHEMA, exact message, when updates.inputSchema is not an object (a number)", async () => {
    await regSvc();
    await createComposite("flow", undefined, OBJ_SCHEMA, oneStep(), "t");
    const r = await updateComposite("flow", { inputSchema: 5 as unknown as Record<string, unknown> });
    expect(r).toMatchObject({
      ok: false,
      error: { code: "INVALID_SCHEMA", message: "inputSchema must be an object schema (type: object)" },
    });
  });

  test("INVALID_SCHEMA when updates.inputSchema is null", async () => {
    await regSvc();
    await createComposite("flow", undefined, OBJ_SCHEMA, oneStep(), "t");
    const r = await updateComposite("flow", { inputSchema: null as unknown as Record<string, unknown> });
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_SCHEMA" } });
  });

  test("INVALID_SCHEMA when updates.inputSchema.type isn't 'object'", async () => {
    await regSvc();
    await createComposite("flow", undefined, OBJ_SCHEMA, oneStep(), "t");
    const r = await updateComposite("flow", { inputSchema: { type: "array" } });
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_SCHEMA" } });
  });

  test("INVALID_SCHEMA rejects a non-object (function) updates.inputSchema even if it has a spoofed .type === 'object' property", async () => {
    // Same convergent-clause concern as createComposite's own INVALID_SCHEMA
    // check (see that describe block's identical test): a function is
    // typeof "function" (not "object") yet can carry its own `.type`
    // property — set it to "object" so only the `typeof !== "object"` clause
    // itself would reject it.
    await regSvc();
    await createComposite("flow", undefined, OBJ_SCHEMA, oneStep(), "t");
    const fakeSchema = function fakeSchema() {} as unknown as Record<string, unknown>;
    (fakeSchema as unknown as { type: string }).type = "object";
    const r = await updateComposite("flow", { inputSchema: fakeSchema });
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_SCHEMA" } });
  });

  test("does not touch the persisted schema when a schema update is rejected", async () => {
    await regSvc();
    await createComposite("flow", undefined, OBJ_SCHEMA, oneStep(), "t");
    await updateComposite("flow", { inputSchema: { type: "array" } });
    expect(getCompositeDetail("flow")?.inputSchema).toEqual(OBJ_SCHEMA);
  });

  test("UNKNOWN_TOOL when updates.steps references a tool that doesn't exist", async () => {
    await regSvc();
    await createComposite("flow", undefined, OBJ_SCHEMA, oneStep(), "t");
    const r = await updateComposite("flow", {
      steps: [{ targetClient: "svc", targetTool: "ghost-tool", argsTemplate: {} }],
    });
    expect(r).toMatchObject({ ok: false, error: { code: "UNKNOWN_TOOL" } });
  });

  test("INVALID_STEPS when updates.steps is an empty array", async () => {
    await regSvc();
    await createComposite("flow", undefined, OBJ_SCHEMA, oneStep(), "t");
    const r = await updateComposite("flow", { steps: [] });
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_STEPS" } });
  });
});

describe("updateComposite — persistence, cache refresh, and scopeChanged notify gating", () => {
  test("a description-only update changes description + updatedAt but does NOT call notifyToolsChanged", async () => {
    await regSvc();
    await createComposite("flow", "orig", OBJ_SCHEMA, oneStep(), "t");
    const before = getCompositeDetail("flow")!;
    await new Promise((r) => setTimeout(r, 2));

    const spy = spyOn(mcpServerMod, "notifyToolsChanged");
    try {
      const r = await updateComposite("flow", { description: "changed" });
      expect(r.ok).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    const after = getCompositeDetail("flow")!;
    expect(after.description).toBe("changed");
    expect(after.enabled).toBe(before.enabled);
    expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
  });

  test("an enabled-only update calls notifyToolsChanged, updates the live cache immediately, and leaves description untouched", async () => {
    await regSvc();
    // A non-null original description matters here: the update transaction's
    // description-write is itself gated on `updates.description !== undefined`
    // and must NOT run at all when the caller only supplied `enabled` — if it
    // did run, it would write the parameter `updates.description` (here
    // `undefined`) into the column, which starting from a non-null value is
    // observably different from "no-op".
    await createComposite("flow", "keep-me", OBJ_SCHEMA, oneStep(), "t");
    expect(getAdvertisedComposite("flow")).toBeDefined();

    const spy = spyOn(mcpServerMod, "notifyToolsChanged");
    try {
      const r = await updateComposite("flow", { enabled: false });
      expect(r.ok).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    expect(getCompositeDetail("flow")?.enabled).toBe(false);
    expect(getCompositeDetail("flow")?.description).toBe("keep-me");
    // Disabled composites are excluded from every advertised-tool read path.
    expect(getAdvertisedComposite("flow")).toBeUndefined();
    // hasComposite is existence-only, independent of enabled.
    expect(hasComposite("flow")).toBe(true);
  });

  test("an inputSchema-only update calls notifyToolsChanged and persists the new schema", async () => {
    await regSvc();
    await createComposite("flow", undefined, OBJ_SCHEMA, oneStep(), "t");
    const newSchema = { type: "object", properties: { x: { type: "string" } } };

    const spy = spyOn(mcpServerMod, "notifyToolsChanged");
    try {
      const r = await updateComposite("flow", { inputSchema: newSchema });
      expect(r.ok).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    expect(getCompositeDetail("flow")?.inputSchema).toEqual(newSchema);
    expect(getAdvertisedComposite("flow")?.inputSchema).toEqual(newSchema);
  });

  test("a steps-only update calls notifyToolsChanged, fully replaces the prior step list (not appends), and reorders correctly", async () => {
    await regSvc();
    await createComposite(
      "flow",
      undefined,
      OBJ_SCHEMA,
      [
        { targetClient: "svc", targetTool: "first", argsTemplate: { old: true } },
        { targetClient: "svc", targetTool: "second", argsTemplate: {} },
      ],
      "t",
    );
    const newSteps: CompositeStep[] = [{ targetClient: "svc", targetTool: "third", argsTemplate: { fresh: 1 } }];

    const spy = spyOn(mcpServerMod, "notifyToolsChanged");
    try {
      const r = await updateComposite("flow", { steps: newSteps });
      expect(r.ok).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    // Not 3 (2 old + 1 new): the old rows were deleted, not left alongside.
    expect(getCompositeDetail("flow")?.steps).toEqual(newSteps);

    const rawStepRows = getDb()
      .query(`SELECT target_tool FROM composite_tool_steps WHERE composite_name = ? ORDER BY step_order`)
      .all("flow") as { target_tool: string }[];
    expect(rawStepRows.map((r) => r.target_tool)).toEqual(["third"]);
  });

  test("a combined update (description + enabled + steps) applies every field in one transaction", async () => {
    await regSvc();
    await createComposite("flow", "orig", OBJ_SCHEMA, oneStep(), "t");
    const newSteps: CompositeStep[] = [{ targetClient: "svc", targetTool: "second", argsTemplate: {} }];

    const r = await updateComposite("flow", { description: "combo", enabled: false, steps: newSteps });
    expect(r.ok).toBe(true);
    const detail = getCompositeDetail("flow")!;
    expect(detail.description).toBe("combo");
    expect(detail.enabled).toBe(false);
    expect(detail.steps).toEqual(newSteps);
  });

  test("update is rejected (NOT_FOUND) before any writes when the composite doesn't exist, even with otherwise-valid steps", async () => {
    await regSvc();
    const r = await updateComposite("ghost", { steps: oneStep() });
    expect(r).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(getCompositeDetail("ghost")).toBeUndefined();
  });
});

describe("deleteComposite", () => {
  test("returns false and does not notify for an unknown name", async () => {
    const spy = spyOn(mcpServerMod, "notifyToolsChanged");
    try {
      expect(await deleteComposite("ghost")).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("returns true, clears the live cache, notifies, and cascade-deletes its steps", async () => {
    await regSvc();
    await createComposite("flow", undefined, OBJ_SCHEMA, oneStep(), "t");
    expect(hasComposite("flow")).toBe(true);

    const spy = spyOn(mcpServerMod, "notifyToolsChanged");
    try {
      expect(await deleteComposite("flow")).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    expect(getCompositeDetail("flow")).toBeUndefined();
    expect(hasComposite("flow")).toBe(false);
    const remainingSteps = getDb().query(`SELECT 1 FROM composite_tool_steps WHERE composite_name = ?`).all("flow");
    expect(remainingSteps.length).toBe(0);
  });

  test("deleting one composite does not affect a different one", async () => {
    await regSvc();
    await createComposite("flow-a", undefined, OBJ_SCHEMA, oneStep(), "t");
    await createComposite("flow-b", undefined, OBJ_SCHEMA, oneStep(), "t");
    expect(await deleteComposite("flow-a")).toBe(true);
    expect(hasComposite("flow-a")).toBe(false);
    expect(hasComposite("flow-b")).toBe(true);
    expect(getCompositeDetail("flow-b")).toBeDefined();
  });
});

describe("listComposites — multi-row narrowing", () => {
  test("listComposites returns every composite ordered by name with the correct per-composite stepsCount (2 distinct items)", async () => {
    await regSvc();
    await createComposite("bbb", "second alpha", OBJ_SCHEMA, oneStep(), "t");
    await createComposite(
      "aaa",
      "first alpha",
      OBJ_SCHEMA,
      [
        { targetClient: "svc", targetTool: "first", argsTemplate: {} },
        { targetClient: "svc", targetTool: "second", argsTemplate: {} },
        { targetClient: "svc", targetTool: "third", argsTemplate: {} },
      ],
      "t",
    );
    const rows = listComposites();
    expect(rows.map((r) => r.name)).toEqual(["aaa", "bbb"]);
    expect(rows.find((r) => r.name === "aaa")?.stepsCount).toBe(3);
    expect(rows.find((r) => r.name === "bbb")?.stepsCount).toBe(1);
    // Both are freshly created (default enabled=1) — a mapping bug that always
    // reports enabled:false wouldn't be caught by the disabled-row test below
    // alone.
    expect(rows.find((r) => r.name === "aaa")?.enabled).toBe(true);
    expect(rows.find((r) => r.name === "bbb")?.enabled).toBe(true);
  });

  test("listComposites reflects enabled=false without excluding the row", async () => {
    await regSvc();
    await createComposite("flow", undefined, OBJ_SCHEMA, oneStep(), "t");
    await updateComposite("flow", { enabled: false });
    const rows = listComposites();
    expect(rows.length).toBe(1);
    expect(rows[0]!.enabled).toBe(false);
  });
});

describe("getCompositeDetail / hasComposite — unknown-name paths", () => {
  test("getCompositeDetail returns undefined for an unknown name", () => {
    expect(getCompositeDetail("nope")).toBeUndefined();
  });
  test("hasComposite returns false for an unknown name", () => {
    expect(hasComposite("nope")).toBe(false);
  });
  test("getAdvertisedComposite returns undefined for an unknown name", () => {
    expect(getAdvertisedComposite("nope")).toBeUndefined();
  });
});

describe("initComposites — boot hydration", () => {
  test("loads a composite's steps from SQLite in step_order after a fresh cache reset, logs the count, and the reloaded steps are real runnable objects (not blanked out)", async () => {
    await regSvc();
    const steps: CompositeStep[] = [
      { targetClient: "svc", targetTool: "third", argsTemplate: { z: 1 } },
      { targetClient: "svc", targetTool: "first", argsTemplate: { a: 2 } },
    ];
    await createComposite("flow", "hydrated", OBJ_SCHEMA, steps, "t");

    const logSpy = spyOn(loggerMod, "log");
    try {
      // Simulate a fresh boot: the cache is cleared and repopulated purely
      // from the DB, independent of the incremental refreshCache() calls
      // triggered by createComposite above.
      initComposites();
      expect(logSpy).toHaveBeenCalledWith("info", "Loaded composite tools", { count: 1 });
    } finally {
      logSpy.mockRestore();
    }

    expect(hasComposite("flow")).toBe(true);
    const advertised = getAdvertisedComposite("flow");
    expect(advertised?.description).toBe("hydrated");
    // Steps aren't part of AdvertisedTool. Prove the rehydrated cache's own
    // step objects are real (correct targetClient/targetTool/argsTemplate per
    // step, in step_order) — not a corrupted mapping (e.g. every step
    // collapsed to `undefined` or `{}`, which would either throw or route to
    // the wrong/no target) — by actually running the composite and
    // inspecting exactly which two dispatch calls were made, in order.
    const proxySpy = spyOn(proxyMod, "proxyToolCall").mockResolvedValue({
      content: [{ type: "text", text: "{}" }],
      isError: false,
    });
    try {
      const result = await runComposite("flow", {});
      expect(result.isError).toBeUndefined();
      expect(proxySpy).toHaveBeenCalledTimes(2);
      expect(proxySpy.mock.calls[0]![0]).toBe("svc__third");
      expect(proxySpy.mock.calls[0]![1]).toEqual({ z: 1 });
      expect(proxySpy.mock.calls[1]![0]).toBe("svc__first");
      expect(proxySpy.mock.calls[1]![1]).toEqual({ a: 2 });
    } finally {
      proxySpy.mockRestore();
    }
  });

  test("a disabled composite stays disabled across a reload", async () => {
    await regSvc();
    await createComposite("flow", undefined, OBJ_SCHEMA, oneStep(), "t");
    await updateComposite("flow", { enabled: false });
    initComposites();
    expect(getAdvertisedComposite("flow")).toBeUndefined();
    expect(hasComposite("flow")).toBe(true);
  });
});

describe("resolveRef / getByPath — edge branches", () => {
  const ctx = {
    input: { a: 1, nested: { b: "x" }, arr: [10, 20], nullField: null },
    steps: [{ text: "hi", json: { id: 1 } }],
  };

  test("an unrecognised $ref head (neither input nor steps) resolves to undefined", () => {
    expect(resolveRef("bogus.a", ctx)).toBeUndefined();
  });

  test("the 'steps' head-check is real: an unrecognised head with a numeric-looking second segment still resolves to undefined", () => {
    // A weaker "bogus.a" case can't discriminate a forced-true `head ===
    // "steps"` mutant, because parts[1]="a" fails the idx-is-integer guard
    // either way. Use a second segment ("0") that WOULD be a valid steps
    // index, so only the head check itself stands between this ref and a
    // real step's `.text`.
    expect(resolveRef("bogus.0.text", ctx)).toBeUndefined();
  });

  test("a non-integer steps index resolves to undefined", () => {
    expect(resolveRef("steps.notanumber.text", ctx)).toBeUndefined();
  });

  test("the steps-index Number.isInteger guard is real (rejects a non-integer index even if a same-named own property exists on the steps array)", () => {
    // A bare NaN-index lookup (`ctx.steps[NaN]`) is `undefined` regardless of
    // the guard, so a forced-true `Number.isInteger` mutant can't be told
    // apart by a plain non-integer-index test. Plant an own property
    // literally named "NaN" on the steps array (arrays are just objects;
    // bracket access with a NaN index string-coerces to "NaN") so the guard's
    // presence is the only thing standing between this ref and that planted
    // value.
    const stepsWithPlant: { text: string; json: unknown }[] = [];
    (stepsWithPlant as unknown as Record<string, unknown>).NaN = { text: "gotcha", json: {} };
    const plantedCtx = { input: {}, steps: stepsWithPlant };
    expect(resolveRef("steps.notanumber.text", plantedCtx)).toBeUndefined();
  });

  test("a steps sub-selector that is neither 'text' nor 'json' resolves to undefined", () => {
    expect(resolveRef("steps.0.somethingElse", ctx)).toBeUndefined();
  });

  test("'input' alone (empty dotpath) resolves to the whole input object", () => {
    expect(resolveRef("input", ctx)).toEqual(ctx.input);
  });

  test("indexing into an array with a non-integer segment resolves to undefined", () => {
    expect(resolveRef("input.arr.notanumber", ctx)).toBeUndefined();
  });

  test("the array-vs-object branch is real: a non-canonical numeric segment ('01') on an array still resolves via Number(seg) coercion, not a literal '01' property", () => {
    // "input.arr.1" alone can't discriminate a forced-false `Array.isArray`
    // mutant: falling through to the plain-object branch does `arr["1"]`,
    // which JS resolves to the very same element as `arr[1]`. A
    // non-canonical numeric string ("01") only matches via the array
    // branch's `Number(seg)` coercion (Number("01") === 1, so this resolves
    // to arr[1]) — a mutant forcing `Array.isArray` to `false` would instead
    // fall to the plain-object branch's literal `arr["01"]` property lookup,
    // which is `undefined` (arrays have no "01" own key).
    expect(resolveRef("input.arr.01", ctx)).toBe(20);
  });

  test("the array Number.isInteger guard is real (a non-integer numeric segment doesn't fall through to a same-named own property)", () => {
    const arrWithPlant: number[] = [10, 20];
    (arrWithPlant as unknown as Record<string, unknown>).NaN = 999;
    const plantedCtx = { input: { arr: arrWithPlant }, steps: [] };
    expect(resolveRef("input.arr.notanumber", plantedCtx)).toBeUndefined();
  });

  test("the `typeof node === 'object'` branch-guard is real: a string primitive with a 'length'-shaped segment resolves to undefined, not the string's own .length", () => {
    // A number primitive (ctx.a, tested below) can't discriminate a
    // forced-true `typeof node === "object"` mutant, because bracket-indexing
    // an arbitrary property name into a boxed Number still yields `undefined`
    // either way. A STRING primitive has real own-like properties visible via
    // bracket access (`.length`, numeric character indices) — picking a
    // segment that resolves to a genuine, non-undefined value only under the
    // (incorrect) object-branch proves the branch-guard itself gates entry.
    const withString = { input: { s: "hi" }, steps: [] };
    expect(resolveRef("input.s.length", withString)).toBeUndefined();
  });

  test("indexing past a null/undefined node short-circuits to undefined", () => {
    expect(resolveRef("input.nullField.deeper", ctx)).toBeUndefined();
  });

  // The `node === undefined` half of `if (node === null || node ===
  // undefined) return undefined;` (getByPath, composites.ts ~line 179) is an
  // accepted EQUIVALENT mutant when that half alone is forced to `false` —
  // verified by tracing the rest of the function: when `node` is genuinely
  // `undefined` and this half is bypassed, execution falls through to
  // `Array.isArray(undefined)` (false) then `typeof undefined === "object"`
  // (false — `typeof undefined` is the distinct primitive "undefined", never
  // "object"), landing in the final `else { return undefined; }` regardless.
  // Every real invocation returns the identical `undefined` whether the
  // early-return guard fires or not. (Contrast with the `node === null`
  // half, which IS load-bearing and already killed elsewhere: `typeof null
  // === "object"` is true in JS, so bypassing that half would instead throw
  // by indexing into `null`.)

  test("indexing a path segment on a primitive (non-object, non-array) node resolves to undefined", () => {
    expect(resolveRef("input.a.deeper", ctx)).toBeUndefined();
  });

  test("a valid array index resolves the element", () => {
    expect(resolveRef("input.arr.1", ctx)).toBe(20);
  });
});

describe("resolveTemplate — non-$ref object shapes and interpolation", () => {
  const ctx = { input: { a: 1, obj: { k: "v" } }, steps: [{ text: "raw", json: { id: 7 } }] };

  test("an object with $ref alongside another key is NOT treated as a $ref shortcut", () => {
    const out = resolveTemplate({ $ref: "input.a", extra: "lit" }, ctx) as Record<string, unknown>;
    // Not shortcut-resolved: the "$ref" key's own string value just passes
    // through string interpolation (no ${...} placeholder in it), and the
    // literal object shape survives.
    expect(out).toEqual({ $ref: "input.a", extra: "lit" });
  });

  test("an object with a `$ref` key whose value isn't a string is NOT treated as a $ref shortcut", () => {
    const out = resolveTemplate({ $ref: 42 }, ctx);
    expect(out).toEqual({ $ref: 42 });
  });

  test("the $ref shortcut requires an ENUMERABLE '$ref' key (Object.keys-based check, not just dot-access presence)", () => {
    // Discriminates a forced-true `keys[0] === "$ref"` mutant: for any
    // ordinary single-key object literal, `node.$ref` is `undefined` unless
    // that one key genuinely IS "$ref" — so a plain object can never show
    // this mutant's effect. Force the split artificially with a
    // non-enumerable "$ref" property: Object.keys/Object.entries (what the
    // real code and its per-key fallback both use) don't see it, but plain
    // dot-access does.
    const obj: Record<string, unknown> = { other: "unused" };
    Object.defineProperty(obj, "$ref", { value: "input.a", enumerable: false });
    const out = resolveTemplate(obj, ctx) as Record<string, unknown>;
    // Correct behaviour: NOT treated as a $ref shortcut (falls through to the
    // per-enumerable-key resolution, i.e. just `{ other: "unused" }`). A
    // mutant that only checks `node.$ref`'s type (ignoring which key
    // Object.keys actually reports) would instead return ctx.input.a (1),
    // via resolveRef("input.a", ctx).
    expect(out).toEqual({ other: "unused" });
  });

  test("resolves arrays element-by-element, recursively", () => {
    const out = resolveTemplate([{ $ref: "input.a" }, "lit ${input.obj.k}", 3], ctx);
    expect(out).toEqual([1, "lit v", 3]);
  });

  test("interpolation substitutes an object value as JSON", () => {
    expect(resolveTemplate("val: ${input.obj}", ctx)).toBe('val: {"k":"v"}');
  });

  test("interpolation substitutes an undefined ref as an empty string", () => {
    expect(resolveTemplate("[${input.missing}]", ctx)).toBe("[]");
  });

  test("interpolation substitutes a null-valued ref as an empty string", () => {
    const withNull = { input: { n: null }, steps: [] };
    expect(resolveTemplate("[${input.n}]", withNull)).toBe("[]");
  });

  test("a plain string with no placeholders passes through unchanged", () => {
    expect(resolveTemplate("just text", ctx)).toBe("just text");
  });

  test("a bare non-string, non-object, non-array primitive passes through unchanged", () => {
    expect(resolveTemplate(42, ctx)).toBe(42);
    expect(resolveTemplate(true, ctx)).toBe(true);
    expect(resolveTemplate(null, ctx)).toBeNull();
  });

  test("multiple placeholders in one string are all substituted", () => {
    expect(resolveTemplate("${input.a}-${steps.0.json.id}", ctx)).toBe("1-7");
  });

  test("interpolation trims whitespace inside the placeholder before resolving (${ input.a } still resolves, not just ${input.a})", () => {
    // Discriminates a mutant that drops the internal `.trim()` call: an
    // untrimmed " input.a " has head " input" (leading space), which the
    // real code's own resolveRef would never match against the literal
    // string "input" — proving trim() actually runs, not just documenting
    // intent.
    expect(resolveTemplate("val=${ input.a }", ctx)).toBe("val=1");
  });
});

describe("runComposite — guard clauses and error paths", () => {
  test("unknown composite name", async () => {
    const result = await runComposite("no-such-composite", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.type).toBe("text");
    expect(result.content[0]!.text).toBe("Unknown composite tool: no-such-composite");
  });

  test("disabled composite, exact message", async () => {
    await regSvc();
    await createComposite("flow", undefined, OBJ_SCHEMA, oneStep(), "t");
    await updateComposite("flow", { enabled: false });
    const result = await runComposite("flow", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.type).toBe("text");
    expect(result.content[0]!.text).toBe("Composite tool 'flow' is disabled");
  });

  test("a composite whose live cache has zero steps (reached via direct DB tampering + reload) reports 'has no steps'", async () => {
    await regSvc();
    await createComposite("flow", undefined, OBJ_SCHEMA, oneStep(), "t");
    // validateSteps forbids ever creating/updating a composite down to zero
    // steps through the admin API — so reach the runner's own defensive
    // guard by manipulating the DB directly underneath it and reloading the
    // cache, exactly as a fresh boot would read it.
    getDb().query(`DELETE FROM composite_tool_steps WHERE composite_name = ?`).run("flow");
    initComposites();
    const result = await runComposite("flow", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.type).toBe("text");
    expect(result.content[0]!.text).toBe("Composite tool 'flow' has no steps");
  });

  test("a step whose resolved args are an array reports 'produced non-object arguments' at the right step number", async () => {
    await regSvc();
    await createComposite(
      "flow",
      undefined,
      OBJ_SCHEMA,
      [{ targetClient: "svc", targetTool: "first", argsTemplate: { $ref: "input.arr" } }],
      "t",
    );
    const result = await runComposite("flow", { arr: [1, 2, 3] });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.type).toBe("text");
    expect(result.content[0]!.text).toBe("Composite 'flow' step 1 produced non-object arguments");
  });

  test("a step whose resolved args are null reports 'produced non-object arguments'", async () => {
    await regSvc();
    await createComposite(
      "flow",
      undefined,
      OBJ_SCHEMA,
      [{ targetClient: "svc", targetTool: "first", argsTemplate: { $ref: "input.missing" } }],
      "t",
    );
    // input.missing resolves via getByPath to undefined, not null — force a
    // genuine null by pointing at a field whose value literally is null.
    const result = await runComposite("flow", { missing: null });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("Composite 'flow' step 1 produced non-object arguments");
  });

  test("a step whose resolved args are a primitive (string) reports 'produced non-object arguments'", async () => {
    await regSvc();
    await createComposite(
      "flow",
      undefined,
      OBJ_SCHEMA,
      [{ targetClient: "svc", targetTool: "first", argsTemplate: { $ref: "input.s" } }],
      "t",
    );
    const result = await runComposite("flow", { s: "just a string" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("Composite 'flow' step 1 produced non-object arguments");
  });

  test("the step-2 non-object-arguments error names step 2, not step 1", async () => {
    await regSvc();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    await createComposite(
      "flow",
      undefined,
      OBJ_SCHEMA,
      [
        { targetClient: "svc", targetTool: "first", argsTemplate: {} },
        { targetClient: "svc", targetTool: "second", argsTemplate: { $ref: "input.arr" } },
      ],
      "t",
    );
    const result = await runComposite("flow", { arr: [9] });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("Composite 'flow' step 2 produced non-object arguments");
  });

  test("a step whose response text isn't valid JSON leaves that step's json undefined without throwing, and downstream refs to it resolve to undefined", async () => {
    await regSvc();
    globalThis.fetch = (async (url: string) =>
      String(url).includes("/first")
        ? new Response("not json at all", { status: 200 })
        : new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch;
    await createComposite(
      "flow",
      undefined,
      OBJ_SCHEMA,
      [
        { targetClient: "svc", targetTool: "first", argsTemplate: {} },
        { targetClient: "svc", targetTool: "second", argsTemplate: { itemId: { $ref: "steps.0.json.id" } } },
      ],
      "t",
    );
    const r = await runComposite("flow", {});
    expect(r.isError).toBeUndefined();
    // itemId resolved to undefined (dropped by JSON.stringify), proving the
    // catch path assigned json = undefined instead of throwing or crashing.
    expect(JSON.parse(r.content[0]!.text)).toEqual({});
  });

  test("underlying-tool failure short-circuits and names the exact failing step + target key + response text", async () => {
    await regSvc();
    globalThis.fetch = (async (url: string) =>
      String(url).includes("/second")
        ? new Response("kaboom", { status: 500 })
        : new Response(JSON.stringify({ id: 1 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch;
    await createComposite(
      "flow",
      undefined,
      OBJ_SCHEMA,
      [
        { targetClient: "svc", targetTool: "first", argsTemplate: {} },
        { targetClient: "svc", targetTool: "second", argsTemplate: {} },
      ],
      "t",
    );
    const result = await runComposite("flow", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.type).toBe("text");
    // The prefix (composite name, step number, target key) is this file's own
    // formatting; the suffix is whatever text the underlying REST dispatch
    // produced, which is proxy.ts's concern, not composites.ts's — assert the
    // exact prefix and just that the underlying message is included.
    expect(result.content[0]!.text.startsWith("Composite 'flow' failed at step 2 (svc__second): ")).toBe(true);
    expect(result.content[0]!.text).toContain("kaboom");
  });

  test("a three-step success returns exactly the LAST step's content, not an earlier one's", async () => {
    await regSvc();
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes("/first"))
        return new Response(JSON.stringify({ tag: "one" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (String(url).includes("/second"))
        return new Response(JSON.stringify({ tag: "two" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      return new Response(JSON.stringify({ tag: "three" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await createComposite(
      "flow",
      undefined,
      OBJ_SCHEMA,
      [
        { targetClient: "svc", targetTool: "first", argsTemplate: {} },
        { targetClient: "svc", targetTool: "second", argsTemplate: {} },
        { targetClient: "svc", targetTool: "third", argsTemplate: {} },
      ],
      "t",
    );
    const result = await runComposite("flow", {});
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual({ tag: "three" });
  });

  test("runComposite defaults args to {} — not left as the caller's original falsy value — via the `args ?? {}` fallback", async () => {
    // Discriminates a mutant that swaps `args ?? {}` for `args && {}`: for
    // any TRUTHY args value (including `{}` itself, which IS truthy in JS)
    // both forms evaluate identically, so a call passing `{}` can never tell
    // them apart. Only a literally falsy `args` (e.g. `undefined`, which a
    // real caller may still pass at runtime despite the parameter's TS type
    // — this exact fallback exists precisely to guard against that) exposes
    // the difference: `undefined ?? {}` is `{}`, but `undefined && {}` stays
    // `undefined`.
    await regSvc();
    globalThis.fetch = (async () =>
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await createComposite(
      "flow",
      undefined,
      OBJ_SCHEMA,
      // The whole argsTemplate is a bare $ref shortcut resolving directly to
      // ctx.input. If ctx.input is genuinely `{}`, this resolves to a valid
      // (empty) object and the step proceeds; if ctx.input was left
      // `undefined`, this resolves to `undefined`, which runComposite's own
      // "produced non-object arguments" guard rejects.
      [{ targetClient: "svc", targetTool: "first", argsTemplate: { $ref: "input" } }],
      "t",
    );
    const result = await runComposite("flow", undefined as unknown as Record<string, unknown>);
    expect(result.isError).toBeUndefined();
  });

  test("extractText filters to only text-type content and joins with a newline (observed via a mocked multi-content step)", async () => {
    // proxyToolCall's real REST/WS dispatch paths only ever synthesize a
    // single `{type:"text"}` content entry (verified by inspection of
    // proxy.ts), so extractText's filter/join logic is unreachable through a
    // genuine REST-backed step — mock proxyToolCall directly (the same
    // technique used by src/routes/__tests__/routes-tools-mutation.test.ts)
    // to feed composites.ts's real extractText function a heterogeneous,
    // multi-item content array and observe how the NEXT step's template
    // actually resolves it.
    await regSvc();
    await createComposite(
      "flow",
      undefined,
      OBJ_SCHEMA,
      [
        { targetClient: "svc", targetTool: "first", argsTemplate: {} },
        { targetClient: "svc", targetTool: "second", argsTemplate: { captured: { $ref: "steps.0.text" } } },
      ],
      "t",
    );
    const proxySpy = spyOn(proxyMod, "proxyToolCall");
    try {
      proxySpy.mockResolvedValueOnce({
        content: [
          { type: "image", text: "should-be-filtered-out" },
          { type: "text", text: "line one" },
          { type: "text", text: "line two" },
        ],
        isError: false,
      });
      proxySpy.mockResolvedValueOnce({ content: [{ type: "text", text: "{}" }], isError: false });

      const result = await runComposite("flow", {});
      expect(result.isError).toBeUndefined();
      expect(proxySpy).toHaveBeenCalledTimes(2);
      const secondCallArgs = proxySpy.mock.calls[1]![1] as Record<string, unknown>;
      expect(secondCallArgs.captured).toBe("line one\nline two");
    } finally {
      proxySpy.mockRestore();
    }
  });

  // The initial `let last = { content: [] }` (composites.ts ~line 264) —
  // both its object-literal shape and its empty-array `content` — is an
  // accepted EQUIVALENT mutant. Traced: `comp.steps.length === 0` is already
  // rejected by the guard directly above, so the `for` loop below always
  // executes at least one iteration, and every iteration unconditionally
  // either (a) returns early (on a template or dispatch error), never
  // reaching the final `return { content: last.content }`, or (b) reassigns
  // `last = result;` before the loop can end. There is no path through this
  // function where the initializer's own value is ever read — replacing it
  // with `{}` (dropping `content` entirely, which would be a type error only
  // TypeScript catches, not JS at runtime) has zero observable effect on any
  // real invocation.

  // The JSON.parse catch block's `json = undefined;` (composites.ts ~line
  // 282) is an accepted EQUIVALENT mutant when its body is emptied. Traced:
  // `json` is declared via `let json: unknown;` with no initializer, so its
  // value is already `undefined` the moment the `try` block starts — the
  // catch handler assigning `undefined` to an already-`undefined` binding is
  // a no-op either way.

  // refreshCache's `if (!detail) { liveComposites.delete(name); return; }`
  // (composites.ts ~line 357) is an accepted EQUIVALENT mutant (both the
  // condition forced to `false` and the block emptied to `{}`). Traced both
  // call sites: createComposite and updateComposite each call refreshCache
  // immediately after their own `txn()` has committed an insert/update for
  // that exact `name` — and both are themselves serialized per-name through
  // the same `withLock(name, ...)` mutex, so no concurrent delete can
  // intervene between the commit and the refresh. `getCompositeDetail(name)`
  // is therefore guaranteed to find the row every real call reaches this
  // line, making the `!detail` branch dead code on every real invocation.
});
