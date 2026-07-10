/**
 * Stryker mutation backstop for src/admin/config/config-versions.ts — domain 9.
 *
 * A sibling test file already exists at src/__tests__/config-versions.test.ts
 * covering the happy-path CRUD/diff/rollback flows; it is left untouched. This
 * file gap-fills the mutants that survive Stryker against just
 * config-versions.ts: exact field mapping (no swapped/omitted properties),
 * both branches of every early-return guard (`!row`/`!from`/`!other`/`!snap`),
 * the `deleteSnapshot` `.changes > 0` boundary, the exact `to` label string
 * for both the "current" and numeric-snapshot diff targets, the `dryRun:
 * false` literal actually forwarded to importConfig (not left as `true`), and
 * the `actor` argument genuinely forwarded through rollbackToSnapshot into
 * importConfig's own consumer-creation path.
 *
 * Direct import + call against a real (in-memory) DB via __resetDbForTesting
 * — no Express harness; config-versions.ts exports plain functions, no route
 * registration of its own.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { __resetDbForTesting, getDb } from "../../../db/connection.js";
import { registry } from "../../../mcp/registry.js";
import { createConsumer, deleteConsumer, getConsumerByName } from "../../entities/consumers.js";
import {
  createSnapshot,
  listSnapshots,
  getSnapshot,
  deleteSnapshot,
  diffSnapshot,
  rollbackToSnapshot,
} from "../config-versions.js";
import type { RestToolDefinition } from "../../../mcp/types.js";

function makeTool(): RestToolDefinition {
  return {
    name: "get-x",
    method: "GET",
    endpoint: "/x",
    description: "x",
    inputSchema: { type: "object", properties: {} },
  };
}

async function reg(name = "svc"): Promise<void> {
  await registry.register(name, [makeTool()], "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}

beforeEach(async () => {
  __resetDbForTesting();
  for (const c of registry.listClients()) await registry.unregister(c.name);
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
});

describe("config-versions — createSnapshot", () => {
  test("persists the exact label/config/actor and returns a matching summary", async () => {
    await reg();
    const before = Date.now();
    const snap = createSnapshot("baseline-label", "alice");
    const after = Date.now();

    expect(snap.id).toBeGreaterThan(0);
    expect(snap.label).toBe("baseline-label");
    expect(snap.createdBy).toBe("alice");
    expect(snap.createdAt).toBeGreaterThanOrEqual(before);
    expect(snap.createdAt).toBeLessThanOrEqual(after);

    // Verify what actually landed in the DB (not just the in-memory return
    // value) — proves `config` is genuinely exportConfig()'s own result and
    // the insert bound the real label/actor, not a placeholder.
    const row = getDb()
      .query(`SELECT label, config_json, created_at, created_by FROM config_snapshots WHERE id = ?`)
      .get(snap.id) as { label: string; config_json: string; created_at: number; created_by: string | null };
    expect(row.label).toBe("baseline-label");
    expect(row.created_by).toBe("alice");
    expect(row.created_at).toBe(snap.createdAt);
    const parsed = JSON.parse(row.config_json) as { clients: { name: string }[] };
    expect(parsed.clients.some((c) => c.name === "svc")).toBe(true);
  });

  test("accepts a null actor and stores it as null (not coerced to a string)", () => {
    const snap = createSnapshot("no-actor", null);
    expect(snap.createdBy).toBeNull();
    const full = getSnapshot(snap.id);
    expect(full?.createdBy).toBeNull();
  });
});

describe("config-versions — listSnapshots", () => {
  test("returns >=2 distinct snapshots ordered newest-id-first with correct per-row field mapping", () => {
    const first = createSnapshot("first-label", "alice");
    const second = createSnapshot("second-label", "bob");

    const list = listSnapshots();
    expect(list.length).toBeGreaterThanOrEqual(2);
    // second was inserted after first, so it has the higher id and must sort first.
    expect(list[0]).toEqual({
      id: second.id,
      label: "second-label",
      createdAt: second.createdAt,
      createdBy: "bob",
    });
    const firstEntry = list.find((s) => s.id === first.id);
    expect(firstEntry).toEqual({
      id: first.id,
      label: "first-label",
      createdAt: first.createdAt,
      createdBy: "alice",
    });
  });
});

describe("config-versions — getSnapshot", () => {
  test("returns undefined for a non-existent id", () => {
    expect(getSnapshot(999999)).toBeUndefined();
  });

  test("returns the full snapshot (summary fields + parsed config) for an existing id", async () => {
    await reg();
    const snap = createSnapshot("full-detail", "carol");
    const full = getSnapshot(snap.id);
    expect(full).toBeDefined();
    expect(full?.id).toBe(snap.id);
    expect(full?.label).toBe("full-detail");
    expect(full?.createdBy).toBe("carol");
    expect(full?.createdAt).toBe(snap.createdAt);
    expect(full?.config.version).toBe(1);
    expect(full?.config.clients.find((c) => c.name === "svc")).toBeDefined();
  });
});

describe("config-versions — deleteSnapshot", () => {
  test("returns false and changes nothing for a non-existent id", () => {
    const before = listSnapshots().length;
    expect(deleteSnapshot(999999)).toBe(false);
    expect(listSnapshots().length).toBe(before);
  });

  test("returns true and actually removes the row for an existing id", () => {
    const snap = createSnapshot("to-delete", "dave");
    expect(listSnapshots().some((s) => s.id === snap.id)).toBe(true);
    expect(deleteSnapshot(snap.id)).toBe(true);
    expect(getSnapshot(snap.id)).toBeUndefined();
    expect(listSnapshots().some((s) => s.id === snap.id)).toBe(false);
  });
});

describe("config-versions — diffSnapshot", () => {
  test("returns undefined when the primary snapshot id doesn't exist", () => {
    expect(diffSnapshot(999999, "current")).toBeUndefined();
  });

  test("against 'current' compares to the live config and echoes the exact 'current' label + from-summary", async () => {
    await reg();
    const snap = createSnapshot("vs-current", "erin");
    await registry.setToolEnabled("svc", "get-x", false);

    const result = diffSnapshot(snap.id, "current");
    expect(result).toBeDefined();
    expect(result?.to).toBe("current");
    expect(result?.from).toEqual({
      id: snap.id,
      label: "vs-current",
      createdAt: snap.createdAt,
      createdBy: "erin",
    });
    expect(result?.entries.some((e) => e.before === true && e.after === false)).toBe(true);
  });

  test("against a missing other-snapshot id returns undefined", async () => {
    await reg();
    const snap = createSnapshot("vs-missing-other", "f");
    expect(diffSnapshot(snap.id, 999999)).toBeUndefined();
  });

  test("against another existing snapshot compares to ITS config and formats the label as '#<id> <label>'", async () => {
    await reg();
    const snapA = createSnapshot("snap-a", "g");
    await registry.setToolEnabled("svc", "get-x", false);
    const snapB = createSnapshot("snap-b", "h");

    const result = diffSnapshot(snapA.id, snapB.id);
    expect(result).toBeDefined();
    expect(result?.to).toBe(`#${snapB.id} snap-b`);
    expect(result?.entries.some((e) => e.before === true && e.after === false)).toBe(true);
  });
});

describe("config-versions — rollbackToSnapshot", () => {
  test("returns undefined for a non-existent snapshot id (and never applies anything)", async () => {
    expect(await rollbackToSnapshot(999999, "someone")).toBeUndefined();
  });

  test("re-applies (dryRun:false, not a plan) the snapshot's config to an existing client/tool", async () => {
    await reg();
    const snap = createSnapshot("rollback-target", "i");
    await registry.setToolEnabled("svc", "get-x", false);
    expect(registry.getClientDetail("svc")?.tools[0].enabled).toBe(false);

    const result = await rollbackToSnapshot(snap.id, "i");
    expect(result).toBeDefined();
    // Proves the literal passed to importConfig is `false` (a real apply),
    // not `true` (a no-op dry-run plan) — importConfig echoes back its own
    // `dryRun` input on the result.
    expect(result?.dryRun).toBe(false);
    expect(registry.getClientDetail("svc")?.tools[0].enabled).toBe(true);
  });

  test("forwards the actor argument through to importConfig's own entity-creation path", async () => {
    await reg();
    // Seed a consumer so it round-trips through exportConfig() into the
    // snapshot, then delete it from the DB so importConfig's "unknown
    // consumer" branch (a fresh createConsumer call, which stores its
    // `actor` argument as created_by) runs on rollback rather than the
    // existing-consumer update branch (which never touches actor at all).
    const seeded = createConsumer({ name: "acme", monthlyQuota: null, endUserRateLimitPerMin: null, actor: "seed" });
    const snap = createSnapshot("with-consumer", "seed");
    expect(deleteConsumer(seeded.id)).toBe(true);
    expect(getConsumerByName("acme")).toBeNull();

    const result = await rollbackToSnapshot(snap.id, "rollback-actor");
    expect(result).toBeDefined();
    expect(result?.applied.consumers).toBe(1);
    const recreated = getConsumerByName("acme");
    expect(recreated).not.toBeNull();
    expect(recreated?.createdBy).toBe("rollback-actor");
  });
});
