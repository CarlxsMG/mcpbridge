/**
 * The control plane's two ENUMERATIONS — sys_list_clients and sys_list_tools —
 * where the tenancy gate narrows rather than refuses. Three properties:
 *
 *  1. A scoped caller sees its OWN clients, never a false empty list. The
 *     read model pages (keyset by name, with a default LIMIT) while
 *     sys_list_clients' inputSchema exposes no cursor at all, so a gate applied
 *     to the page AFTER the read model built it can drop every row of page one
 *     and answer "you have no clients" to a caller that owns one sorting later
 *     in the alphabet. An LLM caller believes that answer. The narrowing has to
 *     be part of the query so the page boundary and the scope agree — raising
 *     the limit only moves the same cliff to a larger N, which is why the
 *     fixture below asserts truncation is real rather than assuming a number.
 *  2. Neither listing leaks a row outside the caller's scope, and an
 *     out-of-scope target stays indistinguishable from one that does not exist.
 *  3. The gate costs ONE key-row read per invocation, not one per row — and
 *     still re-reads on the next invocation, so a re-scoped or deleted key
 *     takes effect immediately. Both halves are asserted: the spy pins the
 *     cost, the re-scope pins that nothing is cached across calls.
 *
 * Driven through runSystemTool() with a hand-built SystemAuthResult, the same
 * harness system-tools-control-plane.test.ts uses.
 */
import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import { clearRegistry, makeTool, registerTestClient } from "../../__tests__/_utils/registry.js";
import { runSystemTool } from "../system-tools.js";
import { __resetDbForTesting } from "../../db/connection.js";
import * as mcpKeyStore from "../../security/mcp-key-store.js";
import { createMcpKey, updateMcpKey } from "../../security/mcp-key-store.js";
import type { SystemAuthResult } from "../../security/system-role.js";

/**
 * Enough clients that the read model's default page cannot hold them all. The
 * number is not asserted anywhere — every test that depends on truncation
 * checks for it directly (see `expectTruncated`), so a future change to the
 * default page size fails loudly here instead of quietly making these tests
 * vacuous.
 */
const FILLER_COUNT = 60;
/** Zero-padded so lexicographic order (the keyset column) is the numeric one. */
const fillerName = (i: number): string => `aaa-${String(i).padStart(2, "0")}`;
const FIRST_FILLER = fillerName(0);
/** Sorts after every filler — the client a post-filter over page one loses. */
const TARGET = "zzz-target";
const TOTAL = FILLER_COUNT + 1;

/** The env admin Bearer: no key row, so no scope narrowing — the unrestricted baseline. */
function envBearer(): SystemAuthResult {
  return { role: "admin", elevated: true, keyId: null, isEnvBearer: true };
}

/** A managed key confined to `clients`, carrying a control-plane role. */
function scopedKeyAuth(clients: string[], role: SystemAuthResult["role"] = "viewer"): SystemAuthResult {
  const { record } = createMcpKey(`scoped-${clients.join("-")}`, { clients }, null, "tester", null, true, role);
  return { role, elevated: true, keyId: record.id, isEnvBearer: false };
}

/** A key narrowed by `scopes.tools` — one pair, and therefore no client-level authority. */
function toolScopedKeyAuth(tools: string[], role: SystemAuthResult["role"] = "viewer"): SystemAuthResult {
  const { record } = createMcpKey(`tool-scoped-${tools.join("-")}`, { tools }, null, "tester", null, true, role);
  return { role, elevated: true, keyId: record.id, isEnvBearer: false };
}

function textOf(result: { content?: { text?: string }[] }): string {
  return result.content?.[0]?.text ?? "";
}

function parse(result: { content?: { text?: string }[] }): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

function page(result: { content?: { text?: string }[] }): { items: { name: string }[]; nextCursor?: string } {
  return JSON.parse(textOf(result)) as { items: { name: string }[]; nextCursor?: string };
}

function clientNames(result: { content?: { text?: string }[] }): string[] {
  return page(result).items.map((i) => i.name);
}

function toolPairs(result: { content?: { text?: string }[] }): string[] {
  const rows = JSON.parse(textOf(result)) as { client: string; tool: string }[];
  return rows.map((r) => `${r.client}__${r.tool}`);
}

