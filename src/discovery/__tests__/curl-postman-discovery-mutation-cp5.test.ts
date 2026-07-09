/**
 * Stryker mutation-testing backstop for curl-postman-discovery.ts — domain 6
 * cluster cp5: the shared helpers used by BOTH the cURL and Postman parsers
 * (lines 393-470): toParsedUrl, extractPathAndQuery, extractBodyKeys,
 * buildPermissiveSchema, generateNameFromPath, describeSource.
 *
 * None of these helpers are exported, so every test drives them indirectly
 * through parseCurlCommand()'s resulting tool definitions (all six helpers
 * are reachable from the cURL parser, so there's no need to also go through
 * parsePostmanCollection here).
 *
 * All expected values in this file were captured by running the assertions
 * against the REAL (unmutated) source first (see verification note in the
 * task) — every literal below is an actual observed output, not a
 * hand-derived guess.
 *
 * Mutant IDs cited below are (line:col, mutatorName) from a fresh
 * reports/mutation/result.json query filtered to lines 393-470.
 *
 * EQUIVALENT MUTANTS (no test can distinguish these; documented, not chased):
 *   - 402:11 BlockStatement `{}` — empties toParsedUrl's `catch { return null; }`
 *     to `catch {}`, so on a thrown URL parse the function implicitly
 *     returns `undefined` instead of `null`. The only caller,
 *     extractPathAndQuery, tests the result with `if (!parsed)`, and
 *     `undefined` is exactly as falsy as `null` — unobservable.
 *   - 416:37 StringLiteral `""` — changes `parsed.pathname || "/"` to
 *     `parsed.pathname || ""`. Every `parsed` reaching this line was built by
 *     prepending `http://` to a host in toParsedUrl, and the WHATWG URL
 *     parser normalizes an http(s) URL's pathname to at least `"/"` — it can
 *     never be empty — so the `|| "/"` fallback is dead code either way.
 *   - 431:7 ConditionalExpression `false` — disables the `if (!trimmed) return
 *     [];` early exit. The only string for which `!trimmed` is true is `""`,
 *     and skipping the early return for `""` still ends up at
 *     `JSON.parse("")` (throws, caught), then the urlencoded regex test on
 *     `""` (false), then the final `return [];` — same end result either way.
 *   - 444:13 BlockStatement `{}` / 445:14 ArrayDeclaration — empties the
 *     `catch { return []; }` guarding `new URLSearchParams(trimmed).keys()`.
 *     Empirically, `new URLSearchParams(...)` never throws for any string
 *     input (verified with malformed `%` escapes, bare `=`, etc. — it parses
 *     leniently instead), so this catch is unreachable dead code.
 *   - 461:32 / 461:82 MethodExpression `.toUpperCase()` — both
 *     generateNameFromPath call sites (cURL line 238, Postman line 348) feed
 *     its return value straight into `sanitizeToolName()`, which
 *     unconditionally applies its own `.toLowerCase()` — any casing
 *     difference introduced upstream is erased before a caller ever sees it.
 */
import { describe, test, expect } from "bun:test";
import { parseCurlCommand } from "../../discovery/curl-postman-discovery.js";

