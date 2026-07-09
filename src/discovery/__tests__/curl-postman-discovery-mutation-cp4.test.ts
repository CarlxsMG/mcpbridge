/**
 * Stryker mutation-testing backstop — domain 6 (src/discovery/), cluster cp4:
 * extractPostmanUrl + extractPostmanBodyKeys (curl-postman-discovery.ts lines
 * 360-392) — the final and largest cluster of the final file in this program.
 *
 * Baseline mutation run (reports/mutation/result.json) was re-queried
 * directly (filtered to lines 360-392) to get ground truth on survivors
 * before writing any test here — see each test's header comment for the
 * exact surviving mutant id(s)/line:col it targets. Do not trust any
 * line:col claim that isn't re-derived from that report.
 *
 * Both target functions are internal (not exported) — every test below
 * drives them indirectly through the exported `parsePostmanCollection`.
 *
 * Five mutants in this range are treated as EQUIVALENT (documented, not
 * chased) rather than missing coverage — all five are a `[]` fallback
 * literal (or an object field holding one) replaced by Stryker's fixed
 * placeholder `["Stryker was here"]`, in spots where no test input can make
 * the difference observable:
 *
 *  - id 409 (line 361 col 45, the `queryKeys: []` field inside
 *    `{ path: null, queryKeys: [] }` returned by the `!url` guard) and its
 *    structural twin id 452 (line 374 col 35, the same shape in the final
 *    "neither path nor raw" fallback): in BOTH return statements `path` is a
 *    hard-coded `null` literal in that very statement, untouched by this
 *    mutant. `parsePostmanLeaf` destructures `{ path, queryKeys }` and
 *    immediately does `if (path === null) return null;` — `queryKeys` is
 *    never read before that early return, so whatever it mutates to is
 *    discarded unread. No input distinguishes real `[]` from the mutant.
 *  - id 416 (line 364 col 45, the `[]` fallback in
 *    `(url.query ?? []).filter((q) => !q?.disabled && q?.key)`) and its
 *    exact structural twins id 466 (line 383 col 34, `body.urlencoded ?? []`)
 *    and id 479 (line 385 col 32, `body.formdata ?? []`): the very next step
 *    in each chain is `.filter((x) => !x?.disabled && x?.key)`. Stryker's
 *    fixed placeholder is a bare string (`"Stryker was here"`), which has
 *    neither a `.disabled` nor a `.key` property, so `x?.key` is always
 *    `undefined` (falsy) and the placeholder element is filtered back out
 *    regardless of its content — it can never survive to the `.map()` step.
 *    Verified empirically: no shape of `url.query` / `body.urlencoded` /
 *    `body.formdata` (present, absent, or explicitly `null`) makes the
 *    mutant's final output differ from the real `[]` fallback's output.
 */
import { describe, test, expect } from "bun:test";
import { parsePostmanCollection } from "../../discovery/curl-postman-discovery.js";

