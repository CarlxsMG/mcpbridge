/**
 * Finding #18: exportConfig must carry each bundle's composite (macro) tool
 * membership so a bundle round-trips losslessly through export -> import.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { __resetDbForTesting } from "../../../db/connection.js";
import { registry } from "../../../mcp/registry.js";
import { createBundle, getBundleDetail, deleteBundle } from "../../tool-composition/bundles.js";
import { createComposite } from "../../tool-composition/composites.js";
import { exportConfig, importConfig } from "../config-io.js";
import type { RestToolDefinition } from "../../../mcp/types.js";

function makeTool(name = "get-users"): RestToolDefinition {
  return {
    name,
    method: "GET",
    endpoint: "/users",
    description: "list",
    inputSchema: { type: "object", properties: {} },
  };
}
async function reg(): Promise<void> {
  await registry.register("svc", [makeTool()], "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

beforeEach(async () => {
  __resetDbForTesting();
  for (const c of registry.listClients()) await registry.unregister(c.name);
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
});

async function seedComposite(): Promise<void> {
  const r = await createComposite(
    "macro1",
    "a macro",
    { type: "object", properties: {} },
    [{ targetClient: "svc", targetTool: "get-users", argsTemplate: {} }],
    "t",
  );
  expect(r.ok).toBe(true);
}

describe("bundle composites round-trip (#18)", () => {
  test("export carries composites", async () => {
    await reg();
    await seedComposite();
    const r = await createBundle("bnd", "d", [{ client: "svc", tool: "get-users" }], "t", ["macro1"]);
    expect(r.ok).toBe(true);

    const doc = exportConfig();
    const bnd = doc.bundles.find((b) => b.name === "bnd");
    expect(bnd?.composites).toEqual(["macro1"]);
  });

  test("import (create path) restores composites", async () => {
    await reg();
    await seedComposite();
    await createBundle("bnd", "d", [{ client: "svc", tool: "get-users" }], "t", ["macro1"]);
    const doc = exportConfig();

    // Drop the bundle so import takes the create path, then re-import.
    expect(await deleteBundle("bnd")).toBe(true);
    expect(getBundleDetail("bnd")).toBeUndefined();

    const result = await importConfig(doc, { dryRun: false }, "t");
    expect(result.applied.bundles).toBe(1);
    expect(getBundleDetail("bnd")?.composites).toEqual(["macro1"]);
  });

  test("import (update path) restores composites onto an existing bundle", async () => {
    await reg();
    await seedComposite();
    await createBundle("bnd", "d", [{ client: "svc", tool: "get-users" }], "t", ["macro1"]);
    const doc = exportConfig();

    // Bundle still exists; import should take the update path and re-apply composites.
    const result = await importConfig(doc, { dryRun: false }, "t");
    expect(result.applied.bundles).toBe(1);
    expect(getBundleDetail("bnd")?.composites).toEqual(["macro1"]);
  });

  test("a bundle document with no composites field imports cleanly (back-compat)", async () => {
    await reg();
    const doc = {
      version: 1,
      exportedAt: Date.now(),
      bundles: [{ name: "bnd", description: null, enabled: true, tools: [{ client: "svc", tool: "get-users" }] }],
      alertRules: [],
      clients: [],
      guardrails: [],
      consumers: [],
    };
    const result = await importConfig(doc, { dryRun: false }, "t");
    expect(result.applied.bundles).toBe(1);
    expect(getBundleDetail("bnd")?.composites).toEqual([]);
  });
});
