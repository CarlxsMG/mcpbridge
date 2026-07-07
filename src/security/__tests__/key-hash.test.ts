import { describe, expect, test } from "bun:test";

import { hashApiKey, isKeyAllowed } from "../key-hash.js";

// ---------------------------------------------------------------------------
// key-hash — direct unit tests (Stryker mutation backstop for
// src/security/key-hash.ts). Before P2-3 this module had only indirect
// coverage (guard `allowed_key_hashes` exercised through the auth paths), and
// two mutants survived:
//
//   * ConditionalExpression (line 20, replacement `false`) — the fail-closed
//     guard `if (!token || !allowedHashes || allowedHashes.length === 0)`
//     collapses to `if (false)`, so an empty/undefined token falls through to
//     hash-and-compare instead of returning false.
//   * MethodExpression (line 22, replacement `.every`) — `allowedHashes.some`
//     flips to `.every`, which still passes the single-hash lists that the
//     indirect coverage happened to use.
//
// NOTE — one EQUIVALENT mutant remains on line 20 and is intentionally left
// unkilled: `allowedHashes.length === 0` → `false` (Stryker col 35-61).
// Removing that length check is behaviourally identical to the original: when
// `allowedHashes` is `[]`, the guard's early `return false` and the
// fall-through `[].some(...) === false` yield the same result — the only
// difference is one wasted (side-effect-free) `hashApiKey(token)` call. Proven
// empirically; it is a true equivalent mutant, not a coverage gap. (The whole
// guard → `false`, col 7-61, IS killed by the empty-token test below.)
// ---------------------------------------------------------------------------

describe("hashApiKey", () => {
  test("is a deterministic 64-char lowercase hex SHA-256 digest", () => {
    const h = hashApiKey("hunter2");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey("hunter2")).toBe(h);
    expect(hashApiKey("hunter3")).not.toBe(h);
  });
});

describe("isKeyAllowed — fails closed on the guard clause", () => {
  // Kills L20 ConditionalExpression (`if (false)`): an empty token must return
  // false EVEN when its own hash is present. The mutant skips the guard, hashes
  // "" and finds the match → true; the original short-circuits on `!token`.
  test("empty token returns false even if its own hash is listed (kills L20 ConditionalExpression)", () => {
    expect(isKeyAllowed("", [hashApiKey("")])).toBe(false);
  });

  test("undefined token, missing list, and empty list all fail closed", () => {
    expect(isKeyAllowed(undefined, [hashApiKey("x")])).toBe(false);
    expect(isKeyAllowed("x", undefined)).toBe(false);
    expect(isKeyAllowed("x", [])).toBe(false);
  });
});

describe("isKeyAllowed — matches against the whole list", () => {
  // Kills L22 MethodExpression (`.some` → `.every`): with a matching hash among
  // decoys, `.some` is true but `.every` is false. A single-hash list (all the
  // indirect coverage ever used) cannot tell the two apart.
  test("returns true when the token hash is one of several (kills L22 .some→.every)", () => {
    expect(isKeyAllowed("right-key", [hashApiKey("wrong-key"), hashApiKey("right-key")])).toBe(true);
  });

  test("returns false when the token hash is absent from a populated list", () => {
    expect(isKeyAllowed("intruder", [hashApiKey("a"), hashApiKey("b")])).toBe(false);
  });
});
