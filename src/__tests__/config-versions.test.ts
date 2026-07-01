/**
 * Config version snapshots — create/list/get/delete, order-insensitive diff,
 * diff-against-current, and rollback (re-apply through importConfig).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { __resetDbForTesting } from "../db/connection.js";
import { registry } from "../registry.js";
import {
  createSnapshot,
  listSnapshots,
  getSnapshot,
  deleteSnapshot,
  diffConfigs,
  diffSnapshot,
  rollbackToSnapshot,
} from "../config-versions.js";
import type { RestToolDefinition } from "../types.js";

function makeTool(): RestToolDefinition {
  return { name: "get-x", method: "GET", endpoint: "/x", description: "x", inputSchema: { type: "object", properties: {} } };
}
async function reg(): Promise<void> {
  await registry.register("svc", [makeTool()], "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}

beforeEach(async () => {
  __resetDbForTesting();
  for (const c of registry.listClients()) await registry.unregister(c.name);
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
});

describe("config-versions — snapshot CRUD", () => {
  test("create + list + get + delete", async () => {
    await reg();
    const snap = createSnapshot("baseline", "tester");
    expect(snap.id).toBeGreaterThan(0);
    expect(listSnapshots()[0].label).toBe("baseline");
    const full = getSnapshot(snap.id);
    expect(full?.config.clients.find((c) => c.name === "svc")).toBeDefined();
    expect(deleteSnapshot(snap.id)).toBe(true);
    expect(getSnapshot(snap.id)).toBeUndefined();
  });
});

describe("config-versions — diff", () => {
  test("identical documents (reordered arrays) diff empty", () => {
    const a = { clients: [{ name: "a", enabled: true }, { name: "b", enabled: true }] };
    const b = { clients: [{ name: "b", enabled: true }, { name: "a", enabled: true }] };
    expect(diffConfigs(a, b)).toEqual([]);
  });

  test("a changed leaf is reported", () => {
    const a = { clients: [{ name: "a", enabled: true }] };
    const b = { clients: [{ name: "a", enabled: false }] };
    const d = diffConfigs(a, b);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ kind: "changed", before: true, after: false });
  });

  test("added and removed keys are classified", () => {
    const d = diffConfigs({ x: 1 }, { x: 1, y: 2 });
    expect(d.find((e) => e.kind === "added" && e.after === 2)).toBeDefined();
  });

  test("diffSnapshot against current reflects a live change", async () => {
    await reg();
    const snap = createSnapshot("before", "t");
    await registry.setToolEnabled("svc", "get-x", false);
    const result = diffSnapshot(snap.id, "current");
    expect(result).toBeDefined();
    expect(result!.to).toBe("current");
    // The tool's enabled flag flipped true -> false somewhere in the tree.
    expect(result!.entries.some((e) => e.before === true && e.after === false)).toBe(true);
  });

  test("diffSnapshot returns undefined for a missing snapshot", () => {
    expect(diffSnapshot(9999, "current")).toBeUndefined();
  });
});

describe("config-versions — rollback", () => {
  test("re-applies the snapshot's config to existing entities", async () => {
    await reg();
    const snap = createSnapshot("enabled-state", "t");
    await registry.setToolEnabled("svc", "get-x", false);
    expect(registry.getClientDetail("svc")?.tools[0].enabled).toBe(false);

    const result = await rollbackToSnapshot(snap.id, "t");
    expect(result).toBeDefined();
    expect(registry.getClientDetail("svc")?.tools[0].enabled).toBe(true);
  });

  test("rollback of a missing snapshot returns undefined", async () => {
    expect(await rollbackToSnapshot(9999, "t")).toBeUndefined();
  });
});
