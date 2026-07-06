import { describe, test, expect } from "bun:test";
import { sanitizeToolName, uniqueToolName, TOOL_NAME_RE } from "../../discovery/tool-naming.js";

describe("sanitizeToolName", () => {
  test("normalizes camelCase and strips invalid characters", () => {
    expect(sanitizeToolName("updatePet")).toBe("update_pet");
    expect(sanitizeToolName("get-user")).toBe("get-user");
    expect(sanitizeToolName("Foo Bar!")).toBe("foo_bar_");
  });

  test("falls back to a placeholder for an empty/all-invalid input", () => {
    expect(sanitizeToolName("")).toBe("op");
    expect(sanitizeToolName("___")).toBe("op");
  });

  test("truncates to the registry's max length", () => {
    const long = "a".repeat(100);
    const result = sanitizeToolName(long);
    expect(result.length).toBeLessThanOrEqual(63);
    expect(TOOL_NAME_RE.test(result)).toBe(true);
  });
});

describe("uniqueToolName", () => {
  test("returns the name unchanged when not yet used", () => {
    const used = new Set<string>();
    expect(uniqueToolName("foo", used)).toBe("foo");
    expect(used.has("foo")).toBe(true);
  });

  test("disambiguates a collision with a numeric suffix", () => {
    const used = new Set(["foo"]);
    const name = uniqueToolName("foo", used);
    expect(name).toBe("foo_2");
    expect(used.has("foo_2")).toBe(true);
  });

  test("regression: terminates (does not infinite-loop) when the base name is already at the max length", () => {
    // Before the fix, appending "_2" to a 63-char name and then slicing back
    // to 63 chars discarded the suffix entirely, returning the exact same
    // (already-colliding) string forever.
    const base = "a".repeat(63);
    const used = new Set([base]);
    const name = uniqueToolName(base, used);
    expect(name).not.toBe(base);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(TOOL_NAME_RE.test(name)).toBe(true);
  });

  test("regression: keeps disambiguating across many collisions at max length without looping forever", () => {
    const base = "b".repeat(63);
    const used = new Set<string>([base]);
    const names = new Set<string>([base]);
    for (let i = 0; i < 20; i++) {
      const name = uniqueToolName(base, used);
      expect(names.has(name)).toBe(false);
      names.add(name);
      used.add(name);
    }
  });
});
