/**
 * Stryker mutation-testing backstop for src/tool-meta/tool-examples.ts.
 * Baseline 77.42% (24/31) — the existing tool-examples.test.ts covers the
 * create/list/delete round-trip, an unknown tool, a non-object (array) args
 * rejection, cascade-delete, tool-scoped delete, and the admin route, but
 * never exercises a null args value, a non-array PRIMITIVE args value (only
 * an array was ever tried), or either side of the MAX_ARGS_BYTES boundary.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { createExample } from "../../tool-meta/tool-examples.js";
import type { RestToolDefinition } from "../../mcp/types.js";

const CLIENT = "svc";
const TOOL = "search";
function makeTool(): RestToolDefinition {
  return {
    name: TOOL,
    method: "GET",
    endpoint: "/search",
    description: "search",
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
  };
}
async function reg(): Promise<void> {
  await registry.register(CLIENT, [makeTool()], "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}

beforeEach(async () => {
  __resetDbForTesting();
  for (const c of registry.listClients()) await registry.unregister(c.name);
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
});

// 54:35-54:48 ConditionalExpression [Survived] false (`args === null` forced
// false), plus 54:7-54:48 ConditionalExpression [Survived] false and
// LogicalOperator [Survived] (`||` -> `&&` between the first two
// sub-conditions) — all three converge on the SAME divergence for a null
// args value, since `typeof null === "object"` in JS makes the first
// sub-condition false too, isolating exactly the `=== null` check.
describe("createExample — a null args value is rejected, not silently accepted", () => {
  test("args: null returns INVALID_ARGS, not a created example", async () => {
    await reg();
    expect(createExample(CLIENT, TOOL, "x", null, null)).toBe("INVALID_ARGS");
  });
});

// 54:7-54:31 ConditionalExpression [Survived] false (`typeof args !== "object"`
// forced false). The existing "non-object args" test only ever used an
// ARRAY (`[1,2,3]`), which is typeof "object" in JS — it never isolates this
// half. A genuine non-object, non-null, non-array PRIMITIVE is needed.
describe("createExample — a primitive (non-object) args value is rejected", () => {
  test("args: 5 (a number) returns INVALID_ARGS, not a created example", async () => {
    await reg();
    expect(createExample(CLIENT, TOOL, "x", 5, null)).toBe("INVALID_ARGS");
  });
});

// 56:7-56:39 ConditionalExpression [Survived] false (`argsJson.length >
// MAX_ARGS_BYTES` forced false) and 56:48-56:62 StringLiteral [Survived]
// `""` ("INVALID_ARGS" emptied) — no existing test ever constructs
// oversized args.
describe("createExample — oversized args are rejected", () => {
  test("args whose JSON exceeds MAX_ARGS_BYTES returns exactly INVALID_ARGS", async () => {
    await reg();
    const big = { data: "x".repeat(20000) };
    expect(createExample(CLIENT, TOOL, "x", big, null)).toBe("INVALID_ARGS");
  });
});

// 56:7-56:39 EqualityOperator [Survived] (`>` -> `>=`) — an EXACT boundary
// test is required: args whose JSON.stringify length is exactly
// MAX_ARGS_BYTES (16384) must be ACCEPTED (the check is deliberately
// exclusive of the max), while the `>=` mutant would reject it.
describe("createExample — the MAX_ARGS_BYTES boundary is exclusive (>), not inclusive (>=)", () => {
  test("args whose JSON is exactly 16384 bytes is accepted, not rejected", async () => {
    await reg();
    // '{"a":"' + N x's + '"}' === 16384 total bytes when N = 16384 - 8.
    const exact = { a: "x".repeat(16384 - 8) };
    expect(JSON.stringify(exact).length).toBe(16384);
    const result = createExample(CLIENT, TOOL, "x", exact, null);
    expect(result).not.toBe("INVALID_ARGS");
    expect(typeof result).toBe("object");
  });
});
