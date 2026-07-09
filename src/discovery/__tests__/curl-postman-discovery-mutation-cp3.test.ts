/**
 * Stryker mutation-testing backstop — domain 6 (src/discovery/), cluster cp3:
 * parsePostmanCollection's top-level validation + recursive `walk()` closure,
 * and parsePostmanLeaf (curl-postman-discovery.ts lines 249-359).
 *
 * Baseline mutation run (reports/mutation/result.json) was re-queried directly
 * (filtered to lines 249-359) to get ground truth on survivors before writing
 * any test here — see each test's header comment for the exact surviving
 * mutant ids/line:col this file targets. Do not trust line:col claims that
 * aren't re-derived from that report.
 *
 * Two mutants in this range are treated as EQUIVALENT (documented, not
 * chased) rather than missing coverage:
 *
 *  - id 355, line 318 col 20, `typeof item !== "object"` -> `false` inside
 *    `if (!item || typeof item !== "object") continue;`. This half of the
 *    guard can only diverge from `false` when `item` is truthy AND not an
 *    object (a non-null primitive: string/number/boolean/function). But
 *    every subsequent property access in `walk()`/`parsePostmanLeaf`
 *    (`item.item`, `item.request`) is a plain `.prop` read, which JS
 *    auto-boxes safely on any primitive (returns `undefined`, never throws).
 *    So whether this clause is real or forced `false`, a truthy primitive
 *    item is *always* silently skipped later (no `.item` array, no
 *    `.request`) with identical observable output. Verified empirically:
 *    there is no input value for which this half of the condition changes
 *    the resulting `tools[]` or thrown error.
 *  - id 385, line 345 col 38, the `[]` fallback in `(req.header ?? []).filter(...)`
 *    replaced with `["Stryker was here"]`. The filter predicate is
 *    `!h?.disabled && h?.key`; for a bare string element `h`, both
 *    `h?.disabled` and `h?.key` are `undefined` (strings have neither
 *    property), so `!undefined && undefined` is falsy and the element is
 *    always filtered back out — the fallback only ever matters when
 *    `req.header` is nullish, and in that case both the real `[]` and the
 *    mutant's single-string array reduce to the same empty `headerNames`
 *    after filtering. No input distinguishes them.
 */
import { describe, test, expect } from "bun:test";
import { parsePostmanCollection } from "../../discovery/curl-postman-discovery.js";

describe("parsePostmanCollection — top-level validation (lines 305-310)", () => {
  // Kills ids 334, 335, 336, 338, 341 (line 305, cols 7/7/24/50 —
  // ConditionalExpression->false x3, LogicalOperator ||->&&, BlockStatement->{})
  // and id 342 (line 306 col 21, StringLiteral -> "").
  // Each of these mutants leaves the `json === null || typeof json !== "object"`
  // guard un-triggered (or its throw body emptied) for at least one of the two
  // inputs below, so the function falls through to a LATER guard/native error
  // with a DIFFERENT message — asserting the exact message on both inputs
  // catches every variant, since a generic `.toThrow()` (no message) would
  // pass regardless of which guard fired.
  test("rejects a non-object input with the exact top-level validation message", () => {
    expect(() => parsePostmanCollection("not json")).toThrow("Postman collection must be a JSON object");
    expect(() => parsePostmanCollection(null)).toThrow("Postman collection must be a JSON object");
  });

  // Kills ids 345, 346 (line 309 cols 7/40 — ConditionalExpression->false,
  // BlockStatement->{}) and id 347 (line 310 col 21, StringLiteral -> "").
  // Same reasoning: a neutralized guard here falls through to `walk(undefined, [])`,
  // which throws a native "not iterable" TypeError instead — a different message.
  test("rejects a collection missing its top-level 'item' array with the exact message", () => {
    expect(() => parsePostmanCollection({ info: { name: "x" } })).toThrow(
      "Postman collection is missing its top-level 'item' array",
    );
  });
});

