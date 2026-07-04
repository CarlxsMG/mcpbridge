/**
 * Horizontal-scaling primitives: SQLite-backed shared rate counters and
 * cross-instance registry reconciliation.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { __resetDbForTesting, getDb } from "../db/connection.js";
import { registry } from "../mcp/registry.js";
import {
  checkSharedRateLimit,
  checkSharedToolRateLimit,
  checkSharedEndUserRateLimit,
  __clearRateCountersForTesting,
} from "../db/rate-counters.js";
import type { RestToolDefinition } from "../mcp/types.js";

function makeTool(name = "get-x"): RestToolDefinition {
  return {
    name,
    method: "GET",
    endpoint: `/${name}`,
    description: name,
    inputSchema: { type: "object", properties: {} },
  };
}

/** Simulates a peer instance having registered a client by writing its rows directly. */
function insertPeerClient(name: string, toolName: string): void {
  const db = getDb();
  const now = Date.now();
  db.query(
    `INSERT INTO clients (name, ip, health_url, base_url, resolved_ip, retry_non_safe_methods, enabled, kind, created_at, updated_at)
     VALUES (?, '9.9.9.9', 'http://9.9.9.9/health', 'http://9.9.9.9', '9.9.9.9', 0, 1, 'rest', ?, ?)`,
  ).run(name, now, now);
  db.query(
    `INSERT INTO tools (client_name, name, method, endpoint, description, input_schema, enabled, created_at, updated_at)
     VALUES (?, ?, 'GET', '/x', 'peer tool', '{"type":"object","properties":{}}', 1, ?, ?)`,
  ).run(name, toolName, now, now);
}

beforeEach(async () => {
  __resetDbForTesting();
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __clearRateCountersForTesting();
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
});

describe("shared rate counters", () => {
  test("allows up to the limit, rejects beyond, within one window", () => {
    const now = 1_000_000;
    expect(checkSharedRateLimit("k", 2, 60_000, now).allowed).toBe(true);
    expect(checkSharedRateLimit("k", 2, 60_000, now).allowed).toBe(true);
    const third = checkSharedRateLimit("k", 2, 60_000, now);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSeconds).toBeGreaterThan(0);
  });

  test("counter resets in the next window", () => {
    const now = 1_000_000;
    checkSharedRateLimit("k", 1, 60_000, now);
    expect(checkSharedRateLimit("k", 1, 60_000, now).allowed).toBe(false);
    // Advance to the next 60s window.
    expect(checkSharedRateLimit("k", 1, 60_000, now + 60_000).allowed).toBe(true);
  });

  test("checkSharedToolRateLimit keys per tool", () => {
    const now = 2_000_000;
    expect(checkSharedToolRateLimit("svc__a", 1, now).allowed).toBe(true);
    expect(checkSharedToolRateLimit("svc__a", 1, now).allowed).toBe(false);
    // A different tool has an independent counter.
    expect(checkSharedToolRateLimit("svc__b", 1, now).allowed).toBe(true);
  });

  test("checkSharedEndUserRateLimit keys per consumer+end-user, independent of each other", () => {
    const now = 3_000_000;
    expect(checkSharedEndUserRateLimit(1, "alice", 1, now).allowed).toBe(true);
    expect(checkSharedEndUserRateLimit(1, "alice", 1, now).allowed).toBe(false);
    // Same raw end-user id under a different consumer does not share a bucket.
    expect(checkSharedEndUserRateLimit(2, "alice", 1, now).allowed).toBe(true);
    // A different end-user under the same consumer has an independent counter.
    expect(checkSharedEndUserRateLimit(1, "bob", 1, now).allowed).toBe(true);
  });
});

describe("registry reconciliation", () => {
  async function reg(name: string): Promise<void> {
    await registry.register(name, [makeTool()], "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
  }

  test("picks up a client another instance registered", async () => {
    await reg("a");
    insertPeerClient("peer", "do-thing");
    expect(registry.getClient("peer")).toBeUndefined();

    const result = await registry.reconcileFromDb();
    expect(result.added).toBe(1);
    expect(registry.getClient("peer")).toBeDefined();
    expect(registry.resolveTool("peer__do-thing")?.tool.name).toBe("do-thing");
  });

  test("removes a client another instance forgot", async () => {
    await reg("gone");
    // Peer deletes the client's rows out of band.
    getDb().query(`DELETE FROM clients WHERE name = ?`).run("gone");

    const result = await registry.reconcileFromDb();
    expect(result.removed).toBe(1);
    expect(registry.getClient("gone")).toBeUndefined();
  });

  test("propagates an enable-flag change made by a peer", async () => {
    await reg("c");
    expect(registry.getClient("c")?.enabled).toBe(true);
    getDb().query(`UPDATE clients SET enabled = 0 WHERE name = ?`).run("c");

    const result = await registry.reconcileFromDb();
    expect(result.updated).toBeGreaterThanOrEqual(1);
    expect(registry.getClient("c")?.enabled).toBe(false);
  });

  test("no-op reconcile reports nothing changed", async () => {
    await reg("a");
    // First reconcile refreshes flags (no diff) -> 0.
    expect(await registry.reconcileFromDb()).toEqual({ added: 0, removed: 0, updated: 0 });
  });
});