/** Only difference an out-of-scope answer may carry is the name the caller itself supplied. */
function sameWords(refusal: { content?: { text?: string }[] }, name: string): string {
  return textOf(refusal).replaceAll(name, "<TARGET>");
}

/**
 * Asserts the precondition every false-empty case rests on: the unrestricted
 * listing really is cut short, and TARGET really is not on the page a
 * post-filter would have had to work from.
 */
async function expectTruncated(): Promise<void> {
  const all = await runSystemTool("sys_list_clients", {}, envBearer());
  expect(clientNames(all).length).toBeLessThan(TOTAL);
  expect(clientNames(all)).not.toContain(TARGET);
  expect(page(all).nextCursor).toBeDefined();
}

// Seeded per test, never in a beforeAll: the shared bun:sqlite connection is
// reset before EVERY test (see CLAUDE.md), so a beforeAll seed would not
// survive into the second case.
beforeEach(async () => {
  await clearRegistry();
  __resetDbForTesting();
  for (let i = 0; i < FILLER_COUNT; i++) {
    await registerTestClient(fillerName(i), [makeTool({ name: "get-thing" })]);
  }
  await registerTestClient(TARGET, [makeTool({ name: "get-thing" })]);
});

describe("sys_list_clients does not report a false empty", () => {
  test("a caller scoped to a client behind the read model's first page still sees it", async () => {
    await expectTruncated();

    const scoped = await runSystemTool("sys_list_clients", {}, scopedKeyAuth([TARGET]));

    // The regression this pins: with the scope applied to the already-paginated
    // page, every one of those rows is dropped and this comes back `[]` with a
    // nextCursor the tool's schema gives the caller no way to follow — an agent
    // reads that as "this gateway has no servers".
    expect(clientNames(scoped)).toEqual([TARGET]);
    expect(page(scoped).nextCursor).toBeUndefined();
  });

  test("the narrowing is exact — a key scoped to one client sees that one and nothing else", async () => {
    const scoped = await runSystemTool("sys_list_clients", {}, scopedKeyAuth([FIRST_FILLER]));
    expect(clientNames(scoped)).toEqual([FIRST_FILLER]);

    const two = await runSystemTool("sys_list_clients", {}, scopedKeyAuth([FIRST_FILLER, TARGET]));
    expect(clientNames(two)).toEqual([FIRST_FILLER, TARGET]);

    // Control: those 59 other clients genuinely exist and are genuinely
    // listable — the scoped answers above are the gate, not an empty gateway.
    const all = await runSystemTool("sys_list_clients", {}, envBearer());
    expect(clientNames(all)).toContain(fillerName(1));
  });

  test("q and enabled still compose with the scope instead of being replaced by it", async () => {
    const scoped = scopedKeyAuth([FIRST_FILLER, TARGET]);

    const filtered = await runSystemTool("sys_list_clients", { q: "zzz" }, scoped);
    expect(clientNames(filtered)).toEqual([TARGET]);

    // A `q` matching a client outside the scope matches nothing — the scope is
    // an AND, never an escape hatch.
    const foreign = await runSystemTool("sys_list_clients", { q: fillerName(7) }, scoped);
    expect(clientNames(foreign)).toEqual([]);

    const enabled = await runSystemTool("sys_list_clients", { enabled: false }, scoped);
    expect(clientNames(enabled)).toEqual([]);
  });

  test("a key holding only a per-tool grant sees no client rows at all", async () => {
    // A client row is a client-level fact (base_url, tool count, health), so a
    // `scopes.tools` grant is not authority over it — and the empty answer must
    // not come with a cursor implying there is more behind it.
    const toolScoped = await runSystemTool("sys_list_clients", {}, toolScopedKeyAuth([`${TARGET}__get-thing`]));
    expect(clientNames(toolScoped)).toEqual([]);
    expect(page(toolScoped).nextCursor).toBeUndefined();

    // ...while the same key does see its own pair from the tool listing.
    const pairs = await runSystemTool("sys_list_tools", {}, toolScopedKeyAuth([`${TARGET}__get-thing`]));
    expect(toolPairs(pairs)).toEqual([`${TARGET}__get-thing`]);
  });

  test("a key whose row vanished mid-session lists nothing rather than everything", async () => {
    const gone: SystemAuthResult = { role: "admin", elevated: true, keyId: 4242, isEnvBearer: false };

    expect(clientNames(await runSystemTool("sys_list_clients", {}, gone))).toEqual([]);
    expect(toolPairs(await runSystemTool("sys_list_tools", {}, gone))).toEqual([]);
  });
});

