import { describe, test, expect, beforeEach } from "bun:test";
import { __resetDbForTesting, getDb } from "../../db/connection.js";
import {
  createMcpKey,
  listMcpKeys,
  getMcpKey,
  updateMcpKey,
  revokeMcpKey,
  deleteMcpKey,
  resolveMcpKeyByToken,
  isToolInKeyScope,
  isClientInKeyScope,
  touchMcpKeyLastUsed,
  hasAnyMcpKeys,
} from "../../security/mcp-key-store.js";

beforeEach(() => {
  __resetDbForTesting();
});

// consumer_id is an FK to consumers(id); create a real row to reference.
function makeConsumer(name: string): number {
  const now = Date.now();
  const row = getDb()
    .query(`INSERT INTO consumers (name, monthly_quota, created_at, updated_at, created_by) VALUES (?, NULL, ?, ?, ?) RETURNING id`)
    .get(name, now, now, null) as { id: number };
  return row.id;
}

describe("mcp-key-store", () => {
  test("createMcpKey returns a raw key once and never stores it verbatim", () => {
    const { record, rawKey } = createMcpKey("ci", null, null, "tester");
    expect(rawKey.startsWith("mcp_")).toBe(true);
    expect(record.keyPrefix).toBe(rawKey.slice(0, 12));
    expect(record.enabled).toBe(true);
    expect(record.createdBy).toBe("tester");

    const listed = listMcpKeys();
    expect(listed).toHaveLength(1);
    // The listing must never leak the raw secret.
    expect(JSON.stringify(listed[0])).not.toContain(rawKey);
  });

  test("resolveMcpKeyByToken matches the raw key and rejects unknown tokens", () => {
    const { rawKey, record } = createMcpKey("k", null, null, null);
    expect(resolveMcpKeyByToken(rawKey)?.id).toBe(record.id);
    expect(resolveMcpKeyByToken("mcp_nope")).toBeNull();
    expect(resolveMcpKeyByToken("")).toBeNull();
  });

  test("resolve returns null for disabled, revoked, and expired keys", () => {
    const a = createMcpKey("disabled", null, null, null);
    updateMcpKey(a.record.id, { enabled: false });
    expect(resolveMcpKeyByToken(a.rawKey)).toBeNull();

    const b = createMcpKey("revoked", null, null, null);
    revokeMcpKey(b.record.id);
    expect(resolveMcpKeyByToken(b.rawKey)).toBeNull();

    const c = createMcpKey("expired", null, Date.now() - 1000, null);
    expect(resolveMcpKeyByToken(c.rawKey)).toBeNull();

    const d = createMcpKey("future", null, Date.now() + 60_000, null);
    expect(resolveMcpKeyByToken(d.rawKey)?.id).toBe(d.record.id);
  });

  test("scopes normalize: empty arrays collapse to unrestricted (null)", () => {
    const { record } = createMcpKey("k", { clients: [], tools: [] }, null, null);
    expect(record.scopes).toBeNull();
  });

  test("scopes dedupe and persist", () => {
    const { record } = createMcpKey("k", { clients: ["svc", "svc"], tools: ["svc__t"] }, null, null);
    expect(record.scopes).toEqual({ clients: ["svc"], tools: ["svc__t"] });
  });

  test("isToolInKeyScope enforces client and tool grants", () => {
    expect(isToolInKeyScope(null, "svc", "svc__t")).toBe(true);
    expect(isToolInKeyScope({ clients: ["svc"] }, "svc", "svc__t")).toBe(true);
    expect(isToolInKeyScope({ clients: ["other"] }, "svc", "svc__t")).toBe(false);
    expect(isToolInKeyScope({ tools: ["svc__t"] }, "svc", "svc__t")).toBe(true);
    expect(isToolInKeyScope({ tools: ["svc__other"] }, "svc", "svc__t")).toBe(false);
  });

  test("revoke is idempotent-safe and updates state", () => {
    const { record } = createMcpKey("k", null, null, null);
    expect(revokeMcpKey(record.id)).toBe(true);
    expect(revokeMcpKey(record.id)).toBe(false);
    expect(getMcpKey(record.id)?.revokedAt).not.toBeNull();
    expect(getMcpKey(record.id)?.enabled).toBe(false);
  });

  test("delete removes the key", () => {
    const { record } = createMcpKey("k", null, null, null);
    expect(deleteMcpKey(record.id)).toBe(true);
    expect(getMcpKey(record.id)).toBeNull();
    expect(deleteMcpKey(record.id)).toBe(false);
  });

  test("hasAnyMcpKeys reflects presence", () => {
    expect(hasAnyMcpKeys()).toBe(false);
    createMcpKey("k", null, null, null);
    expect(hasAnyMcpKeys()).toBe(true);
  });

  test("updateMcpKey merges partial updates", () => {
    const { record } = createMcpKey("orig", { clients: ["a"] }, null, null);
    const renamed = updateMcpKey(record.id, { label: "renamed" });
    expect(renamed?.label).toBe("renamed");
    expect(renamed?.scopes).toEqual({ clients: ["a"] });

    const rescoped = updateMcpKey(record.id, { scopes: { tools: ["a__t"] } });
    expect(rescoped?.scopes).toEqual({ tools: ["a__t"] });

    const cleared = updateMcpKey(record.id, { scopes: null });
    expect(cleared?.scopes).toBeNull();

    expect(updateMcpKey(999, { label: "x" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Mutation backstop (P2-7). Adds field-by-field updateMcpKey coverage, the
// rowToRecord elevated mapping + createMcpKey elevated default, the
// getMcpKey integer guard, touchMcpKeyLastUsed, isClientInKeyScope (untested
// before), and the revoked-re-enabled / exact-expiry resolve guards.
//
// Three survivors are EQUIVALENT and left unkilled — all redundant guards:
//   - getMcpKey L133 `if (!Number.isInteger(id)) return null`: a non-integer id
//     matches no row (SQLite does not coerce 1.5 → 1), so the query returns null
//     regardless; the guard is a redundant fast-path.
//   - resolveMcpKeyByToken L202 `if (!token) return null`: an empty token hashes
//     to a digest no key row carries, so the query returns null regardless.
//   - hasAnyMcpKeys L193 `row !== null`: bun:sqlite `.get()` returns `undefined`
//     (never `null`) for an empty result, so `row !== null` is always true and
//     mutating it to `true` cannot change the outcome.
// ---------------------------------------------------------------------------

describe("mcp-key-store — field merges, scope checks, resolve guards", () => {
  test("elevated maps both ways and defaults to false (kills L64, L97)", () => {
    const plain = createMcpKey("plain", null, null, null); // default elevated=false
    expect(plain.record.elevated).toBe(false);
    const elev = createMcpKey("elev", null, null, null, null, true);
    expect(elev.record.elevated).toBe(true);
    expect(getMcpKey(plain.record.id)?.elevated).toBe(false);
    expect(getMcpKey(elev.record.id)?.elevated).toBe(true);
  });

  test("getMcpKey rejects non-integer ids (kills L133 guard)", () => {
    const { record } = createMcpKey("k", null, null, null);
    expect(getMcpKey(record.id)).not.toBeNull();
    expect(getMcpKey(1.5)).toBeNull();
    expect(getMcpKey(NaN)).toBeNull();
  });

  test("updateMcpKey updates each field individually (kills L153/154/156/157/158 EqualityOperator + `??`)", () => {
    const c1 = makeConsumer("c1");
    const c2 = makeConsumer("c2");
    const { record } = createMcpKey("orig", null, 111, "creator", c1, false, null);
    expect(updateMcpKey(record.id, { enabled: false })?.enabled).toBe(false);
    expect(updateMcpKey(record.id, { enabled: true })?.enabled).toBe(true); // `true ?? false` vs `true && false`
    expect(updateMcpKey(record.id, { expiresAt: 222 })?.expiresAt).toBe(222);
    expect(updateMcpKey(record.id, { expiresAt: null })?.expiresAt).toBeNull(); // null is defined → must apply
    expect(updateMcpKey(record.id, { consumerId: c2 })?.consumerId).toBe(c2);
    expect(updateMcpKey(record.id, { consumerId: null })?.consumerId).toBeNull();
    expect(updateMcpKey(record.id, { elevated: true })?.elevated).toBe(true);
    expect(updateMcpKey(record.id, { adminRole: "operator" })?.adminRole).toBe("operator");
    expect(updateMcpKey(record.id, { adminRole: null })?.adminRole).toBeNull();
  });

  test("updateMcpKey preserves fields absent from the patch (kills L153-158 `-> true`)", () => {
    const c1 = makeConsumer("c1");
    const { record } = createMcpKey("orig", null, 111, "creator", c1, true, "operator");
    // A label-only update must leave every other field intact; the `-> true` /
    // `&&` mutants would overwrite them with the undefined patch value.
    updateMcpKey(record.id, { label: "renamed" });
    const k = getMcpKey(record.id);
    expect(k?.label).toBe("renamed");
    expect(k?.enabled).toBe(true);
    expect(k?.expiresAt).toBe(111);
    expect(k?.consumerId).toBe(c1);
    expect(k?.elevated).toBe(true);
    expect(k?.adminRole).toBe("operator");
  });

  test("touchMcpKeyLastUsed sets last_used_at (kills L214-216)", () => {
    const { record } = createMcpKey("k", null, null, null);
    expect(getMcpKey(record.id)?.lastUsedAt).toBeNull();
    touchMcpKeyLastUsed(record.id);
    expect(getMcpKey(record.id)?.lastUsedAt).not.toBeNull();
  });

  test("isClientInKeyScope: null allows all, else the client must be listed (kills L239-241)", () => {
    expect(isClientInKeyScope(null, "svc")).toBe(true);
    expect(isClientInKeyScope({ clients: ["svc"] }, "svc")).toBe(true);
    expect(isClientInKeyScope({ clients: ["other"] }, "svc")).toBe(false);
    expect(isClientInKeyScope({ tools: ["svc__t"] }, "svc")).toBe(false); // no clients list → denied
    expect(isClientInKeyScope({}, "svc")).toBe(false);
  });

  test("a revoked key stays rejected even if later re-enabled (kills L208 revokedAt check)", () => {
    const { record, rawKey } = createMcpKey("k", null, null, null);
    revokeMcpKey(record.id);
    updateMcpKey(record.id, { enabled: true }); // re-enable, but revoked_at is still set
    expect(resolveMcpKeyByToken(rawKey)).toBeNull();
  });

  test("a key is invalid at the exact expiry instant (kills L209 `<=` → `<`)", () => {
    const realNow = Date.now.bind(Date);
    try {
      const expiresAt = realNow() + 60_000;
      const { rawKey } = createMcpKey("k", null, expiresAt, null);
      Date.now = () => expiresAt; // now === expiresAt → `<=` expires, `<` would keep it valid
      expect(resolveMcpKeyByToken(rawKey)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });
});