describe("parsePostmanCollection — walk() tree traversal (lines 316-328)", () => {
  // Kills ids 352, 353 (line 318 col 11 — ConditionalExpression->false and
  // LogicalOperator `!item && typeof item !== "object"`). With either mutant,
  // a `null` array entry is NOT skipped by this guard, so `walk` proceeds to
  // read `item.item` off `null`, throwing a native TypeError and making the
  // whole parse throw — whereas real code silently skips it and still
  // returns the one valid tool from the well-formed sibling entry.
  test("skips a null entry in the items array without crashing the whole parse", () => {
    const collection = {
      item: [null, { name: "Real", request: { method: "GET", url: "https://api.example.com/real" } }],
    };
    const tools = parsePostmanCollection(collection);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("real");
    expect(tools[0].endpoint).toBe("/real");
  });

  // Kills id 364 (line 323 col 11, ConditionalExpression->false on
  // `if (!item.request) continue;`). An item that is neither a folder
  // (no `item.item` array) nor a leaf (no `item.request`) must be skipped
  // silently. With the mutant, the guard never fires and `parsePostmanLeaf`
  // is called with `item.request` undefined, throwing when it reads
  // `req.method` off it (non-null assertion is compile-time only).
  test("skips an item that is neither a folder nor a request, leaving siblings intact", () => {
    const collection = {
      item: [{ name: "Orphan" }, { name: "Real", request: { method: "GET", url: "https://api.example.com/real" } }],
    };
    const tools = parsePostmanCollection(collection);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("real");
  });

  // Kills id 365 (line 325 col 11, ConditionalExpression `if (tool) ...` -> `true`)
  // and id 379 (line 339 col 7, ConditionalExpression `if (!SUPPORTED_METHODS...) return null` -> `false`).
  // A HEAD request is an unsupported method: parsePostmanLeaf must return
  // null and walk() must NOT push that null onto tools. Forcing either guard
  // makes tools include the HEAD item (as `null`, or as a real-looking
  // "HEAD" tool), so `tools` would have length 2 instead of 1.
  test("drops an unsupported-method leaf (HEAD) instead of registering or null-pushing it", () => {
    const collection = {
      item: [
        { name: "NotAllowed", request: { method: "HEAD", url: "https://api.example.com/head" } },
        { name: "Allowed", request: { method: "GET", url: "https://api.example.com/get" } },
      ],
    };
    const tools = parsePostmanCollection(collection);
    expect(tools).toHaveLength(1);
    expect(tools[0].method).toBe("GET");
    expect(tools[0].endpoint).toBe("/get");
  });

  // Bonus defensive coverage (not tied to a surviving mutant in the queried
  // range — line 320's `item.name ? [...folderPath, item.name] : folderPath`
  // mutants were already killed at baseline) per the assignment notes: a
  // folder with no `name` must still descend into its children without
  // adding a bogus/empty prefix segment to the label.
  test("a nameless folder still descends into its children without adding a bogus prefix segment", () => {
    const collection = {
      item: [{ item: [{ name: "Leaf", request: { method: "GET", url: "https://api.example.com/leaf" } }] }],
    };
    const tools = parsePostmanCollection(collection);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("leaf");
  });
});