describe("extractPostmanUrl via parsePostmanCollection (lines 360-375)", () => {
  // Kills ids 407 (line 361 col 7, ConditionalExpression `!url` -> `false`)
  // and 408 (line 361 col 20, ObjectLiteral `{ path: null, queryKeys: [] }`
  // -> `{}`). With either mutant, calling extractPostmanUrl(undefined) either
  // throws reaching into `.query`/`.path` off `undefined`, or yields
  // `path: undefined` (not `null`) so the `path === null` drop-guard in
  // parsePostmanLeaf never fires and a bogus tool would be registered
  // instead of this leaf being silently skipped.
  test("a request with no url at all is dropped, a valid sibling item still resolves", () => {
    const collection = {
      item: [
        { name: "NoUrl", request: { method: "GET" } },
        { name: "Valid", request: { method: "GET", url: "https://api.example.com/valid" } },
      ],
    };
    const tools = parsePostmanCollection(collection);
    expect(tools).toHaveLength(1);
    expect(tools[0].endpoint).toBe("/valid");
  });

  // Kills ids 414 (line 364 col 31, MethodExpression collapsing
  // `(url.query ?? []).filter(...).map(...)` down to the bare, unfiltered
  // `url.query ?? []` array of raw objects), 418/420 (line 364 col 63,
  // ConditionalExpression -> true / LogicalOperator `||`, which would let the
  // disabled and keyless query entries through), 422/423 (line 364 cols
  // 64/79, OptionalChaining removed on `q?.disabled`/`q?.key` — reading
  // either property off the literal `null` query entry below throws instead
  // of being safely filtered out), 425/426/427 (line 365 col 7,
  // ConditionalExpression -> true/false and LogicalOperator `||` on
  // `Array.isArray(url.path) && url.path.length > 0` — forcing this guard
  // would either skip the path array entirely and fall through to the decoy
  // `raw` url below, or (for `||`) attempt `.length` on a non-array), 428/430
  // (line 365 col 34, EqualityOperator `>= 0` / `<= 0` on `url.path.length >
  // 0` — with a 5-element path array, `<= 0` is false where the real `> 0`
  // is true, diverging into the decoy-raw fallback), 431 (line 365 col 55,
  // BlockStatement emptying the whole path-handling block, which would also
  // fall through to the decoy raw url), 433 (line 366 col 45,
  // ConditionalExpression forcing the segment ternary to always treat a
  // segment as a bare string — so the `{ value: "42" }` and `{}` object
  // segments would be stringified as `"[object Object]"` instead of `"42"`/
  // dropped), 437/438 (line 366 col 78, LogicalOperator `??` -> `&&` and
  // OptionalChaining removed on `seg?.value` — the former turns the real
  // `"42"` segment into `""` — filtered out — and the latter throws on the
  // literal `null` path segment below), 439 (line 366 col 92, StringLiteral
  // `""` -> `"Stryker was here!"` on the value-less-segment fallback — would
  // leak that placeholder into the joined path), and 441 (line 367 col 22,
  // MethodExpression collapsing `segments.filter(Boolean).join("/")` down to
  // the bare, comma-joined `segments` array).
  test("structured path array mixes string + object segments, tolerates a value-less object and a null entry, and query filtering excludes disabled/keyless/malformed entries", () => {
    const collection = {
      item: [
        {
          name: "Mixed",
          request: {
            method: "GET",
            url: {
              raw: "https://api.example.com/decoy?wrong=1",
              path: ["users", { value: "42" }, {}, null, "orders"],
              query: [
                { key: "status", value: "open" },
                { key: "disabledKey", value: "x", disabled: true },
                { value: "nokey" },
                null,
              ],
            },
          },
        },
      ],
    };
    const [tool] = parsePostmanCollection(collection);
    expect(tool.endpoint).toBe("/users/42/orders");
    expect(tool.inputSchema).toEqual({ type: "object", properties: { status: { type: "string" } } });
  });

  // Kills id 429 (line 365 col 34, EqualityOperator `url.path.length > 0`
  // -> `>= 0`). An empty `path` array has `Array.isArray(...)` true but
  // `length > 0` false, so the real code must fall through to the `raw`
  // fallback below — `>= 0` would wrongly treat the empty array as present
  // and produce `path: "/"` with no query keys instead.
  test("an empty path array falls through to the raw fallback instead of matching on length alone", () => {
    const collection = {
      item: [
        {
          name: "EmptyPathArray",
          request: { method: "GET", url: { path: [], raw: "https://api.example.com/fallback-path?y=2" } },
        },
      ],
    };
    const [tool] = parsePostmanCollection(collection);
    expect(tool.endpoint).toBe("/fallback-path");
    expect(tool.inputSchema).toEqual({ type: "object", properties: { y: { type: "string" } } });
  });

  // Kills ids 444/445 (line 370 col 7, ConditionalExpression -> true/false on
  // `typeof url.raw === "string"`), 446 (col 7, EqualityOperator `!==`, which
  // would invert the guard), 447 (line 370 col 26, StringLiteral `"string"`
  // -> `""`, so the typeof comparison can never match and the raw fallback
  // never runs), 448 (line 370 col 36, BlockStatement emptying the raw
  // fallback block so it falls through to the "no path, no raw" null
  // return), 449 (line 372 col 12, ObjectLiteral `{ path: fromRaw.path,
  // queryKeys: ... }` -> `{}`, which would yield `path: undefined` instead
  // of the parsed raw path), and 450 (line 372 col 64, ArrayDeclaration
  // replacing the `[...structuredQueryKeys, ...fromRaw.queryKeys]` merge
  // with a literal `[]`, forcing the union to always be empty).
  test("no path array at all: falls back to raw, merging structured query keys with raw's own query keys", () => {
    const collection = {
      item: [
        {
          name: "NoPathArray",
          request: {
            method: "GET",
            url: {
              raw: "https://api.example.com/ping?verbose=true&extra=1",
              query: [{ key: "structured", value: "yes" }],
            },
          },
        },
      ],
    };
    const [tool] = parsePostmanCollection(collection);
    expect(tool.endpoint).toBe("/ping");
    expect(Object.keys(tool.inputSchema.properties as object).sort()).toEqual(["extra", "structured", "verbose"]);
  });

  // Kills id 451 (line 374 col 10, ObjectLiteral `{ path: null, queryKeys: []
  // }` -> `{}`). When a url object has neither a usable `path` array nor a
  // `raw` string, real code must yield `path: null` so the item is dropped;
  // `{}` would yield `path: undefined`, which does NOT satisfy `path ===
  // null`, wrongly registering a bogus tool instead of silently skipping it.
  test("a url object with neither path nor raw resolves to no tool for that item", () => {
    const collection = {
      item: [
        { name: "NoPathNoRaw", request: { method: "GET", url: { query: [{ key: "x", value: "1" }] } } },
        { name: "Valid", request: { method: "GET", url: "https://api.example.com/valid2" } },
      ],
    };
    const tools = parsePostmanCollection(collection);
    expect(tools).toHaveLength(1);
    expect(tools[0].endpoint).toBe("/valid2");
  });
});

