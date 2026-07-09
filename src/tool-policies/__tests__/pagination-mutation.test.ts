/**
 * Stryker mutation-testing backstop for src/tool-policies/pagination.ts.
 * Baseline 75.44% (86/114) — the existing pagination.test.ts covers the happy
 * paths well (cursor/page/link strategies end to end via proxyToolCall) but
 * misses: the `enabled`/`pageParam` round-trip boundaries, getByPath's null-
 * intermediate guard, parseNextLink's whitespace/quote regex boundaries and
 * its malformed-part `continue`, and withItems' null/non-object/nested-
 * intermediate guard clauses (the existing test only exercises a single-
 * segment itemsPath, never a multi-segment nested path).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import { getPaginationConfig, setPaginationConfig, getByPath, parseNextLink, withItems } from "../pagination.js";
import type { RestToolDefinition } from "../../mcp/types.js";

const CLIENT = "pg-mut-client";
const listTool: RestToolDefinition = {
  name: "get-list",
  method: "GET",
  endpoint: "/list",
  description: "list",
  inputSchema: { type: "object", properties: {} },
};
async function reg(): Promise<void> {
  await registry.register(CLIENT, [listTool], "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}

beforeEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
  removeCircuitBreaker(CLIENT);
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
  removeCircuitBreaker(CLIENT);
});

// 56:14-56:31 ConditionalExpression [Survived] true (`row.enabled === 1` forced
// true). The existing config test only ever persists enabled:true.
describe("getPaginationConfig — enabled reads back false, not forced true", () => {
  test("a config persisted with enabled:false reads back enabled:false", async () => {
    await reg();
    setPaginationConfig(CLIENT, "get-list", {
      enabled: false,
      strategy: "page",
      itemsPath: "items",
      pageParam: "page",
      maxPages: 5,
    });
    expect(getPaginationConfig(CLIENT, "get-list")?.enabled).toBe(false);
  });
});

// 61:16-61:43 LogicalOperator [Survived] row.page_param && undefined (read side
// `??`->`&&`) and 97:19-97:42 LogicalOperator [Survived] input.pageParam && null
// (write side `??`->`&&`). A truthy pageParam round-tripped through set+get
// kills both: the write mutant would store NULL instead of "page", the read
// mutant would report undefined instead of "page".
describe("pageParam round-trip is not collapsed by a ?? -> && flip", () => {
  test("a truthy pageParam persists and reads back exactly, not undefined", async () => {
    await reg();
    setPaginationConfig(CLIENT, "get-list", {
      enabled: true,
      strategy: "page",
      itemsPath: "items",
      pageParam: "page",
      maxPages: 5,
    });
    expect(getPaginationConfig(CLIENT, "get-list")?.pageParam).toBe("page");
  });
});

// 113:9-113:21 ConditionalExpression [Survived] false (getByPath's
// `cur === null` guard forced false). The existing test only reaches the
// guard's `typeof cur !== "object"` half (via an undefined intermediate);
// an explicit null intermediate is needed to isolate the null check itself.
describe("getByPath — a null intermediate value does not throw", () => {
  test("a path through an explicit null returns undefined, not a thrown TypeError", () => {
    expect(getByPath({ a: null }, "a.b")).toBeUndefined();
  });
});

// 137:26-137:48 Regex [Survived] x3 (both \s* quantifiers on the <url>;rel...
// match, one flipped to \S* and the other flipped to both \S* and the
// quantifier-reduced \s). A link segment with whitespace BEFORE the `;` and
// NONE after simultaneously breaks all three: \S* before `;` can't reach the
// literal semicolon past a real space, and zero whitespace after `;` fails
// both a \S*-negated and a \s-exactly-one requirement while the real \s*
// (zero-or-more) matches fine either way. Verified empirically via bun -e
// against hand-copied mutant regexes before relying on this reasoning.
describe("parseNextLink — <url> ; rel=... whitespace boundaries", () => {
  test("whitespace before the semicolon and none after both still parse", () => {
    expect(parseNextLink('<https://api/x?page=2> ;rel="next", <https://api/x?page=9>; rel="last"')).toBe(
      "https://api/x?page=2",
    );
  });
});

// 139:9-139:30 Regex [Survived] x2 (`rel\s*=\s*...` — both \s* flipped to
// \S*). Realistic spacing around `=` (`rel = "next"`) matches the real regex
// but fails a non-whitespace requirement at either position.
describe("parseNextLink — rel = ... spacing boundaries", () => {
  test("whitespace around the = in rel=next still parses", () => {
    expect(parseNextLink('<https://api/x>; rel = "next"')).toBe("https://api/x");
  });
});

// 139:9-139:30 Regex [Survived] x2 (`"?next"?` — both optional quotes forced
// required). An UNQUOTED rel=next value matches the real (optional-quote)
// regex but fails a required-quote mutant on either side.
describe("parseNextLink — unquoted rel=next (no quotes at all)", () => {
  test("an unquoted next value is still recognized", () => {
    expect(parseNextLink("<https://api/x>;rel=next")).toBe("https://api/x");
  });
});

// 139:50-139:61 MethodExpression [Survived] m[1] (`.trim()` dropped from the
// returned URL). Whitespace INSIDE the angle brackets survives into capture
// group 1 verbatim; only `.trim()` strips it before returning.
describe("parseNextLink — the returned URL is trimmed", () => {
  test("whitespace inside <...> is trimmed off the returned URL", () => {
    expect(parseNextLink('< https://api/x > ;rel="next"')).toBe("https://api/x");
  });
});

// 138:9-138:11 ConditionalExpression [Survived] false (`if (!m) continue;`
// forced false). A segment that doesn't match the <url>;rel... shape at all
// must be skipped (not dereferenced as if it matched), falling through to a
// LATER segment that does match.
describe("parseNextLink — a non-matching segment is skipped, not dereferenced", () => {
  test("a malformed segment ahead of a valid rel=next segment does not throw", () => {
    expect(() => parseNextLink('garbage-part, <https://api/x>; rel="next"')).not.toThrow();
    expect(parseNextLink('garbage-part, <https://api/x>; rel="next"')).toBe("https://api/x");
  });
});

// 147:*, x4 survivors (the whole-body null/non-object guard, in both its
// ConditionalExpression and LogicalOperator forms). A null body and a
// non-null-non-object body are both needed: null is the only value where
// `typeof body !== "object"` is naturally false (a JS quirk), so it alone
// isolates the `body === null` half; a primitive isolates the `typeof`
// half. Object-spreading null/a primitive silently no-ops in real JS
// (no throw), so only the RETURN VALUE proves whether the guard fired.
describe("withItems — the whole-body null/non-object guard is load-bearing", () => {
  test("a null body is returned unchanged, not spread into a new object", () => {
    expect(withItems(null, "a.b", [9])).toBeNull();
  });
  test("a non-object primitive body is returned unchanged", () => {
    expect(withItems(5, "a.b", [9])).toBe(5);
  });
});

// 151:*, x3 survivors (the nested-descent loop's condition, its `i++`
// direction, and its whole body). All three only diverge from real behavior
// on a MULTI-segment itemsPath — the existing test only ever uses a single
// segment (loop never runs at baseline). A path with an extra, untouched
// sibling property additionally proves the clone-and-descend actually
// happened (not just that SOME items landed somewhere).
describe("withItems — nested descent actually walks into the intermediate object", () => {
  test("a 2-segment path clones the intermediate and sets items at the leaf, not the root", () => {
    const body = { a: { b: [1], x: 1 }, other: true };
    const out = withItems(body, "a.b", [9, 9]) as { a: { b: number[]; x: number }; b?: unknown; other: boolean };
    expect(out.a.b).toEqual([9, 9]);
    expect(out.a.x).toBe(1); // sibling property preserved through the clone
    expect(out.b).toBeUndefined(); // items must NOT land directly on root
    expect(out.other).toBe(true);
    // Original untouched.
    expect(body.a.b).toEqual([1]);
  });
});

// 153:*, x6 survivors + 154's ObjectLiteral (the intermediate-segment
// null/non-object guard and the clone-with-spread). Mirrors the 147 guard
// one level down: a null intermediate and a non-object-non-null
// intermediate are both needed to isolate the `===null` vs `typeof`
// branches.
describe("withItems — an intermediate segment that isn't an object short-circuits", () => {
  test("a null intermediate returns the (cloned) body unchanged", () => {
    const body = { a: null };
    expect(withItems(body, "a.b", [9])).toEqual({ a: null });
  });
  test("a non-object non-null intermediate returns the (cloned) body unchanged", () => {
    const body = { a: 5 };
    expect(withItems(body, "a.b", [9])).toEqual({ a: 5 });
  });
});