describe("parsePostmanCollection — parsePostmanLeaf (lines 336-358)", () => {
  // Kills id 376 (line 338 col 36, StringLiteral "GET" -> ""). If the
  // default fallback is emptied, `rawMethod` becomes "" (unsupported),
  // so this leaf would be silently dropped and the parse would throw
  // "no valid requests" instead of returning one GET tool.
  test("a leaf with no method defaults to GET", () => {
    const collection = {
      item: [{ name: "Implicit", request: { url: "https://api.example.com/implicit" } }],
    };
    const tools = parsePostmanCollection(collection);
    expect(tools).toHaveLength(1);
    expect(tools[0].method).toBe("GET");
    expect(tools[0].endpoint).toBe("/implicit");
  });

  // Kills id 381 (line 343 col 7, ConditionalExpression `if (path === null) return null` -> `false`)
  // and id 372 (line 331 col 21, StringLiteral -> "" on the "no valid requests" message).
  // A request with no `url` at all resolves to `path === null` from
  // extractPostmanUrl, so this (only) leaf must be dropped and the whole
  // parse must throw with the exact "no valid requests" message. If the
  // path-null guard is neutralized, a bogus tool with a null endpoint would
  // be registered instead and the call would NOT throw.
  test("a leaf with no url at all is dropped, not registered with a null endpoint", () => {
    const collection = { item: [{ name: "NoUrl", request: { method: "GET" } }] };
    expect(() => parsePostmanCollection(collection)).toThrow("No valid requests found in Postman collection");
  });

  // Kills id 383 (line 345 col 23, MethodExpression collapsing
  // `(req.header ?? []).filter(...).map(...)` down to just `req.header ?? []`
  // — i.e. dropping the filter/map so raw header objects would leak into
  // headerNames instead of their sanitized `.key` strings), id 387 (col 56
  // ConditionalExpression -> true, which would keep the disabled header),
  // id 389 (col 56 LogicalOperator `!h?.disabled || h?.key`, which would
  // also keep the disabled header since its truthy `key` short-circuits the
  // `||`), ids 391/392 (cols 57/72 OptionalChaining removed on
  // `h?.disabled`/`h?.key` — reading either property off the literal `null`
  // header entry below throws instead of being safely filtered out), and
  // id 403 (line 355 col 33, StringLiteral "Postman" -> "", which drops the
  // "Postman" source label from the description).
  test("header filtering: keeps only enabled, keyed headers and tolerates malformed entries", () => {
    const collection = {
      item: [
        {
          name: "HeaderTest",
          request: {
            method: "GET",
            url: "https://api.example.com/headers-test",
            header: [{ key: "Accept" }, { key: "Old", disabled: true }, { value: "NoKeyHere" }, null],
          },
        },
      ],
    };
    const tools = parsePostmanCollection(collection);
    expect(tools).toHaveLength(1);
    expect(tools[0].description).toBe(
      "Imported from Postman: GET /headers-test. Headers seen on the source request " +
        "(not applied automatically — configure upstream auth or a request transform if needed): Accept",
    );
  });

  // Kills id 397 (line 348 col 17, MethodExpression collapsing
  // `[...folderPath, item.name ?? ""].filter(Boolean).join("_")` down to the
  // bare (unjoined, unfiltered) array — passing a non-string label onward)
  // and id 401 (line 348 col 71, StringLiteral "_" -> "", which would join
  // folder segments with no separator at all). A 2-level-deep folder nest
  // proves the underscore-joined prefix accumulates correctly end to end.
  test("a 2-level-deep folder nest accumulates an underscore-joined name prefix", () => {
    const collection = {
      item: [
        {
          name: "Alpha",
          item: [
            {
              name: "Beta",
              item: [{ name: "Widget", request: { method: "GET", url: "https://api.example.com/widget" } }],
            },
          ],
        },
      ],
    };
    const tools = parsePostmanCollection(collection);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("alpha_beta_widget");
  });

  // Kills id 400 (line 348 col 46, StringLiteral "" -> "Stryker was here!" on
  // the `item.name ?? ""` fallback). A leaf with no `name` at all must fall
  // through the (now-empty, filtered-out) label array to
  // `generateNameFromPath`, not adopt a literal placeholder string as its
  // name.
  test("a leaf with no name falls back to a path-derived name, not a placeholder", () => {
    const collection = {
      item: [{ request: { method: "GET", url: "https://api.example.com/nameless" } }],
    };
    const tools = parsePostmanCollection(collection);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("get_nameless");
  });
});