describe("extractPostmanBodyKeys via parsePostmanCollection (lines 377-391)", () => {
  // Kills id 459 (line 378 col 35, ArrayDeclaration `[]` -> `["Stryker was
  // here"]` on the early `if (!body || !body.mode) return [];` guard).
  // Covers both halves of that `||`: a request with no `body` field at all,
  // and a `body` object present but with no `mode`. Either must contribute
  // zero schema keys, not the placeholder string as a bogus property name.
  test("no body field, and a body object with no mode, both contribute zero schema keys", () => {
    const collection = {
      item: [
        { name: "NoBody", request: { method: "POST", url: "https://api.example.com/items?listed=true" } },
        { name: "BodyNoMode", request: { method: "POST", url: "https://api.example.com/other", body: {} } },
      ],
    };
    const tools = parsePostmanCollection(collection);
    const noBody = tools.find((t) => t.endpoint === "/items")!;
    const bodyNoMode = tools.find((t) => t.endpoint === "/other")!;
    expect(noBody.inputSchema).toEqual({ type: "object", properties: { listed: { type: "string" } } });
    expect(bodyNoMode.inputSchema).toEqual({ type: "object", properties: {} });
  });

  // Kills ids 472/473 (line 383 cols 53/68, OptionalChaining removed on
  // `e?.disabled`/`e?.key` in the urlencoded branch — reading either
  // property off the literal `null` entry below throws instead of being
  // safely filtered out). The disabled and keyless entries additionally
  // exercise (redundantly with the pre-existing suite) the filter's
  // enabled/disabled distinction.
  test("urlencoded body mode excludes disabled/keyless entries and tolerates a null entry", () => {
    const collection = {
      item: [
        {
          name: "Login",
          request: {
            method: "POST",
            url: "https://api.example.com/login",
            body: {
              mode: "urlencoded",
              urlencoded: [
                { key: "user", value: "alice" },
                { key: "pass", value: "x", disabled: true },
                { value: "nokey" },
                null,
              ],
            },
          },
        },
      ],
    };
    const [tool] = parsePostmanCollection(collection);
    expect(Object.keys(tool.inputSchema.properties as object)).toEqual(["user"]);
  });

  // Kills ids 475 (line 384 col 5, ConditionalExpression on the `case
  // "formdata":` label), 476 (line 384 col 10, StringLiteral "formdata" ->
  // "" — the mode would no longer match this case and fall to `default`,
  // returning `[]` instead of the real key), 477 (line 385 col 14,
  // MethodExpression collapsing `(body.formdata ?? []).filter(...).map(...)`
  // down to the bare, unfiltered array of raw entry objects), 478 (line 385
  // col 15, LogicalOperator `??` -> `&&`, which — since `body.formdata` here
  // is a truthy array — evaluates to a literal `[]`, always yielding zero
  // keys), 480/487 (line 385 cols 43/78, ArrowFunction replacing the filter
  // or map callback with `() => undefined` — the former drops every entry,
  // the latter turns the surviving key into the string `"undefined"`),
  // 481/482 (line 385 col 50, ConditionalExpression forcing the filter
  // predicate true/false — `true` lets the literal `null` entry through,
  // throwing when `.map` reads `.key` off it; `false` drops every entry),
  // 483 (line 385 col 50, LogicalOperator `||`, which lets the disabled
  // "skip" entry through instead of "file"), 484 (line 385 col 50,
  // BooleanLiteral removing the `!` negation, which — symmetrically — keeps
  // only "skip" and drops "file"), and 485/486 (line 385 cols 51/66,
  // OptionalChaining removed on `e?.disabled`/`e?.key`, throwing on the
  // literal `null` entry instead of safely filtering it out).
  test("formdata body mode matches its own case, filters disabled/keyless entries, tolerates a null entry, and extracts the exact surviving key", () => {
    const collection = {
      item: [
        {
          name: "Upload",
          request: {
            method: "POST",
            url: "https://api.example.com/upload",
            body: {
              mode: "formdata",
              formdata: [
                { key: "file", value: "a" },
                { key: "skip", value: "b", disabled: true },
                { value: "nokey" },
                null,
              ],
            },
          },
        },
      ],
    };
    const [tool] = parsePostmanCollection(collection);
    expect(Object.keys(tool.inputSchema.properties as object)).toEqual(["file"]);
  });

  // Kills ids 488 (line 386 col 5, ConditionalExpression on the `case
  // "graphql":` label), 489 (line 386 col 10, StringLiteral "graphql" ->
  // "" — mode would no longer match, falling to `default` and returning `[]`
  // instead of the real JSON-derived keys), and 490 (line 387 col 30,
  // OptionalChaining removed on `body.graphql?.variables` — with `mode:
  // "graphql"` but NO `graphql` field at all, this throws reaching `.variables`
  // off `undefined` instead of safely delegating `undefined` to
  // extractBodyKeys, which tolerates it and returns `[]`).
  test("graphql body mode extracts keys from the JSON variables string; a missing graphql field is tolerated", () => {
    const collection = {
      item: [
        {
          name: "GraphqlQuery",
          request: {
            method: "POST",
            url: "https://api.example.com/graphql",
            body: {
              mode: "graphql",
              graphql: { query: "query { x }", variables: JSON.stringify({ id: "", name: "" }) },
            },
          },
        },
        {
          name: "GraphqlNoVars",
          request: { method: "POST", url: "https://api.example.com/graphql2", body: { mode: "graphql" } },
        },
      ],
    };
    const tools = parsePostmanCollection(collection);
    const withVars = tools.find((t) => t.endpoint === "/graphql")!;
    const noVars = tools.find((t) => t.endpoint === "/graphql2")!;
    expect(Object.keys(withVars.inputSchema.properties as object).sort()).toEqual(["id", "name"]);
    expect(noVars.inputSchema).toEqual({ type: "object", properties: {} });
  });

  // Kills ids 491 (line 388 col 5, ConditionalExpression on the `default:`
  // label) and 492 (line 389 col 14, ArrayDeclaration `[]` -> `["Stryker was
  // here"]` on the default branch's return). An unrecognized mode (not raw/
  // urlencoded/formdata/graphql) must contribute zero schema keys — this is
  // the one `[]`-fallback mutant in this file that IS directly observable,
  // since the default branch returns its value unconditionally with no
  // further `.key`-requiring filter downstream.
  test("an unrecognized body mode falls to the default branch, contributing zero schema keys", () => {
    const collection = {
      item: [
        {
          name: "Binary",
          request: { method: "POST", url: "https://api.example.com/upload-binary", body: { mode: "binary" } },
        },
      ],
    };
    const [tool] = parsePostmanCollection(collection);
    expect(tool.inputSchema).toEqual({ type: "object", properties: {} });
  });
});
