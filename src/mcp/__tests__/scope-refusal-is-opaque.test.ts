/**
 * A scope refusal must stay indistinguishable from "no such tool".
 *
 * `/mcp/:clientName` and `/mcp-custom/:bundleName` narrow the tool surface, and
 * when a caller names something outside their scope the answer is the same
 * `Unknown tool: <name>` a genuinely missing name gets. That uniformity is the
 * defence: any difference — wording, an error code, a timing tell — lets an
 * unauthorised caller enumerate what exists behind a shard they cannot reach.
 *
 * This file exists because the deny-code work made that easy to break by
 * accident. Every OTHER refusal in the dispatch path now carries a machine
 * -readable `denyCode`, so these three look like an oversight, and "finish
 * tagging the refusals" is a natural, well-intentioned follow-up that would
 * hand back the oracle. The check below fails on that change instead.
 *
 * Verified against the running gateway before being written: a disabled tool
 * over a real MCP session returns `denyCode: "disabled"`, while a name outside
 * the shard returns no code at all.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "..", "mcp-server.ts"), "utf8");

/**
 * The scope-refusal returns: every `Unknown tool: ${name}` literal in the
 * request handler, with the object literal it sits in.
 */
function scopeRefusals(): string[] {
  return [
    ...SRC.matchAll(/return \{[^}]*?content: \[\{ type: "text", text: `Unknown tool: \$\{name\}` \}\],?\s*\}/gs),
  ].map((m) => m[0]);
}

describe("scope refusals stay opaque", () => {
  test("both scope branches still refuse with the shared, uninformative message", () => {
    // A floor. If this drops to zero the cases below pass vacuously and the
    // property stops being guarded at all.
    expect(scopeRefusals().length).toBeGreaterThanOrEqual(2);
  });

  test("no scope refusal carries a denyCode", () => {
    const tagged = scopeRefusals().filter((r) => r.includes("denyCode"));
    expect(
      tagged,
      "A scope refusal must not be distinguishable from a missing tool — that is an enumeration oracle, " +
        "not an inconsistency to tidy up. See the comments at these sites.",
    ).toEqual([]);
  });

  test("the client and bundle branches refuse with the SAME text", () => {
    // Different wording would leak the distinction just as effectively as a
    // code would, and is the easier slip to make while editing one branch.
    const texts = scopeRefusals().map((r) => /text: (`[^`]*`)/.exec(r)?.[1]);
    expect(new Set(texts).size).toBe(1);
  });

  test("neither branch uses denyResult", () => {
    // The other way in: swapping the object literal for the helper would add
    // the code without the word `denyCode` ever appearing at the call site.
    const handlerUsesDenyResult = /denyResult\([^)]*Unknown tool/.test(SRC);
    expect(handlerUsesDenyResult).toBe(false);
  });
});
