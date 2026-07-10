import { describe, expect, test } from "bun:test";

import {
  ADMIN_ENTITY_NAME_RE,
  isValidAdminEntityName,
  isValidToolName,
  splitToolKey,
  TOOL_KEY_SEPARATOR,
  TOOL_NAME_RE,
  toolKey,
} from "../identifier.js";

// ---------------------------------------------------------------------------
// Mutation-testing backstop for `src/lib/identifier.ts` — the shared
// identifier-shape primitives (`TOOL_NAME_RE` / `ADMIN_ENTITY_NAME_RE`) and
// the `client__tool` composite-key encode/decode pair (`toolKey` /
// `splitToolKey`). Pure regex + string logic, no I/O.
// ---------------------------------------------------------------------------

describe("TOOL_NAME_RE / isValidToolName", () => {
  test("accepts a plain lowercase name", () => {
    expect(isValidToolName("abc")).toBe(true);
    expect(TOOL_NAME_RE.test("abc")).toBe(true);
  });

  test("accepts a single character (digit) — minimum length", () => {
    expect(isValidToolName("a")).toBe(true);
    expect(isValidToolName("9")).toBe(true);
  });

  test("accepts hyphens and underscores in the tail", () => {
    expect(isValidToolName("my-tool_name")).toBe(true);
  });

  test("accepts a leading digit", () => {
    expect(isValidToolName("9lives")).toBe(true);
  });

  test("rejects empty string", () => {
    expect(isValidToolName("")).toBe(false);
  });

  test("rejects a leading hyphen", () => {
    expect(isValidToolName("-abc")).toBe(false);
  });

  test("rejects a leading underscore", () => {
    expect(isValidToolName("_abc")).toBe(false);
  });

  test("rejects uppercase letters anywhere", () => {
    expect(isValidToolName("Abc")).toBe(false);
    expect(isValidToolName("abC")).toBe(false);
  });

  test("rejects interior spaces", () => {
    expect(isValidToolName("ab c")).toBe(false);
  });

  test("rejects characters outside [a-z0-9_-]", () => {
    expect(isValidToolName("abc.def")).toBe(false);
    expect(isValidToolName("abc$")).toBe(false);
  });

  test("accepts exactly 63 characters (boundary: 1 + 62)", () => {
    const name = "a" + "b".repeat(62);
    expect(name).toHaveLength(63);
    expect(isValidToolName(name)).toBe(true);
  });

  test("rejects 64 characters — one past the boundary", () => {
    const name = "a" + "b".repeat(63);
    expect(name).toHaveLength(64);
    expect(isValidToolName(name)).toBe(false);
  });

  test("anchors at both ends — rejects trailing junk after a valid prefix", () => {
    // Confirms `^`/`$` anchoring (as opposed to an unanchored search) and
    // that the regex doesn't merely test a prefix/substring match.
    expect(isValidToolName("abc\n")).toBe(false);
    expect(isValidToolName("abc-def-extra-trailing-garbage!")).toBe(false);
  });
});

describe("ADMIN_ENTITY_NAME_RE / isValidAdminEntityName", () => {
  test("accepts a plain mixed-case name", () => {
    expect(isValidAdminEntityName("MyTeam")).toBe(true);
    expect(ADMIN_ENTITY_NAME_RE.test("MyTeam")).toBe(true);
  });

  test("accepts a single character (letter) — minimum length", () => {
    expect(isValidAdminEntityName("A")).toBe(true);
    expect(isValidAdminEntityName("9")).toBe(true);
  });

  test("accepts interior spaces (unlike TOOL_NAME_RE)", () => {
    expect(isValidAdminEntityName("My Team Name")).toBe(true);
  });

  test("accepts hyphens and underscores in the tail", () => {
    expect(isValidAdminEntityName("My-Team_1")).toBe(true);
  });

  test("rejects empty string", () => {
    expect(isValidAdminEntityName("")).toBe(false);
  });

  test("rejects a leading space", () => {
    expect(isValidAdminEntityName(" MyTeam")).toBe(false);
  });

  test("rejects a leading hyphen", () => {
    expect(isValidAdminEntityName("-MyTeam")).toBe(false);
  });

  test("rejects characters outside [a-zA-Z0-9 _-]", () => {
    expect(isValidAdminEntityName("Team!")).toBe(false);
    expect(isValidAdminEntityName("Team.Name")).toBe(false);
  });

  test("accepts exactly 63 characters (boundary: 1 + 62)", () => {
    const name = "A" + "b".repeat(62);
    expect(name).toHaveLength(63);
    expect(isValidAdminEntityName(name)).toBe(true);
  });

  test("rejects 64 characters — one past the boundary", () => {
    const name = "A" + "b".repeat(63);
    expect(name).toHaveLength(64);
    expect(isValidAdminEntityName(name)).toBe(false);
  });

  test("anchors at both ends — rejects trailing junk after a valid prefix", () => {
    expect(isValidAdminEntityName("Team\n")).toBe(false);
    expect(isValidAdminEntityName("Valid Team Name!!")).toBe(false);
  });
});

