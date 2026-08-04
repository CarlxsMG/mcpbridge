/**
 * Every policy refusal carries a machine-readable {@link DenyCode}.
 *
 * Before this existed a gate rejected with prose and the trace span recorded
 * `mcp.tool.is_error: true` — one boolean covering a dozen distinct outcomes.
 * "Which gate refused this call" was answerable only by string-matching an
 * error message (which is sanitized on several paths), and "how many calls did
 * the quota gate refuse this week" was not answerable at all. For a gateway
 * whose product IS making these decisions, that was the central observability
 * gap.
 *
 * The structural cases below are the load-bearing ones: they are what stops a
 * gate added later from quietly going untagged, which is exactly how the
 * original gap would grow back one commit at a time.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { denyResult, toolResult, type DenyCode } from "../../lib/mcp-result.js";
import { checkConfirmGate, checkAllowedKeyGate, checkClientToolAvailable } from "../gates.js";
import type { RegisteredClient, RegisteredTool } from "../../mcp/types.js";

const GATES_SRC = readFileSync(join(import.meta.dir, "..", "gates.ts"), "utf8");
const RESULT_SRC = readFileSync(join(import.meta.dir, "..", "..", "lib", "mcp-result.ts"), "utf8");

/**
 * The union's members, read off the type declaration rather than hand-listed.
 * A hand-copied list drifts silently the moment someone adds a code, which
 * would make the "no orphan codes" case below quietly stop covering it.
 */
function declaredDenyCodes(): string[] {
  const block = RESULT_SRC.split("export type DenyCode =")[1]?.split(";")[0] ?? "";
  return [...block.matchAll(/\|\s*"([a-z_]+)"/g)].map((m) => m[1]!);
}

describe("deny-code coverage (structural)", () => {
  test("no gate still rejects with an untagged error result", () => {
    // The rule this file exists to enforce. `toolResult(text, { isError: true })`
    // inside gates.ts means a refusal that reaches the trace as an anonymous
    // boolean — which is the exact state this work removed.
    const untagged = [...GATES_SRC.matchAll(/toolResult\([^;]*?isError:\s*true/gs)].map((m) =>
      m[0].slice(0, 70).replace(/\s+/g, " "),
    );
    expect(untagged, `Use denyResult(code, text) so the refusal is queryable:\n${untagged.join("\n")}`).toEqual([]);
  });

  test("the union declares at least one code and the reader actually parses it", () => {
    // A floor: if the regex above ever stops matching (the declaration is
    // reformatted, say), every other case here would pass vacuously.
    expect(declaredDenyCodes().length).toBeGreaterThan(5);
  });

  test("every declared code is actually produced somewhere", () => {
    // A code nobody emits is a promise the trace viewer cannot keep: an
    // operator filtering on it gets an empty result and no way to tell
    // "never happened" from "never implemented".
    const emitted = new Set(
      [...GATES_SRC.matchAll(/denyResult\(\s*"([a-z_]+)"/g)].map((m) => m[1]!).concat(readProxyCodes()),
    );
    const orphans = declaredDenyCodes().filter((c) => !emitted.has(c));
    expect(orphans, `Declared in DenyCode but never returned: ${orphans.join(", ")}`).toEqual([]);
  });
});

function readProxyCodes(): string[] {
  const src = readFileSync(join(import.meta.dir, "..", "proxy.ts"), "utf8");
  return [...src.matchAll(/denyResult\(\s*"([a-z_]+)"/g)].map((m) => m[1]!);
}

describe("deny-code behaviour", () => {
  test("denyResult marks the error AND the reason, not one or the other", () => {
    const r = denyResult("rate_limit", "slow down");
    expect(r.isError).toBe(true);
    expect(r.denyCode).toBe("rate_limit");
    expect(r.content[0]?.text).toBe("slow down");
  });

  test("a plain toolResult carries no code — success must not look like a refusal", () => {
    expect(toolResult("fine").denyCode).toBeUndefined();
    expect(toolResult("boom", { isError: true }).denyCode).toBeUndefined();
  });

  test("the confirm gate reports confirm_required, not a generic error", () => {
    const denied = checkConfirmGate(true, {}, false, "svc__delete");
    expect(denied?.denyCode).toBe("confirm_required");
    // ...and lets a confirmed call through, so the code above is a real
    // decision rather than something returned unconditionally.
    expect(checkConfirmGate(true, { __confirm: true }, false, "svc__delete")).toBeNull();
  });

  test("the allowed-key gate reports allowed_key", () => {
    const tool = { name: "t", guards: { allowedKeyHashes: ["deadbeef"] } } as unknown as RegisteredTool;
    expect(checkAllowedKeyGate(tool, "wrong-token", "svc__t")?.denyCode).toBe("allowed_key");
  });

  test("availability distinguishes its three reasons — the case for per-reason codes", () => {
    // One gate function, three genuinely different operator actions: re-enable
    // the tool, wait for the unregister to finish, or go fix the backend.
    // Tagging per call site would have collapsed all three into one code.
    const tool = { name: "t", enabled: true } as unknown as RegisteredTool;
    const disabled = { name: "c", enabled: false, status: "healthy" } as unknown as RegisteredClient;
    const unreachable = { name: "c", enabled: true, status: "unreachable" } as unknown as RegisteredClient;

    expect(checkClientToolAvailable(disabled, tool, "c__t")?.denyCode).toBe("disabled");
    expect(checkClientToolAvailable(unreachable, tool, "c__t")?.denyCode).toBe("unreachable");
    // A healthy client with an enabled tool is not refused at all.
    const healthy = { name: "c", enabled: true, status: "healthy" } as unknown as RegisteredClient;
    expect(checkClientToolAvailable(healthy, tool, "c__t")).toBeNull();
  });

  test("codes are stable identifiers, not prose — they are persisted and filtered on", () => {
    // A code with a space or capital in it would be a message wearing a code's
    // clothes, and would break the moment someone reworded it.
    for (const code of declaredDenyCodes()) {
      expect(code, `${code} is not a stable identifier`).toMatch(/^[a-z][a-z_]*$/);
    }
  });

  test("the DenyCode type actually constrains — an invented code does not compile", () => {
    // Compile-time, so it cannot be asserted at runtime; this records the
    // property and fails loudly if someone widens the type to `string`.
    const code: DenyCode = "quota";
    // @ts-expect-error — "not_a_real_gate" is not a member of DenyCode
    const bad: DenyCode = "not_a_real_gate";
    expect(code).toBe("quota");
    // Compared as a string: `bad` is typed DenyCode (the suppression above
    // applies to the assignment, not to the variable), so a direct toBe()
    // would itself be the type error this case is demonstrating.
    expect(String(bad)).toBe("not_a_real_gate");
  });
});