describe("toParsedUrl / extractPathAndQuery — scheme-detection and fallback", () => {
  test("a bare host is defaulted to http://, and scheme-detection is anchored to the START of the string (kills 399:21 Regex anchor-removed)", () => {
    // The query VALUE contains "http://" later in the string. An anchored
    // scheme regex correctly says "no scheme here" (the string starts with
    // "foo.com", not a scheme), so http:// gets prepended and the URL parses
    // for real, surfacing the query key. An unanchored regex would find the
    // "http://" inside the query value, wrongly conclude a scheme is already
    // present, leave the raw string untouched, and fail to parse at all
    // (falling back to a literal-path treatment that drops the query key).
    const [tool] = parseCurlCommand(`curl foo.com/redirect?to=http://evil.com`);
    expect(tool.endpoint).toBe("/redirect");
    expect(tool.inputSchema.properties).toEqual({ to: { type: "string" } });
  });

  test("a leading protocol-relative '//' is stripped before defaulting to http:// (kills 399:77 empty-template and 399:111 replacement-string mutants)", () => {
    // If the `http://${...}` template were blanked to `` (399:77) or its
    // internal `.replace(/^\/\//, "")` were given a non-empty replacement
    // (399:111), the resulting candidate string fails to construct a valid
    // URL, and extractPathAndQuery falls back to literal-path mode — which
    // would keep the "//" prefix and NOT strip the host into endpoint "/path".
    const [tool] = parseCurlCommand(`curl //api.example.com/path`);
    expect(tool.endpoint).toBe("/path");
    expect(tool.inputSchema.properties).toEqual({});
  });

  test("only a LEADING '//' is stripped — a '//' occurring later in the path is left intact (kills 399:102 Regex anchor-removed on the strip regex)", () => {
    // If the strip regex `/^\/\//` lost its anchor, String.replace would
    // remove the FIRST "//" occurring anywhere, which here sits mid-path —
    // corrupting the host/path split entirely (host would swallow the "b"
    // segment). The real, anchored regex only strips a truly-leading "//",
    // so this mid-path "//" survives untouched in the final endpoint.
    const [tool] = parseCurlCommand(`curl example.com/a//b`);
    expect(tool.endpoint).toBe("/a//b");
  });
});

describe("extractPathAndQuery — literal-path fallback for a genuinely unparseable URL", () => {
  test("no leading slash + a query suffix: fallback ensures a leading slash AND strips the query (kills 409:7/409:16 guard mutants, 413:18/19/32 split/&&/regex mutants, 414:12/36/50 object/startsWith/template mutants)", () => {
    // A raw space makes this un-parseable even after http:// is prepended,
    // so extractPathAndQuery must take its literal-path fallback branch.
    const [tool] = parseCurlCommand(`curl "not a valid url with spaces?x=1"`);
    expect(tool.endpoint).toBe("/not a valid url with spaces");
    expect(tool.inputSchema.properties).toEqual({});
  });

  test("already has a leading slash: fallback must NOT double it up (kills 414:20 startsWith->endsWith mutant)", () => {
    const [tool] = parseCurlCommand(`curl "/bad url too?x=1"`);
    expect(tool.endpoint).toBe("/bad url too");
  });
});

describe("extractBodyKeys — JSON array / bare primitive / non-JSON body all contribute no keys", () => {
  test("a JSON ARRAY body contributes no keys, not its numeric indices (kills 434:9 x3 ConditionalExpression/LogicalOperator mutants, 437:12 ArrayDeclaration)", () => {
    const [tool] = parseCurlCommand(`curl https://api.example.com/x -d '["a","b","c"]'`);
    expect(tool.method).toBe("POST");
    expect(tool.inputSchema.properties).toEqual({});
  });

  test("a JSON bare STRING primitive body contributes no keys, not its character indices (kills remaining 434:9/434:28 LogicalOperator/ConditionalExpression mutants)", () => {
    // Object.keys("hello") is ["0","1","2","3","4"] — a strong distinguisher
    // for any mutant that lets a non-object JSON value reach Object.keys().
    const [tool] = parseCurlCommand(`curl https://api.example.com/x -d '"hello"'`);
    expect(tool.inputSchema.properties).toEqual({});
  });

  test("a genuinely non-JSON, non-urlencoded plain-text/XML body contributes no keys (kills 448:10 ArrayDeclaration)", () => {
    const [tool] = parseCurlCommand(`curl https://api.example.com/x -d '<user><name>Jane</name></user>'`);
    expect(tool.inputSchema.properties).toEqual({});
  });

  test("urlencoded-looking detection requires the '=' at the very START of the trimmed body, not merely present somewhere in free text (kills 441:7 Regex anchor-removed and ConditionalExpression 'true')", () => {
    // "she said hi=5 today" has an "=" in the middle but does not itself
    // look like a key=value pair from the start, so it must contribute no
    // keys. An unanchored (or always-true) urlencoded check would wrongly
    // run it through URLSearchParams and surface a bogus key.
    const [tool] = parseCurlCommand(`curl https://api.example.com/x -d 'she said hi=5 today'`);
    expect(tool.inputSchema.properties).toEqual({});
  });

  test("a urlencoded body's keys are deduplicated (kills residual Set-dedup coverage) and undefined data (no -d at all) contributes no keys (kills 429:34 ArrayDeclaration)", () => {
    const [dup] = parseCurlCommand(`curl https://api.example.com/login -d 'a=1' -d 'a=3' -d 'b=2'`);
    expect(dup.inputSchema.properties).toEqual({ a: { type: "string" }, b: { type: "string" } });

    const [noBody] = parseCurlCommand(`curl https://api.example.com/ping`);
    expect(noBody.inputSchema.properties).toEqual({});
  });

  test("surrounding whitespace is trimmed before urlencoded detection runs (kills 430:19 MethodExpression drop-.trim())", () => {
    // Untrimmed, the body starts with a space, which fails the urlencoded
    // regex's `[^&=\s]` first-character class — so dropping .trim() would
    // make this body contribute NO keys instead of the real ["a","b"].
    const [tool] = parseCurlCommand(`curl https://api.example.com/x -d '  a=1&b=2  '`);
    expect(tool.inputSchema.properties).toEqual({ a: { type: "string" }, b: { type: "string" } });
  });

  test("a whitespace-only body contributes no keys (kills 431:24 ArrayDeclaration on the empty-trimmed early return)", () => {
    const [tool] = parseCurlCommand(`curl https://api.example.com/x -d '   '`);
    expect(tool.inputSchema.properties).toEqual({});
  });
});