describe("TOOL_NAME_RE vs ADMIN_ENTITY_NAME_RE — deliberately distinct rules", () => {
  // Guards against the two regexes ever being collapsed into one another.
  test("a tool name with interior spaces is invalid, but valid as an admin entity name", () => {
    expect(isValidToolName("my team")).toBe(false);
    expect(isValidAdminEntityName("my team")).toBe(true);
  });

  test("an uppercase admin entity name is valid, but invalid as a tool name", () => {
    expect(isValidToolName("MyTeam")).toBe(false);
    expect(isValidAdminEntityName("MyTeam")).toBe(true);
  });
});

describe("TOOL_KEY_SEPARATOR", () => {
  test("is exactly two underscores", () => {
    expect(TOOL_KEY_SEPARATOR).toBe("__");
    expect(TOOL_KEY_SEPARATOR).toHaveLength(2);
  });
});

describe("toolKey", () => {
  test("joins clientName and toolName with the separator", () => {
    expect(toolKey("myclient", "mytool")).toBe("myclient__mytool");
  });

  test("uses the actual separator constant, not a hardcoded literal", () => {
    // Cross-checks against TOOL_KEY_SEPARATOR itself so a mutation to the
    // separator constant is caught here too, not just in the joined string.
    expect(toolKey("a", "b")).toBe(`a${TOOL_KEY_SEPARATOR}b`);
  });

  test("distinct client/tool pairs produce distinct keys", () => {
    expect(toolKey("client1", "tool")).not.toBe(toolKey("client2", "tool"));
    expect(toolKey("client", "tool1")).not.toBe(toolKey("client", "tool2"));
  });
});

describe("splitToolKey", () => {
  test("splits a canonical key back into [clientName, toolName]", () => {
    expect(splitToolKey("myclient__mytool")).toEqual(["myclient", "mytool"]);
  });

  test("round-trips through toolKey for a variety of names", () => {
    for (const [client, tool] of [
      ["a", "b"],
      ["my-client", "my_tool"],
      ["client9", "tool0"],
    ] as const) {
      expect(splitToolKey(toolKey(client, tool))).toEqual([client, tool]);
    }
  });

  test("splits at the FIRST separator occurrence — tool name may itself contain '__'", () => {
    // clientName never legitimately contains "__" (TOOL_NAME_RE forbids
    // double underscores from being ambiguous in practice via convention),
    // but splitToolKey must still resolve deterministically using indexOf
    // (first match), not lastIndexOf (last match), when '__' appears more
    // than once in the composite key.
    expect(splitToolKey("client__tool__extra")).toEqual(["client", "tool__extra"]);
  });

  test("throws when the separator is absent", () => {
    expect(() => splitToolKey("no-separator-here")).toThrow("Invalid tool key (no '__' separator): no-separator-here");
  });

  test("throws on empty string", () => {
    expect(() => splitToolKey("")).toThrow(/Invalid tool key/);
  });

  test("handles the separator at the very start (empty clientName)", () => {
    expect(splitToolKey("__tool")).toEqual(["", "tool"]);
  });

  test("handles the separator at the very end (empty toolName)", () => {
    expect(splitToolKey("client__")).toEqual(["client", ""]);
  });
});
