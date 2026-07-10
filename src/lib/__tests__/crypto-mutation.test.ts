import { describe, expect, test } from "bun:test";

import { sha256Hex } from "../crypto.js";

// ---------------------------------------------------------------------------
// sha256Hex — direct unit tests
//
// Mutation-testing backstop for `src/lib/crypto.ts`. The function is a thin,
// one-line wrapper around `node:crypto`'s `createHash("sha256").update(input,
// "utf8").digest("hex")` — no branches, no loops. The only mutable surface is
// the three string literals ("sha256", "utf8", "hex"); Stryker's
// StringLiteral mutator can blank any of them out. Known-answer vectors
// (verified against Node's `crypto` module directly) pin down the exact
// algorithm/encoding combination:
//   * "sha256" -> "" throws (invalid digest algorithm), killed by any test.
//   * "hex" -> "" changes the returned encoding, killed by the hex-shape /
//     known-answer assertions.
//   * "utf8" -> "" is a confirmed EQUIVALENT mutant, not a gap: Node's
//     `Hash.update(str, encoding)` normalizes an unrecognized/empty encoding
//     to the same default as "utf8" internally, so the output is
//     byte-for-byte identical for every input, including multi-byte UTF-8
//     and Latin-1-range characters (verified by hand-applying the mutation
//     and diffing digests directly against `node:crypto` — see
//     src/lib/crypto.ts's mutation-testing notes). No test can kill it.
// ---------------------------------------------------------------------------

describe("sha256Hex — known-answer vectors", () => {
  test("empty string", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test("'abc'", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("'hello'", () => {
    expect(sha256Hex("hello")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
});

describe("sha256Hex — output shape", () => {
  test("returns a 64-character lowercase hex string", () => {
    const digest = sha256Hex("some arbitrary input");
    expect(digest).toHaveLength(64);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is deterministic for the same input", () => {
    expect(sha256Hex("repeatable")).toBe(sha256Hex("repeatable"));
  });

  test("different inputs produce different digests", () => {
    expect(sha256Hex("input-a")).not.toBe(sha256Hex("input-b"));
  });
});

describe("sha256Hex — multi-byte input", () => {
  // Pins the exact byte sequence produced for a multi-byte UTF-8 string.
  // (Note: this does NOT distinguish the "utf8" encoding literal from an
  // emptied one — see the equivalent-mutant note above — but it does catch
  // any other change to how the input is turned into bytes before hashing.)
  test("multi-byte UTF-8 input matches the known digest of its UTF-8 bytes", () => {
    expect(sha256Hex("héllo 🚀")).toBe("d87b4a76e84eea9f187f77311aaa08530b086d1c5aebf4024357286b35cebdcb");
  });
});