describe("buildPermissiveSchema — overlapping query/body key names", () => {
  test("a query key and a body key sharing the same name still produce exactly ONE property, not a duplicate", () => {
    const [tool] = parseCurlCommand(`curl -X POST "https://api.example.com/search?name=x" -d '{"name":"bob"}'`);
    expect(tool.inputSchema.properties).toEqual({ name: { type: "string" } });
  });
});

describe("generateNameFromPath — root path and trailing-slash segment filtering", () => {
  test("a root path with no segments at all falls back to just the lowercased method, with no trailing underscore artifact (kills 461:10 ConditionalExpression 'true' and EqualityOperator '>=0')", () => {
    const [tool] = parseCurlCommand(`curl https://api.example.com/`);
    expect(tool.name).toBe("get");
    expect(tool.endpoint).toBe("/");
  });

  test("a trailing-slash path is segmented with empty pieces filtered out, leaving no trailing underscore (kills 460:20 MethodExpression drop-.filter(Boolean))", () => {
    // Without .filter(Boolean), split("/") on a trailing-slash path leaves a
    // trailing empty segment, which survives sanitizeToolName's leading-only
    // strip and its underscore-collapse (it collapses *consecutive*
    // underscores, it does not remove a single trailing one) as a stray
    // trailing "_" — e.g. "delete_orders_42_" instead of "delete_orders_42".
    const [tool] = parseCurlCommand(`curl -X DELETE https://api.example.com/orders/42/`);
    expect(tool.name).toBe("delete_orders_42");
  });
});

describe("describeSource — zero vs. multiple (deduplicated) header names", () => {
  test("zero headers: description is exactly the base line, with no 'Headers seen' note at all (kills 465:16 empty-template and 467:7 ConditionalExpression 'false')", () => {
    const [tool] = parseCurlCommand(`curl https://api.example.com/ping`);
    expect(tool.description).toBe("Imported from cURL: GET /ping");
    expect(tool.description).not.toContain("Headers seen");
  });

  test("multiple headers, including a repeated name, are deduplicated and comma-space joined — and never leak header VALUES (kills 468:164 empty-separator mutant)", () => {
    const [tool] = parseCurlCommand(
      `curl -X POST https://api.example.com/x -H "X-A: 1" -H "X-B: 2" -H "X-A: 3" -d '{}'`,
    );
    expect(tool.description).toBe(
      "Imported from cURL: POST /x. Headers seen on the source request (not applied automatically — configure upstream auth or a request transform if needed): X-A, X-B",
    );
    expect(tool.description).not.toContain("1");
    expect(tool.description).not.toContain("2");
    expect(tool.description).not.toContain("3");
  });
});
