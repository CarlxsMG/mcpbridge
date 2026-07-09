/**
 * Stryker mutation-testing backstop for src/discovery/curl-postman-discovery.ts —
 * manual closing pass after the 5-agent cold round (cp1-cp5), closing the
 * remaining real gaps and documenting genuine equivalents for the rest.
 *
 * Targets these surviving mutants from the post-cold-round verify run:
 *
 *   L107:13-107:19 AssignmentOperator (`j += 2` -> `j -= 2`, in
 *   tokenizeShellLike's double-quote escape handling). Not covered by cp1's
 *   own 10 documented equivalents despite their similar citations at
 *   neighboring lines. Verified empirically (a hand-simulated copy with a
 *   1000-iteration safety guard) that a MID-STRING escape genuinely sends
 *   this into an infinite loop under the mutant (`j` walks backward forever
 *   once it passes the escape). A test exercising this is expected to
 *   surface as a Stryker Timeout, not a Killed status — same "detected via
 *   timeout" convention used throughout this program.
 *
 *   L146:7-146:32 ConditionalExpression true (`typeof input !== "string"`
 *   forced always-true — NOTE: the column range is the FIRST half only of
 *   `typeof input !== "string" || !input.trim()`, not the whole guard).
 *   Every existing empty/whitespace-only-input test uses a genuine STRING,
 *   for which `typeof input !== "string"` is ALREADY false regardless of
 *   this mutation — it never diverges for those inputs. Only a genuinely
 *   NON-STRING input (bypassing the TS type at the JS runtime boundary)
 *   distinguishes it: real code's `typeof` check catches it and throws a
 *   clean message; the forced-false mutant skips straight to
 *   `!input.trim()`, which throws an unrelated TypeError on a non-string.
 *
 *   L150:56-150:59 StringLiteral "" (the `.replace(regex, " ")` replacement
 *   space, emptied). The cold round's two tests for this line both
 *   coincidentally had a real, ALREADY-PRESENT whitespace character
 *   adjacent to the backslash+newline match (from surrounding text outside
 *   the match itself), so removing the match's OWN replacement character
 *   left an unrelated space behind anyway — no visible difference. Needs a
 *   continuation where the backslash+newline sits directly between two
 *   words with NO other whitespace anywhere nearby, so dropping the
 *   replacement space merges them into one bogus token.
 *
 *   L348:17-348:65 MethodExpression (`.filter(Boolean)` dropped from the
 *   folder-label pipeline) and L348:71-348:74 StringLiteral (the `"_"` join
 *   separator emptied). The cold round's "2-level-deep folder nest" fixture
 *   used Capitalized segment names ("Alpha", "Beta", "Widget") — the SAME
 *   "caller normalization masks a helper's mutant" pattern already
 *   documented for openapi-discovery.ts's generateToolName: sanitizeToolName
 *   applies its OWN camelCase-boundary regex
 *   (`replace(/([a-z0-9])([A-Z])/g, "$1_$2")`), which happens to reinsert
 *   the EXACT same underscores a dropped `.join("_")` separator would have
 *   provided, for any fixture where every segment starts with an uppercase
 *   letter. All-LOWERCASE segment names avoid this masking entirely. The
 *   `.filter(Boolean)` drop needed a separate fixture: a genuinely empty
 *   leaf name (`name: ""`, not undefined) produces a trailing empty array
 *   element that only the real `.filter(Boolean)` removes — its absence
 *   survives all the way through `sanitizeToolName` as a trailing
 *   underscore, since that function only strips LEADING invalid characters.
 *
 *   L413:18-413:57 MethodExpression (the `.trim()` call dropped from
 *   `(rawUrl.split("?")[0] ?? rawUrl).trim()`). The cold round's
 *   unparseable-URL fixtures never had any leading/trailing whitespace to
 *   actually trim — a genuinely surrounding-whitespace URL is needed to
 *   observe the strip.
 *
 * Documented equivalent (verified empirically, not assumed):
 *
 *   L434:9-434:24 ConditionalExpression true (`parsed !== null` forced
 *   always-true, in extractBodyKeys' `if (parsed !== null && typeof parsed
 *   === "object" && !Array.isArray(parsed))`). For any NON-null parsed
 *   value this check was already true regardless of the mutation — no
 *   divergence. For a JSON body that's literally `null`, forcing the check
 *   true makes the code attempt `Object.keys(null)`, which throws — but
 *   that throw happens INSIDE the same try block that wraps the initial
 *   `JSON.parse` call, so it's caught by the SAME catch clause (which does
 *   nothing) and falls through to the urlencoded-regex fallback check,
 *   which cannot match the literal text "null" (no "=" character anywhere
 *   in it) — both real and mutant therefore return the identical final `[]`
 *   for a null JSON body. Verified via a hand-traced simulation of both
 *   code paths reaching the same external result through different
 *   internal routes.
 */
