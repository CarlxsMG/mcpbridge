import { describe, test, expect, beforeEach } from "bun:test";
import { __resetDbForTesting } from "../../db/connection.js";
import {
  createMcpKey,
  listMcpKeys,
  getMcpKey,
  updateMcpKey,
  revokeMcpKey,
  deleteMcpKey,
  resolveMcpKeyByToken,
  isToolInKeyScope,
  hasAnyMcpKeys,
} from "../../security/mcp-key-store.js";

beforeEach(() => {
  __resetDbForTesting();
});

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
