/**
 * Finding #18: exportConfig must carry each bundle's composite (macro) tool
 * membership so a bundle round-trips losslessly through export -> import.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { __resetDbForTesting } from "../../../db/connection.js";
import { createBundle, getBundleDetail, deleteBundle } from "../../tool-composition/bundles.js";
import { createComposite } from "../../tool-composition/composites.js";
import { exportConfig, importConfig } from "../config-io.js";
import { clearRegistry, registerTestClient } from "../../../__tests__/_utils/registry.js";

beforeEach(async () => {
  __resetDbForTesting();
  await clearRegistry();
});
afterEach(async () => {
  await clearRegistry();
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
    await registerTestClient();
    await seedComposite();
    const r = await createBundle("bnd", "d", [{ client: "svc", tool: "get-users" }], "t", ["macro1"]);
    expect(r.ok).toBe(true);

    const doc = exportConfig();
    const bnd = doc.bundles.find((b) => b.name === "bnd");
    expect(bnd?.composites).toEqual(["macro1"]);
  });

  test("import (create path) restores composites", async () => {
    await registerTestClient();
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
    await registerTestClient();
    await seedComposite();
    await createBundle("bnd", "d", [{ client: "svc", tool: "get-users" }], "t", ["macro1"]);
    const doc = exportConfig();

    // Bundle still exists; import should take the update path and re-apply composites.
    const result = await importConfig(doc, { dryRun: false }, "t");
    expect(result.applied.bundles).toBe(1);
    expect(getBundleDetail("bnd")?.composites).toEqual(["macro1"]);
  });

  test("a bundle document with no composites field imports cleanly (back-compat)", async () => {
    await registerTestClient();
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
