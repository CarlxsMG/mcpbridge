/**
 * Stryker mutation-testing backstop for src/tool-meta/tool-tags.ts.
 * Baseline 96.97% (32/33) — the existing tool-tags.test.ts already covers
 * normalization+dedup, invalid-tag rejection, unknown-tool rejection,
 * listAllTags/listToolsByTag, and (indirectly, via registry.ts's own
 * getClientDetail/listAllTools integration) getTagsForClient/getAllToolTags.
 * The one gap: no test ever supplies a tag with leading/trailing whitespace,
 * so `.trim()` being dropped from `normalizeTag` was never observed.
 */
import { describe, test, expect } from "bun:test";
import { normalizeTag } from "../tool-tags.js";

// 8:10-8:20 MethodExpression [Survived] (`raw.trim()` collapsed to `raw`,
// leaving only `.toLowerCase()`). Every existing tag in the sibling test
// file is already whitespace-free, so this never diverges there.
describe("normalizeTag — trims whitespace before lowercasing", () => {
  test("leading and trailing whitespace is stripped, not just the case", () => {
    expect(normalizeTag("  Billing  ")).toBe("billing");
  });
});
