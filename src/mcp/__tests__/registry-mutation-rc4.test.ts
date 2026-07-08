import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import { registry } from "../../mcp/registry.js";
import * as mcpServerMod from "../../mcp/mcp-server.js";
import { __resetDbForTesting, getDb } from "../../db/connection.js";
import type { RestToolDefinition } from "../../mcp/types.js";

// -----------------------------------------------------------------------------
// Stryker mutation backstop — RC4 (registry.ts lines 467-598): the private
// teardownLiveClient helper, unregister(), forgetClient(), and
// reconcileFromDb(). Each describe/test cites the exact line:column, mutator,
// and replacement it targets, per the house convention established across the
// P2 mutation-testing series (see reports/mutation/result.json) and continued
// in the registry.ts RC series (rc1/rc2/rc3/rc5/rc6/rc7/rc8/rc9/rc10).
//
// registry-deleting.test.ts, registry-isdeleting.test.ts, and
// registry-forget-client.test.ts already cover this cluster's happy paths
// (unregister clears toolIndex, isDeleting transitions, forgetClient purges
// SQLite) — this file closes the SPECIFIC gaps Stryker reported surviving,
// mostly concentrated in reconcileFromDb() (lines 537-598), which has NO
// existing test coverage anywhere in the repo before this file.
//
// Harness pattern matches the sibling files registry.test.ts /
// registry-deleting.test.ts / registry-mutation-rc7.test.ts (spyOn on the
// mcp-server module namespace to observe notifyToolsChanged, since it's a
// named import called as a bare identifier inside registry.ts — the same
// technique proxy.ts's own mutation tests use for tool-policies/load-balancer.js's
// incInflight).
// -----------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(overrides: Partial<RestToolDefinition> = {}): RestToolDefinition {
  return {
    name: "get-users",
    method: "GET",
    endpoint: "/users",
    description: "Returns a list of users",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

async function reg(name: string, tools: RestToolDefinition[] = [makeTool()]) {
  await registry.register(name, tools, "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

/** Inserts a client (+ tool) row directly via SQL, bypassing registry.register — simulates
 * another instance's registration that this process's live registry hasn't seen yet. */
function insertDbOnlyClient(name: string, toolName = "get-users", clientEnabled = true, toolEnabled = true) {
  const db = getDb();
  const now = Date.now();
  db.query(
    `INSERT INTO clients (name, ip, health_url, base_url, resolved_ip, retry_non_safe_methods, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(name, "1.2.3.4", "http://example.com/health", "http://example.com", "1.2.3.4", clientEnabled ? 1 : 0, now, now);
  db.query(
    `INSERT INTO tools (client_name, name, method, endpoint, description, input_schema, enabled, created_at, updated_at)
     VALUES (?, ?, 'GET', '/users', 'Returns a list of users', ?, ?, ?, ?)`,
  ).run(name, toolName, JSON.stringify({ type: "object", properties: {} }), toolEnabled ? 1 : 0, now, now);
}

beforeEach(async () => {
  for (const c of registry.listClients()) {
    await registry.unregister(c.name);
  }
  __resetDbForTesting();
});

// ---------------------------------------------------------------------------
// L493:40 BlockStatement->'{}' — teardownLiveClient's toolIndex cleanup loop
// (`for (const tool of client.tools) { this.toolIndex.deleteTool(name, tool.name); }`).
//
// Investigated empirically (by tracing every call site, not by editing
// registry.ts — that file is off-limits for this task): `toolIndex` has
// exactly ONE reader anywhere in the codebase, `resolveTool()` (registry.ts
// L944, confirmed via `grep -n "toolIndex\." src/mcp/registry.ts` — the only
// other hits are the setTool/deleteTool call sites themselves). `resolveTool`
// re-validates every hit against the LIVE `this.clients` map and the live
// client's CURRENT `.tools` array before returning anything:
//   - A torn-down client name that is never reused: `this.clients.get(entry.clientName)`
//     is undefined forever (the `this.clients.delete(name)` two lines below
//     the mutated loop is untouched by this mutant and always runs) ->
//     `resolveTool` returns undefined regardless of whether the stale
//     toolIndex entry still exists.
//   - A torn-down client name that IS reused: `client.tools` always exactly
//     mirrors the LATEST registration (registry-persistence.ts's
//     persistRestRegistration has explicit "full-replace" semantics — tools
//     missing from the new registration are deleted). And register()'s own
//     loop (L350-352) unconditionally re-`setTool`s every one of ITS tools
//     regardless of whether teardown cleaned up first, so any toolName that
//     ends up in `client.tools` has its toolIndex key freshly overwritten
//     either way; any toolName that doesn't is masked by the `client.tools.find`
//     check.
// So this mutant's only real effect is an unbounded `toolIndex` Map leak
// (dead entries for every client ever unregistered without being re-registered
// under the identical name), which has no reachable observable effect through
// the current public API (no size/iteration accessor exists). Below is
// defensive regression coverage for the intended (clean) behavior in both the
// same-name-reuse and different-name-reuse shapes — it does not distinguish
// the mutant (nothing behavioral does, per the above), but pins the contract
// resolveTool relies on so a REGRESSION that removes the `this.clients`/
// `client.tools` cross-checks (which WOULD make the leak observable) is
// still caught here.
// ---------------------------------------------------------------------------
describe("teardownLiveClient — toolIndex cleanup contract (L493, documented equivalent)", () => {
  test("a different client reusing torn-down tool NAMES resolves cleanly to itself, never to the old client", async () => {
    await reg("old-club", [makeTool({ name: "tool-x" }), makeTool({ name: "tool-y" })]);
    await registry.unregister("old-club");
    await reg("new-club", [makeTool({ name: "tool-x" }), makeTool({ name: "tool-y" })]);

    const resolved = registry.resolveTool("new-club__tool-x");
    expect(resolved?.client.name).toBe("new-club");
    expect(resolved?.tool.name).toBe("tool-x");
    // The old client's own key must never resolve again after teardown.
    expect(registry.resolveTool("old-club__tool-x")).toBeUndefined();
  });

  test("re-registering the SAME name with a shrunk tool set drops the removed tool for good", async () => {
    await reg("reuse-svc", [makeTool({ name: "old-tool" }), makeTool({ name: "shared" })]);
    await registry.unregister("reuse-svc");
    await reg("reuse-svc", [makeTool({ name: "shared" })]);

    expect(registry.resolveTool("reuse-svc__old-tool")).toBeUndefined();
    expect(registry.resolveTool("reuse-svc__shared")?.client.name).toBe("reuse-svc");
  });

  // registerMcp() has the exact structural sibling of this cleanup loop for
  // its OWN existing-client-rebuild path (registry.ts L426-431, same single
  // `toolIndex.deleteTool` call feeding the same single `resolveTool` reader)
  // — re-verified there too, in registry-mutation-rc3.test.ts's "existing-
  // client tool-index teardown before rebuild (L426-431, documented
  // equivalent)" block, with the same conclusion for the same reason. A
  // 3-hop chain (unregister -> reuse by a different client -> that client's
  // own re-registration with a shrunk set) is added here as extra regression
  // insurance across both cleanup sites at once, even though — per the above
  // — no chain length changes which mutants this can distinguish.
  test("a 3-hop chain (teardown, reuse by a different client, then that client's own shrink) never resolves stale state", async () => {
    await reg("chain-a", [makeTool({ name: "shared-name" }), makeTool({ name: "a-only" })]);
    await registry.unregister("chain-a");

    await reg("chain-b", [makeTool({ name: "shared-name" }), makeTool({ name: "b-only" })]);
    await reg("chain-b", [makeTool({ name: "shared-name" })]); // shrink: drops "b-only"

    expect(registry.resolveTool("chain-a__shared-name")).toBeUndefined();
    expect(registry.resolveTool("chain-a__a-only")).toBeUndefined();
    expect(registry.resolveTool("chain-b__b-only")).toBeUndefined();
    const resolved = registry.resolveTool("chain-b__shared-name");
    expect(resolved?.client.name).toBe("chain-b");
    expect(resolved?.tool.name).toBe("shared-name");
  });
});

// ---------------------------------------------------------------------------
// L537:89 BlockStatement->'{}' — reconcileFromDb's `dbNames` construction:
// `new Set((db.query(...).all() as {name:string}[]).map((r) => r.name))`.
// If the `.map` callback body were emptied, every mapped value becomes
// `undefined`, so `dbNames` would contain only `undefined` (or nothing
// resembling a real name) instead of the actual client names — meaning a
// real DB-registered client would be wrongly treated as absent from the DB
// and torn down by the very next loop (L545/546).
// ---------------------------------------------------------------------------
describe("reconcileFromDb — dbNames must contain the real client name (L537:89)", () => {
  test("a live client that is also in the DB survives reconcileFromDb (not wrongly torn down)", async () => {
    await reg("stable-svc");
    const result = await registry.reconcileFromDb();

    expect(registry.getClient("stable-svc")).toBeDefined();
    expect(result.removed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// L545/546 (BlockStatement, BooleanLiteral, ConditionalExpression x2) — the
// "remove live clients no longer in DB" loop:
//   for (const name of Array.from(this.clients.keys())) {
//     if (!dbNames.has(name)) {
//       await this.withLock(name, async () => { if (this.teardownLiveClient(name)) removed++; });
//     }
//   }
// ---------------------------------------------------------------------------
describe("reconcileFromDb — removes live clients whose DB row is gone (L545/546)", () => {
  test("a live client deleted from SQLite by 'another instance' is torn down live, removed===1", async () => {
    await reg("ghost-svc", [makeTool({ name: "get-users" })]);
    expect(registry.getClient("ghost-svc")).toBeDefined();

    // Simulate another instance deleting the row directly (bypassing this
    // process's registry entirely).
    getDb().query(`DELETE FROM clients WHERE name = ?`).run("ghost-svc");

    const result = await registry.reconcileFromDb();

    expect(registry.getClient("ghost-svc")).toBeUndefined();
    expect(result.removed).toBe(1);
    expect(result.added).toBe(0);
    expect(result.updated).toBe(0);
  });

  test("negative case: a client that is both live AND still in the DB is NOT removed", async () => {
    await reg("keeper-svc", [makeTool({ name: "get-users" })]);

    const result = await registry.reconcileFromDb();

    expect(registry.getClient("keeper-svc")).toBeDefined();
    expect(result.removed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// L553/554/556/558/560 (BlockStatement, BooleanLiteral, ConditionalExpression,
// ObjectLiteral) — the "hydrate a DB-only client" branch: a row exists in
// SQLite but the client isn't live in THIS process's registry yet.
// ---------------------------------------------------------------------------
describe("reconcileFromDb — hydrates a DB-only client live (L553-560)", () => {
  test("a client that exists only as a SQL row becomes live, added===1, and its tool resolves", async () => {
    insertDbOnlyClient("db-only-svc", "get-users");
    expect(registry.getClient("db-only-svc")).toBeUndefined();

    const result = await registry.reconcileFromDb();

    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);
    expect(result.updated).toBe(0);

    const client = registry.getClient("db-only-svc");
    expect(client).toBeDefined();
    expect(client?.enabled).toBe(true);

    const resolved = registry.resolveTool("db-only-svc__get-users");
    expect(resolved?.client.name).toBe("db-only-svc");
    expect(resolved?.tool.name).toBe("get-users");
  });

  test("an empty registry + empty DB reconciles to a true no-op", async () => {
    const result = await registry.reconcileFromDb();
    expect(result).toEqual({ added: 0, removed: 0, updated: 0 });
  });

  // L556's `if (!persisted) return;` guard: `buildPersistedClientFromDb` can
  // return undefined even for a name that WAS in `dbNames` if the row
  // disappears between the `dbNames` snapshot and the hydrate lock body
  // actually running. Constructed deterministically (no timing race): start
  // reconcileFromDb() without awaiting it yet — since nothing is live, its
  // synchronous prefix runs straight through building `dbNames` and up to
  // `await this.withLock(...)`, returning control to us before the hydrate
  // callback has executed. Deleting the row synchronously right there is
  // guaranteed to land before the callback's own fresh DB read.
  test("a row that vanishes between the dbNames snapshot and the hydrate lock is skipped, not crashed (L556)", async () => {
    insertDbOnlyClient("vanish-svc");

    const p = registry.reconcileFromDb();
    getDb().query(`DELETE FROM clients WHERE name = ?`).run("vanish-svc");
    const result = await p;

    expect(result).toEqual({ added: 0, removed: 0, updated: 0 });
    expect(registry.getClient("vanish-svc")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// L562/563 (LogicalOperator x2, OptionalChaining x2) —
//   status: existing?.status ?? "healthy",
//   consecutive_failures: existing?.consecutive_failures ?? 0,
// in the hydrate branch.
//
// Reachability: `existing = this.clients.get(name)` is read INSIDE the
// withLock callback, but the branch is only entered when the OUTER
// `!this.clients.has(name)` check (taken BEFORE the lock is acquired) was
// true. Since every other path that could make a client live for the same
// `name` (register/registerMcp, and reconcileFromDb's own hydrate branch for
// a concurrent call) goes through the SAME per-name mutex, and the mutex
// serialises callers strictly by call order, `existing` really can become
// defined here only via a genuine concurrent double-hydrate race (two
// overlapping reconcileFromDb() calls for the same not-yet-live name, where
// the second one's callback runs after the first one's `this.clients.set`).
// That race is real (not logically impossible — the outer check happens
// before the lock, i.e. a classic TOCTOU window) but constructing it
// reliably needs no additional test here: even when reached, it does not
// change which of these 4 mutants survive, because of the VALUE domains
// involved (verified by inspecting types.ts, not by editing registry.ts):
//   - OptionalChaining (`existing?.status` / `existing?.consecutive_failures`
//     -> `existing.status` / `existing.consecutive_failures`): in the
//     ordinary (non-racing) hydrate path `existing` IS undefined, so removing
//     the `?.` would throw a TypeError synchronously inside the lock
//     callback, making `reconcileFromDb()` itself reject. The plain hydrate
//     test above (which awaits `reconcileFromDb()` and expects it to resolve
//     with `added: 1`) already kills both OptionalChaining mutants outright.
//   - LogicalOperator, `??` -> `&&`: with `existing` undefined (again, the
//     ordinary path), `undefined && "healthy"` is `undefined` and
//     `undefined && 0` is `undefined` — NOT "healthy"/0. The assertions in
//     the plain hydrate test (`client.status`/`consecutive_failures` are
//     implicitly checked via `client.enabled` today and explicitly below)
//     kill this direction too.
//   - LogicalOperator, `??` -> `||`: THIS direction is a genuinely
//     equivalent mutant, independent of whether the race above is ever
//     constructed. `ClientStatus` (types.ts) is
//     `"healthy" | "degraded" | "unreachable"` — never the empty string —
//     so `x ?? "healthy"` and `x || "healthy"` coincide for every reachable
//     value of `x` (undefined, or any real status). And
//     `consecutive_failures` is a non-negative integer whose ONLY falsy
//     value (0) is exactly the literal fallback (`?? 0`), so
//     `x ?? 0` and `x || 0` coincide for every reachable value of `x` too
//     (0 -> 0 either way; undefined -> 0 either way; any positive int ->
//     itself either way). No test, racy or not, can distinguish `??` from
//     `||` here without a value that is falsy-but-not-nullish and different
//     from the literal default — which these two fields' types can never
//     produce. Documented equivalent; not chased further per the mutant's
//     own "if genuinely unreachable... document as equivalent" guidance
//     (here it's reachable, but value-equivalent, which is the stronger and
//     more directly verifiable of the two claims).
// ---------------------------------------------------------------------------
describe("reconcileFromDb — hydrate defaults status/consecutive_failures (L562/563)", () => {
  test("a freshly hydrated DB-only client gets status 'healthy' and consecutive_failures 0", async () => {
    insertDbOnlyClient("fresh-hydrate-svc");
    await registry.reconcileFromDb();

    const client = registry.getClient("fresh-hydrate-svc");
    expect(client?.status).toBe("healthy");
    expect(client?.consecutive_failures).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// L575-591 — "already live, refresh enable flags" branch: client-level
// `enabled` drift and per-tool `enabled` drift, each direction.
// ---------------------------------------------------------------------------
describe("reconcileFromDb — refreshes a live client's enable flags from SQLite (L575-591)", () => {
  test("client-level: DB enabled=1, live enabled=false -> flips true, updated===1", async () => {
    await reg("client-flag-a", [makeTool({ name: "get-users" })]);
    await registry.setClientEnabled("client-flag-a", false);
    expect(registry.getClient("client-flag-a")?.enabled).toBe(false);

    // Diverge the DB directly (simulating another instance re-enabling it).
    getDb().query(`UPDATE clients SET enabled = 1 WHERE name = ?`).run("client-flag-a");

    const result = await registry.reconcileFromDb();

    expect(registry.getClient("client-flag-a")?.enabled).toBe(true);
    expect(result.updated).toBe(1);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
  });

  test("client-level: DB enabled=0, live enabled=true -> flips false, updated===1", async () => {
    await reg("client-flag-b", [makeTool({ name: "get-users" })]);
    expect(registry.getClient("client-flag-b")?.enabled).toBe(true);

    getDb().query(`UPDATE clients SET enabled = 0 WHERE name = ?`).run("client-flag-b");

    const result = await registry.reconcileFromDb();

    expect(registry.getClient("client-flag-b")?.enabled).toBe(false);
    expect(result.updated).toBe(1);
  });

  test("client-level: no drift is a true no-op, updated===0", async () => {
    await reg("client-flag-c", [makeTool({ name: "get-users" })]);

    const result = await registry.reconcileFromDb();

    expect(registry.getClient("client-flag-c")?.enabled).toBe(true);
    expect(result.updated).toBe(0);
  });

  test("tool-level: DB enabled=1, live tool.enabled=false -> flips true, updated===1", async () => {
    await reg("tool-flag-a", [makeTool({ name: "get-users" })]);
    await registry.setToolEnabled("tool-flag-a", "get-users", false);
    expect(registry.getClient("tool-flag-a")?.tools.find((t) => t.name === "get-users")?.enabled).toBe(false);

    getDb().query(`UPDATE tools SET enabled = 1 WHERE client_name = ? AND name = ?`).run("tool-flag-a", "get-users");

    const result = await registry.reconcileFromDb();

    expect(registry.getClient("tool-flag-a")?.tools.find((t) => t.name === "get-users")?.enabled).toBe(true);
    expect(result.updated).toBe(1);
  });

  test("tool-level: DB enabled=0, live tool.enabled=true -> flips false, updated===1", async () => {
    await reg("tool-flag-b", [makeTool({ name: "get-users" })]);
    expect(registry.getClient("tool-flag-b")?.tools.find((t) => t.name === "get-users")?.enabled).toBe(true);

    getDb().query(`UPDATE tools SET enabled = 0 WHERE client_name = ? AND name = ?`).run("tool-flag-b", "get-users");

    const result = await registry.reconcileFromDb();

    expect(registry.getClient("tool-flag-b")?.tools.find((t) => t.name === "get-users")?.enabled).toBe(false);
    expect(result.updated).toBe(1);
  });

  test("tool-level: no drift is a true no-op, updated===0", async () => {
    await reg("tool-flag-c", [makeTool({ name: "get-users" })]);

    const result = await registry.reconcileFromDb();

    expect(registry.getClient("tool-flag-c")?.tools.find((t) => t.name === "get-users")?.enabled).toBe(true);
    expect(result.updated).toBe(0);
  });

  // L589:13 ConditionalExpression->true — this specific mutant forces ONLY
  // the LEFT operand (`e !== undefined`) to the literal `true`, collapsing
  // `(e !== undefined) && (e !== t.enabled)` to plain `(e !== t.enabled)`.
  // The "no drift" test above (e === t.enabled, both defined) does NOT kill
  // it: `true !== true` is false under the mutant too, same as the real
  // condition. Distinguishing it needs `e === undefined` — a live tool whose
  // name has NO matching row in the DB `tools` table read at L579-586 (e.g.
  // another instance deleted the tool row directly, leaving this process's
  // in-memory client.tools untouched, mirroring how "ghost-svc" above
  // simulates a deleted CLIENT row). Under real code `e !== undefined` is
  // false, short-circuiting the whole condition to false: the tool's enabled
  // flag is left alone and `updated` does not increment. Under this mutant,
  // the condition collapses to `e !== t.enabled` = `undefined !== true` =
  // true, so it wrongly runs `t.enabled = e` (assigning `undefined` into a
  // boolean field) and increments `updated`.
  test("L589:13 ConditionalExpression->true (left operand only): a live tool with NO matching DB row is left untouched, updated===0", async () => {
    await reg("tool-flag-nodbrow", [makeTool({ name: "get-users" })]);
    expect(registry.getClient("tool-flag-nodbrow")?.tools.find((t) => t.name === "get-users")?.enabled).toBe(true);

    // Simulate another instance deleting just the tool row (not the client
    // row) — this process's live client.tools is untouched, so the tool
    // stays live with no corresponding entry in the `toolEnabled` map built
    // from the DB read.
    getDb().query(`DELETE FROM tools WHERE client_name = ? AND name = ?`).run("tool-flag-nodbrow", "get-users");

    const result = await registry.reconcileFromDb();

    expect(registry.getClient("tool-flag-nodbrow")?.tools.find((t) => t.name === "get-users")?.enabled).toBe(true);
    expect(result.updated).toBe(0);
  });

  test("client-level AND tool-level drift together in one call: updated===2", async () => {
    await reg("both-flag-svc", [makeTool({ name: "get-users" })]);
    await registry.setClientEnabled("both-flag-svc", false);
    await registry.setToolEnabled("both-flag-svc", "get-users", false);

    getDb().query(`UPDATE clients SET enabled = 1 WHERE name = ?`).run("both-flag-svc");
    getDb().query(`UPDATE tools SET enabled = 1 WHERE client_name = ? AND name = ?`).run("both-flag-svc", "get-users");

    const result = await registry.reconcileFromDb();

    expect(registry.getClient("both-flag-svc")?.enabled).toBe(true);
    expect(registry.getClient("both-flag-svc")?.tools.find((t) => t.name === "get-users")?.enabled).toBe(true);
    expect(result.updated).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// L596/597 (LogicalOperator x2, EqualityOperator x3, ConditionalExpression,
// ObjectLiteral) —
//   if (added > 0 || removed > 0 || updated > 0) notifyToolsChanged();
//   return { added, removed, updated };
// ---------------------------------------------------------------------------
describe("reconcileFromDb — notifyToolsChanged fires iff something changed (L596/597)", () => {
  test("a total no-op reconcile (nothing added/removed/updated) does NOT broadcast", async () => {
    await reg("noop-svc", [makeTool({ name: "get-users" })]);

    const spy = spyOn(mcpServerMod, "notifyToolsChanged");
    try {
      spy.mockClear();
      const result = await registry.reconcileFromDb();
      expect(result).toEqual({ added: 0, removed: 0, updated: 0 });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("added > 0 alone triggers the broadcast (exactly once — the hydrate branch itself never calls notify)", async () => {
    insertDbOnlyClient("notify-added-svc");

    const spy = spyOn(mcpServerMod, "notifyToolsChanged");
    try {
      spy.mockClear();
      const result = await registry.reconcileFromDb();
      expect(result.added).toBe(1);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  // teardownLiveClient (L502) already broadcasts unconditionally on every
  // actual removal, so a bare `toHaveBeenCalled()` here wouldn't isolate
  // L596's own OR-condition (a mutant that always suppresses L596's call
  // would still show 1 call from teardownLiveClient and slip through). Assert
  // the exact count instead: 1 from teardownLiveClient + 1 from L596's own
  // `removed > 0` branch = 2 total when L596 fires correctly.
  test("removed > 0 alone triggers the broadcast (2 calls: teardownLiveClient's own + L596's)", async () => {
    await reg("notify-removed-svc", [makeTool({ name: "get-users" })]);
    getDb().query(`DELETE FROM clients WHERE name = ?`).run("notify-removed-svc");

    const spy = spyOn(mcpServerMod, "notifyToolsChanged");
    try {
      spy.mockClear();
      const result = await registry.reconcileFromDb();
      expect(result.removed).toBe(1);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  test("updated > 0 alone (enable-flag drift only) triggers the broadcast (exactly once — the refresh branch itself never calls notify)", async () => {
    await reg("notify-updated-svc", [makeTool({ name: "get-users" })]);
    await registry.setClientEnabled("notify-updated-svc", false);
    getDb().query(`UPDATE clients SET enabled = 1 WHERE name = ?`).run("notify-updated-svc");

    const spy = spyOn(mcpServerMod, "notifyToolsChanged");
    try {
      spy.mockClear();
      const result = await registry.reconcileFromDb();
      expect(result.updated).toBe(1);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("return shape is exactly {added, removed, updated} with the right values on a mixed reconcile", async () => {
    // One kept-as-is, one removed, one hydrated -> added:1, removed:1, updated:0.
    await reg("mixed-keep", [makeTool({ name: "get-users" })]);
    await reg("mixed-remove", [makeTool({ name: "get-users" })]);
    getDb().query(`DELETE FROM clients WHERE name = ?`).run("mixed-remove");
    insertDbOnlyClient("mixed-add");

    const result = await registry.reconcileFromDb();

    expect(result).toEqual({ added: 1, removed: 1, updated: 0 });
    expect(registry.getClient("mixed-keep")).toBeDefined();
    expect(registry.getClient("mixed-remove")).toBeUndefined();
    expect(registry.getClient("mixed-add")).toBeDefined();
  });
});
