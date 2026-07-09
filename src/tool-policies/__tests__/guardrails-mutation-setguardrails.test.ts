/**
 * Stryker mutation-kill: setGuardrails' denyPatterns normalization pipeline
 * (trim/filter(Boolean)/slice), the blockSecrets/scanResponses `?? false`
 * defaults, the "all empty clears the row" condition + its DELETE body, and
 * the `deny_patterns_json: length > 0 ? JSON.stringify(...) : null` boundary
 * all had surviving mutants — none of the existing tests fed denyPatterns
 * entries that need trimming/dropping, omitted cfg fields to force the `??`
 * fallbacks, or inspected the raw DB row to distinguish a stored `null` from
 * a stored `"[]"` (both deserialize to `[]` via getGuardrails, so that one
 * mutant is invisible from the public API and needs a raw-row check).
 * Also covers checkInputGuardrails' JSON.stringify catch-fallback and the
 * exact deny-pattern-matched rejection reason string.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { getDb, __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import { getGuardrails, setGuardrails, checkInputGuardrails } from "../guardrails.js";
import type { RestToolDefinition, ToolGuardrails } from "../../mcp/types.js";

const CLIENT = "gr-mut-client";

function makeTool(overrides: Partial<RestToolDefinition> = {}): RestToolDefinition {
  return {
    name: "do-thing",
    method: "POST",
    endpoint: "/thing",
    description: "does a thing",
    inputSchema: { type: "object", properties: { note: { type: "string" } } },
    ...overrides,
  };
}
async function reg(tools: RestToolDefinition[] = [makeTool()]) {
  await registry.register(CLIENT, tools, "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
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

describe("setGuardrails — denyPatterns normalization pipeline", () => {
  test("trims whitespace and drops empty/whitespace-only entries, preserving order", async () => {
    await reg();
    expect(
      setGuardrails(CLIENT, "do-thing", {
        denyPatterns: ["  \\bDROP\\b  ", "", "   ", "\\bSELECT\\b"],
        blockSecrets: false,
        scanResponses: false,
      }),
    ).toBe(true);
    expect(getGuardrails(CLIENT, "do-thing")).toEqual({
      denyPatterns: ["\\bDROP\\b", "\\bSELECT\\b"],
      blockSecrets: false,
      scanResponses: false,
    });
  });
});

describe("setGuardrails — cfg?. fallbacks", () => {
  test("omitted denyPatterns falls back to [] instead of throwing", async () => {
    await reg();
    // Deliberately omit denyPatterns to force the `(cfg?.denyPatterns ?? [])` fallback.
    const cfg = { blockSecrets: true, scanResponses: false } as unknown as ToolGuardrails;
    expect(() => setGuardrails(CLIENT, "do-thing", cfg)).not.toThrow();
    expect(setGuardrails(CLIENT, "do-thing", cfg)).toBe(true);
    expect(getGuardrails(CLIENT, "do-thing")).toEqual({
      denyPatterns: [],
      blockSecrets: true,
      scanResponses: false,
    });
  });

  test("omitted blockSecrets/scanResponses default to false, not true", async () => {
    await reg();
    // Deliberately omit blockSecrets/scanResponses to force their `?? false` fallbacks.
    const cfg = { denyPatterns: ["\\bDROP\\b"] } as unknown as ToolGuardrails;
    expect(setGuardrails(CLIENT, "do-thing", cfg)).toBe(true);
    expect(getGuardrails(CLIENT, "do-thing")).toEqual({
      denyPatterns: ["\\bDROP\\b"],
      blockSecrets: false,
      scanResponses: false,
    });
  });
});

describe("setGuardrails — clear condition + DELETE", () => {
  test("all-empty cfg on a tool with a real prior config clears the row (getGuardrails -> null)", async () => {
    await reg();
    expect(
      setGuardrails(CLIENT, "do-thing", { denyPatterns: ["\\bDROP\\b"], blockSecrets: true, scanResponses: true }),
    ).toBe(true);
    expect(getGuardrails(CLIENT, "do-thing")).not.toBeNull();

    expect(setGuardrails(CLIENT, "do-thing", { denyPatterns: [], blockSecrets: false, scanResponses: false })).toBe(
      true,
    );
    expect(getGuardrails(CLIENT, "do-thing")).toBeNull();
  });
});

describe("setGuardrails — deny_patterns_json null-vs-'[]' boundary", () => {
  test("empty denyPatterns with another flag set stores NULL in the raw row, not the string '[]'", async () => {
    await reg();
    expect(setGuardrails(CLIENT, "do-thing", { denyPatterns: [], blockSecrets: true, scanResponses: false })).toBe(
      true,
    );

    // getGuardrails alone can't distinguish a stored NULL from a stored "[]" —
    // rowToGuardrails deserializes both to []. Inspect the raw column directly.
    const row = getDb()
      .query(`SELECT deny_patterns_json FROM tool_guardrails WHERE client_name = ? AND tool_name = ?`)
      .get(CLIENT, "do-thing") as { deny_patterns_json: string | null } | null;
    expect(row).not.toBeNull();
    expect(row!.deny_patterns_json).toBeNull();
    expect(row!.deny_patterns_json).not.toBe("[]");

    // Sanity check the public API still reports [] either way.
    expect(getGuardrails(CLIENT, "do-thing")?.denyPatterns).toEqual([]);
  });
});

describe("checkInputGuardrails — non-secret paths", () => {
  test("JSON.stringify throwing (circular reference) falls back to String(args) instead of throwing", () => {
    const cfg: ToolGuardrails = { denyPatterns: ["\\bDROP\\b"], blockSecrets: false, scanResponses: false };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const circular: any = {};
    circular.self = circular;
    expect(() => checkInputGuardrails(cfg, circular)).not.toThrow();
    expect(checkInputGuardrails(cfg, circular).blocked).toBe(false);
  });

  test("deny-pattern match reports the exact rejection reason string", () => {
    const cfg: ToolGuardrails = { denyPatterns: ["\\bDROP\\b"], blockSecrets: false, scanResponses: false };
    const r = checkInputGuardrails(cfg, { q: "DROP TABLE" });
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe("arguments matched a configured deny pattern");
  });
});
