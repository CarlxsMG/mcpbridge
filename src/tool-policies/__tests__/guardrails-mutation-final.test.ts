/**
 * Stryker mutation-testing backstop for src/tool-policies/guardrails.ts —
 * closing pass for the 5 survivors left after the 4-agent cold round
 * (guardrails-mutation-{secrets,injection,compile-row,setguardrails}.test.ts).
 *
 * Documented equivalent (not chased further): 62:11-64:4 BlockStatement
 * (`compileDenyPattern`'s catch block — `compiled = null;` — emptied).
 * Verified empirically (`bun -e`): with the catch body emptied, an invalid
 * pattern leaves `compiled` as `undefined` (never assigned) instead of
 * `null`, but the CACHE-HIT read path — `denyPatternCache.get(pattern) ??
 * null` — normalizes `undefined` back to `null` on every subsequent read,
 * including the very next one. Since `checkInputGuardrails`'s `if (re &&
 * re.test(haystack))` treats `undefined` and `null` identically (both
 * falsy), and the cache read-side `?? null` erases the distinction anyway,
 * no observable difference reaches any exported function.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { getDb, __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import { getGuardrails, setGuardrails, checkInputGuardrails, MAX_DENY_PATTERNS } from "../guardrails.js";
import type { RestToolDefinition } from "../../mcp/types.js";

const CLIENT = "gr-mut-final-client";

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

// 99:24-102:33 MethodExpression [Survived] (the trailing `.slice(0,
// MAX_DENY_PATTERNS)` call dropped from the chain — the trim/filter steps
// stay, but the 20-entry cap is never enforced). The existing pipeline
// test only feeds 4 entries, never enough to exercise the cap.
describe("setGuardrails — MAX_DENY_PATTERNS cap is actually enforced", () => {
  test("more than MAX_DENY_PATTERNS entries are truncated to exactly the cap", async () => {
    await reg();
    const many = Array.from({ length: MAX_DENY_PATTERNS + 5 }, (_, i) => `\\bpattern${i}\\b`);
    expect(setGuardrails(CLIENT, "do-thing", { denyPatterns: many, blockSecrets: false, scanResponses: false })).toBe(
      true,
    );
    const persisted = getGuardrails(CLIENT, "do-thing")!.denyPatterns;
    expect(persisted).toHaveLength(MAX_DENY_PATTERNS);
    expect(persisted).toEqual(many.slice(0, MAX_DENY_PATTERNS));
  });
});

// 106:7-106:67 ConditionalExpression [Survived] (the "all empty" clear
// condition forced always-false) / 106:69-109:4 BlockStatement [Survived]
// (the DELETE body emptied). `getGuardrails` alone can't distinguish a
// genuine DELETE from a fallen-through upsertConfig with all-empty values,
// since `rowToGuardrails`'s OWN "nothing enabled" collapse (line ~78)
// ALSO returns null for an all-empty row read back — need to inspect the
// raw table directly to prove the row is actually GONE, not merely empty.
describe("setGuardrails — the clear path genuinely DELETEs the row", () => {
  test("an all-empty cfg leaves zero rows in tool_guardrails, not an empty-but-present row", async () => {
    await reg();
    setGuardrails(CLIENT, "do-thing", { denyPatterns: ["\\bDROP\\b"], blockSecrets: true, scanResponses: true });
    const before = getDb()
      .query(`SELECT COUNT(*) as n FROM tool_guardrails WHERE client_name = ? AND tool_name = ?`)
      .get(CLIENT, "do-thing") as { n: number };
    expect(before.n).toBe(1);

    setGuardrails(CLIENT, "do-thing", { denyPatterns: [], blockSecrets: false, scanResponses: false });
    const after = getDb()
      .query(`SELECT COUNT(*) as n FROM tool_guardrails WHERE client_name = ? AND tool_name = ?`)
      .get(CLIENT, "do-thing") as { n: number };
    expect(after.n).toBe(0);
  });
});

// 149:11-151:4 BlockStatement [Survived] (checkInputGuardrails's OWN catch
// — `haystack = String(args);` — emptied). A circular-reference `args`
// alone doesn't distinguish this: real code's `String(circularObj)`
// produces "[object Object]" and the mutant leaves `haystack` as JS
// `undefined`, which `RegExp.prototype.test` coerces to the STRING
// "undefined" — neither matches an ordinary deny pattern, so the existing
// agent's test (denyPatterns: ["\bDROP\b"]) couldn't tell them apart.
// Using a deny pattern that specifically matches the literal word
// "undefined" flips the outcome: real stays unblocked, the mutant
// wrongly blocks (since its coerced haystack literally contains it).
describe("checkInputGuardrails — catch fallback uses String(args), not a leftover undefined", () => {
  test("a circular-reference body does not spuriously match a pattern targeting the literal word 'undefined'", () => {
    const cfg = { denyPatterns: ["undefined"], blockSecrets: false, scanResponses: false };
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => checkInputGuardrails(cfg, circular)).not.toThrow();
    expect(checkInputGuardrails(cfg, circular).blocked).toBe(false);
  });
});