describe("sys_list_tools", () => {
  test("returns every pair the caller may touch — the listing is unpaginated, so no page boundary can hide one", async () => {
    // The reason a post-filter is sound here and not in sys_list_clients: this
    // read model returns all rows, so TARGET's pair is present however many
    // clients sort ahead of it.
    const all = await runSystemTool("sys_list_tools", {}, envBearer());
    expect(toolPairs(all).length).toBe(TOTAL);

    const scoped = await runSystemTool("sys_list_tools", {}, scopedKeyAuth([TARGET]));
    expect(toolPairs(scoped)).toEqual([`${TARGET}__get-thing`]);
  });
});

describe("the key row is read once per invocation, and again on the next one", () => {
  test("one getMcpKey read answers a whole listing, however many rows it returns", async () => {
    const auth = scopedKeyAuth([TARGET]);
    // Guard against a vacuous pass: "one read" only means anything if there
    // were many rows to have read per.
    expect(toolPairs(await runSystemTool("sys_list_tools", {}, envBearer())).length).toBe(TOTAL);

    const spy = spyOn(mcpKeyStore, "getMcpKey");
    try {
      await runSystemTool("sys_list_tools", {}, auth);
      expect(spy.mock.calls.length).toBe(1);

      spy.mockClear();
      await runSystemTool("sys_list_clients", {}, auth);
      expect(spy.mock.calls.length).toBe(1);

      // Two invocations, two reads: the removal is of repetition inside a call,
      // not of the per-call read that makes a revoked key take effect.
      spy.mockClear();
      await runSystemTool("sys_list_tools", {}, auth);
      await runSystemTool("sys_list_tools", {}, auth);
      expect(spy.mock.calls.length).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  test("a re-scoped key takes effect on the caller's very next call — resolving once is not caching", async () => {
    const { record } = createMcpKey("rescoped", { clients: [TARGET] }, null, "tester", null, true, "viewer");
    const auth: SystemAuthResult = { role: "viewer", elevated: true, keyId: record.id, isEnvBearer: false };

    expect(clientNames(await runSystemTool("sys_list_clients", {}, auth))).toEqual([TARGET]);

    updateMcpKey(record.id, { scopes: { clients: [FIRST_FILLER] } });

    expect(clientNames(await runSystemTool("sys_list_clients", {}, auth))).toEqual([FIRST_FILLER]);
    expect(toolPairs(await runSystemTool("sys_list_tools", {}, auth))).toEqual([`${FIRST_FILLER}__get-thing`]);
  });
});

describe("the opacity contract survives the shared resolution", () => {
  test("an out-of-scope client is refused in the same words as one that does not exist", async () => {
    const scoped = scopedKeyAuth([TARGET], "admin");

    const foreign = await runSystemTool("sys_get_client", { name: FIRST_FILLER }, scoped);
    const ghost = await runSystemTool("sys_get_client", { name: "no-such-client" }, scoped);

    expect(foreign.isError).toBe(true);
    expect(sameWords(foreign, FIRST_FILLER)).toBe(sameWords(ghost, "no-such-client"));

    // Control: FIRST_FILLER exists and its detail really is readable by a
    // caller whose key does not exclude it.
    const unrestricted = await runSystemTool("sys_get_client", { name: FIRST_FILLER }, envBearer());
    expect(unrestricted.isError).toBeUndefined();
    expect(parse(unrestricted).name).toBe(FIRST_FILLER);
  });

  test("a deleted key row refuses opaquely too, rather than falling back to unrestricted", async () => {
    const gone: SystemAuthResult = { role: "admin", elevated: true, keyId: 4242, isEnvBearer: false };

    const foreign = await runSystemTool("sys_get_client", { name: FIRST_FILLER }, gone);
    const ghost = await runSystemTool("sys_get_client", { name: "no-such-client" }, gone);
    expect(foreign.isError).toBe(true);
    expect(sameWords(foreign, FIRST_FILLER)).toBe(sameWords(ghost, "no-such-client"));
  });
});