import { describe, test, expect } from "bun:test";
import { parseCurlCommand, parsePostmanCollection } from "../curl-postman-discovery.js";

// 107:13-107:19 AssignmentOperator [Timeout-expected] (`j += 2` -> `j -= 2`).
describe("tokenizeShellLike — a mid-string double-quote escape does not corrupt parsing", () => {
  test("an escaped quote in the middle of a double-quoted header value round-trips correctly", () => {
    const [tool] = parseCurlCommand(String.raw`curl -H "X-Foo: a\"b" http://example.com/x`);
    expect(tool.description).toContain("X-Foo");
  });
});

// 146:7-146:32 ConditionalExpression [Survived] true (`typeof input !== "string"`
// forced always-true — only the FIRST half of the top-level guard).
describe("parseCurlCommand — a non-string input is rejected cleanly, not via an unrelated crash", () => {
  test("a null input throws the clean 'No cURL command provided' message", () => {
    expect(() => parseCurlCommand(null as unknown as string)).toThrow("No cURL command provided");
  });
});

// 150:56-150:59 StringLiteral [Survived] "" (the line-continuation replacement
// space, emptied).
describe("parseCurlCommand — a line continuation directly between two words still inserts a separating space", () => {
  test("a backslash+newline with no other adjacent whitespace joins into two distinct tokens, not one merged one", () => {
    const cmd = "curl\\\n-X POST http://example.com/x";
    const [tool] = parseCurlCommand(cmd);
    expect(tool.method).toBe("POST");
    expect(tool.endpoint).toBe("/x");
  });
});

// 348:17-348:65 MethodExpression [Survived] (`.filter(Boolean)` dropped) and
// 348:71-348:74 StringLiteral [Survived] "" (the "_" join separator emptied).
// All-lowercase segment names avoid sanitizeToolName's own camelCase-boundary
// regex reinserting the same underscores a dropped separator would have
// provided (the masking trap the cold round's Capitalized fixture fell into).
describe("Postman folder-label join — separator and filter both matter with lowercase segments", () => {
  test("lowercase folder/leaf segments are joined with underscores, not concatenated", () => {
    const collection = {
      item: [
        {
          name: "alpha",
          item: [
            { name: "beta", item: [{ name: "widget", request: { method: "GET", url: "https://api.example.com/x" } }] },
          ],
        },
      ],
    };
    const tools = parsePostmanCollection(collection);
    expect(tools[0].name).toBe("alpha_beta_widget");
  });

  test("an explicit empty-string leaf name is filtered out, not joined as a trailing empty segment", () => {
    const collection = {
      item: [
        {
          name: "alpha",
          item: [{ name: "beta", item: [{ name: "", request: { method: "GET", url: "https://api.example.com/x" } }] }],
        },
      ],
    };
    const tools = parsePostmanCollection(collection);
    expect(tools[0].name).toBe("alpha_beta");
  });
});

// 413:18-413:57 MethodExpression [Survived] (`.trim()` dropped from the
// literal-path fallback).
describe("extractPathAndQuery — the literal-path fallback trims surrounding whitespace", () => {
  test("leading/trailing whitespace around an unparseable URL is stripped, not embedded in the path", () => {
    const [tool] = parseCurlCommand(`curl "  not a valid url with spaces  "`);
    expect(tool.endpoint).toBe("/not a valid url with spaces");
  });
});
