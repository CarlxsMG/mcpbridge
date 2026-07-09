/**
 * Stryker mutation-testing backstop for src/tool-meta/tool-sensitivity.ts.
 * Baseline 68.42% (26/38) — the existing tool-sensitivity.test.ts covers the
 * proxy-level confirmation gate, elevated-key bypass, auto-gate for DELETE,
 * and an explicit override — but never calls setToolSensitive for an unknown
 * tool, never clears an explicit flag back to null, never exercises method
 * "PUT" or a non-write method at all, never tests auto-gate DISABLED with a
 * write method, and never calls getSensitivityForClient at all.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { getDb } from "../../db/connection.js";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { setToolSensitive, getToolSensitivity, isToolSensitive, getSensitivityForClient } from "../tool-sensitivity.js";
import type { RestToolDefinition } from "../../mcp/types.js";

const CLIENT = "svc";
function makeTool(name: string): RestToolDefinition {
  return {
    name,
    method: "GET",
    endpoint: `/${name}`,
    description: "d",
    inputSchema: { type: "object", properties: {} },
  };
}
async function reg(tools: RestToolDefinition[]): Promise<void> {
  await registry.register(CLIENT, tools, "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

const originalAutoGate = config.autoGateWriteMethods;
beforeEach(async () => {
  __resetDbForTesting();
  for (const c of registry.listClients()) await registry.unregister(c.name);
});
afterEach(async () => {
  (config as Record<string, unknown>).autoGateWriteMethods = originalAutoGate;
  for (const c of registry.listClients()) await registry.unregister(c.name);
});

// 19:7-19:40 ConditionalExpression [Survived] false (`!toolExists(...)`
// forced false) and 19:49-19:54 BooleanLiteral [Survived] true (the
// `return false;` literal forced to true) — no existing test ever calls
// setToolSensitive for an unknown tool.
describe("setToolSensitive — an unknown tool returns false, not true", () => {
  test("returns exactly false for a tool that was never registered", async () => {
    await reg([makeTool("t")]);
    expect(setToolSensitive(CLIENT, "ghost", true)).toBe(false);
  });
});

// 20:7-20:25 ConditionalExpression [Survived] false (`sensitive === null`
// forced false), 20:27-22:4 BlockStatement [Survived] (the DELETE branch's
// body emptied), 21:19-21:89 StringLiteral [Survived] `` (the DELETE SQL
// itself emptied). Clearing a flag (null) must genuinely DELETE the row —
// getToolSensitivity()===null can't distinguish a real delete from an
// upsert-with-sensitive:0 row on its own if the read-side collapsed both
// to the same value, so verify the row is actually GONE via raw SQL too
// (same technique as guardrails.ts's getGuardrails()===null case).
describe("setToolSensitive — clearing with null genuinely deletes the row", () => {
  test("null after an explicit true leaves no row and reads back as null", async () => {
    await reg([makeTool("t")]);
    setToolSensitive(CLIENT, "t", true);
    expect(setToolSensitive(CLIENT, "t", null)).toBe(true);
    expect(getToolSensitivity(CLIENT, "t")).toBeNull();
    const row = getDb()
      .query(`SELECT COUNT(*) as c FROM tool_sensitivity WHERE client_name = ? AND tool_name = ?`)
      .get(CLIENT, "t") as { c: number };
    expect(row.c).toBe(0);
  });
});

// 37:10-37:82 ConditionalExpression [Survived] true (the whole `A && (B ||
// C)` forced true) + LogicalOperator [Survived] (`&&` -> `||`), 37:42-37:81
// ConditionalExpression [Survived] true (`(method==="DELETE"||method===
// "PUT")` forced true), 37:65-37:81 ConditionalExpression [Survived] false +
// EqualityOperator [Survived] (`===`->`!==`) + StringLiteral [Survived] `""`
// (all on `method === "PUT"`). The existing "auto-gate" test only ever
// tries autoGateWriteMethods:true with method:"DELETE" (both true) — never
// isolates any of the other 3 quadrants.
describe("isToolSensitive — the auto-gate quadrants are all independently correct", () => {
  test("auto-gate enabled + a non-write method (GET) is NOT auto-sensitive", () => {
    (config as Record<string, unknown>).autoGateWriteMethods = true;
    expect(isToolSensitive("nope", "nope", "GET")).toBe(false);
  });
  test("auto-gate DISABLED + a write method (DELETE) is NOT auto-sensitive", () => {
    (config as Record<string, unknown>).autoGateWriteMethods = false;
    expect(isToolSensitive("nope", "nope", "DELETE")).toBe(false);
  });
  test("auto-gate enabled + PUT is auto-sensitive (not just DELETE)", () => {
    (config as Record<string, unknown>).autoGateWriteMethods = true;
    expect(isToolSensitive("nope", "nope", "PUT")).toBe(true);
  });
});

// 46:44-46:61 ConditionalExpression [Survived] true (`r.sensitive === 1`
// forced true) — getSensitivityForClient has ZERO prior test coverage at
// all.
describe("getSensitivityForClient — reads back a false flag as false, not forced true", () => {
  test("an explicit sensitive:false tool reads back false in the batched map", async () => {
    await reg([makeTool("a"), makeTool("b")]);
    setToolSensitive(CLIENT, "a", false);
    setToolSensitive(CLIENT, "b", true);
    expect(getSensitivityForClient(CLIENT)).toEqual({ a: false, b: true });
  });
});
