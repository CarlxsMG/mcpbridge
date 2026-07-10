/**
 * Stryker mutation-testing backstop for src/lib/tool-config.ts.
 *
 * No prior test file exists for this module. `toolExists` is exercised
 * against the real `tools` table (via `registry.register`, mirroring the
 * exact idiom other tool-policies mutation tests already use to populate
 * it), since the query is hardcoded against that one table. `upsertConfig`
 * is generic over table/column names, so it's exercised against two
 * dedicated test-only tables (created directly in this file via raw SQL
 * after each DB reset) rather than coupling this test to some other
 * domain's production schema — one single-key-column (per-client) shape
 * and one compound-key (per-client+tool) shape, matching the two shapes
 * every real call site actually uses.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { getDb, __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { toolExists, upsertConfig } from "../tool-config.js";
import type { RestToolDefinition } from "../../mcp/types.js";

const CLIENT = "tool-config-mutation-client";

function makeTool(name: string): RestToolDefinition {
  return {
    name,
    method: "POST",
    endpoint: `/${name}`,
    description: "x",
    inputSchema: { type: "object", properties: {} },
  };
}

async function reg(...names: string[]): Promise<void> {
  await registry.register(
    CLIENT,
    (names.length ? names : ["tool-a"]).map((n) => makeTool(n)),
    "http://1.2.3.4/health",
    "1.2.3.4",
    "http://1.2.3.4",
    "1.2.3.4",
  );
}

/** Two throwaway config tables mirroring the two real shapes upsertConfig serves. */
function ensureTestTables(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS test_per_client_config (
      client_name TEXT PRIMARY KEY,
      label       TEXT,
      count       INTEGER,
      updated_at  INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS test_per_tool_config (
      client_name TEXT NOT NULL,
      tool_name   TEXT NOT NULL,
      label       TEXT,
      count       INTEGER,
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (client_name, tool_name)
    ) STRICT;
  `);
}

beforeEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
  ensureTestTables();
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
});

describe("toolExists", () => {
  test("true for a registered tool of an existing client", async () => {
    await reg("tool-a");
    expect(toolExists(CLIENT, "tool-a")).toBe(true);
  });

  test("false when the client itself does not exist", () => {
    expect(toolExists("no-such-client", "tool-a")).toBe(false);
  });

  test("false for an unregistered tool name of an existing (and non-empty) client", async () => {
    await reg("tool-a");
    expect(toolExists(CLIENT, "tool-b")).toBe(false);
  });

  test("distinguishes between two distinct tools of the same client", async () => {
    await reg("tool-a", "tool-b");
    expect(toolExists(CLIENT, "tool-a")).toBe(true);
    expect(toolExists(CLIENT, "tool-b")).toBe(true);
    expect(toolExists(CLIENT, "tool-c")).toBe(false); // neither registered tool matches
  });
});

describe("upsertConfig — single key column (per-client) table", () => {
  test("inserts a new row with the given key/value columns and updatedAt", () => {
    upsertConfig("test_per_client_config", { client_name: "c1" }, { label: "a", count: 1 }, 1000);

    const row = getDb()
      .query(`SELECT client_name, label, count, updated_at FROM test_per_client_config WHERE client_name = ?`)
      .get("c1");
    expect(row).toEqual({ client_name: "c1", label: "a", count: 1, updated_at: 1000 });
  });

  test("a second call with the same key updates the existing row in place (no duplicate row)", () => {
    upsertConfig("test_per_client_config", { client_name: "c1" }, { label: "a", count: 1 }, 1000);
    upsertConfig("test_per_client_config", { client_name: "c1" }, { label: "b", count: 2 }, 2000);

    const rows = getDb().query(`SELECT client_name, label, count, updated_at FROM test_per_client_config`).all();
    expect(rows).toEqual([{ client_name: "c1", label: "b", count: 2, updated_at: 2000 }]);
  });

  test("a different key creates an independent second row, leaving the first untouched", () => {
    upsertConfig("test_per_client_config", { client_name: "c1" }, { label: "a", count: 1 }, 1000);
    upsertConfig("test_per_client_config", { client_name: "c2" }, { label: "z", count: 9 }, 1500);

    const rows = getDb()
      .query(`SELECT client_name, label, count FROM test_per_client_config ORDER BY client_name`)
      .all();
    expect(rows).toEqual([
      { client_name: "c1", label: "a", count: 1 },
      { client_name: "c2", label: "z", count: 9 },
    ]);
  });

  test("a null value column round-trips as null, not coerced", () => {
    upsertConfig("test_per_client_config", { client_name: "c1" }, { label: null, count: null }, 1000);

    const row = getDb().query(`SELECT label, count FROM test_per_client_config WHERE client_name = ?`).get("c1");
    expect(row).toEqual({ label: null, count: null });
  });
});

describe("upsertConfig — compound key (per-client+tool) table", () => {
  test("keys on ALL key columns together, not just the first", () => {
    upsertConfig("test_per_tool_config", { client_name: "c1", tool_name: "t1" }, { label: "a", count: 1 }, 1000);
    upsertConfig("test_per_tool_config", { client_name: "c1", tool_name: "t2" }, { label: "b", count: 2 }, 1000); // same client, different tool
    upsertConfig("test_per_tool_config", { client_name: "c2", tool_name: "t1" }, { label: "c", count: 3 }, 1000); // same tool name, different client

    const rows = getDb()
      .query(`SELECT client_name, tool_name, label, count FROM test_per_tool_config ORDER BY client_name, tool_name`)
      .all();
    expect(rows).toEqual([
      { client_name: "c1", tool_name: "t1", label: "a", count: 1 },
      { client_name: "c1", tool_name: "t2", label: "b", count: 2 },
      { client_name: "c2", tool_name: "t1", label: "c", count: 3 },
    ]);
  });

  test("upserting the exact same compound key updates in place (no duplicate row)", () => {
    upsertConfig("test_per_tool_config", { client_name: "c1", tool_name: "t1" }, { label: "a", count: 1 }, 1000);
    upsertConfig("test_per_tool_config", { client_name: "c1", tool_name: "t1" }, { label: "z", count: 99 }, 2000);

    const rows = getDb()
      .query(`SELECT client_name, tool_name, label, count, updated_at FROM test_per_tool_config`)
      .all();
    expect(rows).toEqual([{ client_name: "c1", tool_name: "t1", label: "z", count: 99, updated_at: 2000 }]);
  });
});
