/**
 * Stryker mutation-testing backstop for src/discovery/openapi-discovery.ts —
 * cluster "buildInputSchema — parameter mapping" (lines 175-202).
 *
 * Baseline: 211 mutants, 108 killed, 103 survived. This file targets the
 * surviving mutants assigned to the parameter-mapping cluster only; it does
 * not duplicate the happy-path/YAML/size-cap/tag-filter/name-sanitization
 * coverage already in openapi-discovery.test.ts, nor the depth-cap/cycle
 * coverage in openapi-discovery-depth.test.ts, nor the DNS-pin coverage in
 * openapi-discovery-pin.test.ts.
 *
 * buildInputSchema() itself is not exported, so every assertion below goes
 * through the public discoverToolsFromOpenApi() entry point with a mocked
 * fetch returning a real, valid OpenAPI 3.0 document that is genuinely
 * dereferenced by the real (unmocked) @scalar/openapi-parser.
 *
 * ---------------------------------------------------------------------------
 * Equivalence note — L190:9-190:24 ConditionalExpression (forced FALSE half)
 * and L190:9-190:15 StringLiteral (`"$ref"` emptied to `""`):
 *
 * Both mutants are only distinguishable from real code when a parameter
 * object flowing into the loop still carries a `$ref` key. Empirically
 * probing @scalar/openapi-parser's dereference() (the same function this
 * module calls unmocked) shows:
 *   - A parameter `$ref` pointing at a resolvable component is REPLACED
 *     in-place by the resolved object; the `$ref` key does not survive.
 *   - A parameter `$ref` pointing at an unresolvable target produces a
 *     populated `errors` array, which discoverToolsFromOpenApi() throws on
 *     (line 106) BEFORE buildInputSchema ever runs.
 * So there is no way to reach buildInputSchema with a `$ref`-bearing param
 * via the public API with a real spec — matching the source comment
 * ("should not occur post-dereference, but guard defensively"). And no
 * legitimate resolved parameter object ever carries an empty-string (`""`)
 * key, so the StringLiteral mutant (`"" in param`) is also behaviorally
 * indistinguishable from the real `"$ref" in param` check for every
 * reachable input. Both are treated as equivalent/unreachable here; the
 * forced-TRUE half of the same ConditionalExpression IS reachable (it fires
 * on every resolved parameter, not just $ref ones) and is killed below by
 * the big combined-loop test, which would show zero properties/required
 * entries if `continue` fired unconditionally.
 * ---------------------------------------------------------------------------
 */
import { describe, test, expect, afterEach } from "bun:test";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(specObj: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(specObj), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// L180:30-180:32 ArrayDeclaration — `pathItem.parameters ?? []` emptied to a
// placeholder. Case (a): pathItem has NO `parameters` field at all; the
// operation itself carries the only parameter. If the fallback array were
// replaced by a non-empty placeholder, that placeholder would still be
// spread into rawParams even though pathItem.parameters is absent, either
// throwing (`"$ref" in <string>` on a placeholder string) or polluting the
// resulting properties — either way our exact-shape assertion below fails.
// ---------------------------------------------------------------------------
describe("buildInputSchema — operation-level parameters merge in when pathItem has none", () => {
  test("a pathItem with no parameters field still surfaces the operation's own parameter", async () => {
    mockFetch({
      openapi: "3.0.0",
      info: { title: "demo", version: "1.0.0" },
      paths: {
        "/search": {
          get: {
            operationId: "search",
            parameters: [{ name: "q", in: "query", schema: { type: "string" } }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });

    expect(tools.length).toBe(1);
    const inputSchema = tools[0].inputSchema as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(inputSchema.properties)).toEqual(["q"]);
    expect(inputSchema.properties.q).toEqual({ type: "string" });
    expect(inputSchema.required).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// L183:80-186:4 ArrayDeclaration — `operation.parameters ?? []` emptied to a
// placeholder. Case (b): the operation has NO `parameters` field; the
// pathItem itself (shared across all methods on that path) carries the only
// parameter. Mirrors the case above but for the other half of the spread.
// ---------------------------------------------------------------------------
describe("buildInputSchema — pathItem-level (shared) parameters merge in when operation has none", () => {
  test("a pathItem-level parameter with no operation-level parameters field still surfaces", async () => {
    mockFetch({
      openapi: "3.0.0",
      info: { title: "demo", version: "1.0.0" },
      paths: {
        "/legacy/{id}": {
          parameters: [{ name: "id", in: "path", schema: { type: "string" } }],
          get: {
            operationId: "legacyGet",
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });

    expect(tools.length).toBe(1);
    const inputSchema = tools[0].inputSchema as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(inputSchema.properties)).toEqual(["id"]);
    expect(inputSchema.properties.id).toEqual({ type: "string" });
    expect(inputSchema.required).toEqual(["id"]);
  });
});

// ---------------------------------------------------------------------------
// Combined loop test. Targets, in one shot:
//   - L188:34-202:4  BlockStatement (whole for-loop body emptied)
//   - L190:9-190:24  ConditionalExpression forced TRUE (`if (true) continue`
//     — every parameter would be skipped)
//   - L193:43-193:77 ObjectLiteral (`{ type: schema?.type ?? "string" }`
//     emptied — the base prop object would lose its `type` key entirely)
//   - L193:51-193:75 LogicalOperator (`??` -> `&&`)
//   - L193:51-193:63 OptionalChaining (`schema?.type` -> `schema.type`)
//   - L193:67-193:75 StringLiteral (the "string" default emptied to "")
//   - L194:9-194:22  ConditionalExpression (description assignment, both
//     directions)
//   - L195:9-195:21  ConditionalExpression + OptionalChaining (enum
//     assignment, both directions)
//   - L196:9-196:38  ConditionalExpression + EqualityOperator + OptionalChaining
//     (default assignment, both directions, falsy-but-defined default)
//   - L197:9-197:83, L197:59-197:68, L198:58-198:67 (example assignment,
//     both directions, falsy-but-defined example)
//   - L201:9-201:38  ConditionalExpression + LogicalOperator + EqualityOperator,
//     and L201:32-201:38 StringLiteral (`required.push` condition, all three
//     required-array cases)
//
// One operation carries seven parameters, each isolating a different
// combination above; every property AND every required-array entry is
// asserted exactly (both value and exact key-set, since `toEqual` alone
// would silently accept a spurious own key holding `undefined` — e.g. a
// forced-true description/enum/default/example assignment on a parameter
// that doesn't have one).
// ---------------------------------------------------------------------------
describe("buildInputSchema — full parameter loop: types, description, enum, default, example, required", () => {
  test("each parameter's resulting property and required-membership is exact", async () => {
    mockFetch({
      openapi: "3.0.0",
      info: { title: "demo", version: "1.0.0" },
      paths: {
        "/widgets/{itemId}": {
          get: {
            operationId: "getWidget",
            parameters: [
              // required:true, in:"query" -> must still be required (kills || -> && swap)
              { name: "count", in: "query", required: true, schema: { type: "integer" } },
              // no schema at all -> type defaults to "string"; not required
              { name: "flag", in: "query" },
              // in:"path", required absent/false -> must still be required (the OTHER half of ||)
              { name: "itemId", in: "path", schema: { type: "string" } },
              // has a description
              { name: "desc_param", in: "query", description: "the description", schema: { type: "string" } },
              // has an enum
              { name: "status", in: "query", schema: { type: "string", enum: ["a", "b", "c"] } },
              // has an explicit FALSY (but defined) default: 0
              { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
              // has an explicit FALSY (but defined) example: 0
              { name: "retries", in: "query", schema: { type: "integer", example: 0 } },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });

    const { discoverToolsFromOpenApi } = await import("../../discovery/openapi-discovery.js");
    const tools = await discoverToolsFromOpenApi({ openapiUrl: "http://example.com/openapi.json" });

    expect(tools.length).toBe(1);
    const inputSchema = tools[0].inputSchema as {
      properties: Record<string, Record<string, unknown>>;
      required?: string[];
    };
    const props = inputSchema.properties;

    // Exact key set and order — proves the loop body actually ran for every
    // parameter (kills the BlockStatement + forced-true continue mutants;
    // if either fired, this array would be empty or missing entries).
    expect(Object.keys(props)).toEqual(["count", "flag", "itemId", "desc_param", "status", "offset", "retries"]);

    // count: explicit type "integer" survives the ?? (not && , not "string" default,
    // not an emptied object literal), and has no other keys.
    expect(props.count).toEqual({ type: "integer" });
    expect(Object.keys(props.count).sort()).toEqual(["type"]);

    // flag: no schema at all -> optional chaining must short-circuit (schema.type
    // without ?. would throw on undefined), default fallback must be exactly "string".
    expect(props.flag).toEqual({ type: "string" });
    expect(Object.keys(props.flag).sort()).toEqual(["type"]);

    // itemId: no explicit "required" field, no description/enum/default/example.
    expect(props.itemId).toEqual({ type: "string" });
    expect(Object.keys(props.itemId).sort()).toEqual(["type"]);

    // desc_param: description present -> must appear with the exact value.
    expect(props.desc_param).toEqual({ type: "string", description: "the description" });
    expect(Object.keys(props.desc_param).sort()).toEqual(["description", "type"]);

    // status: enum present -> must appear with the exact array.
    expect(props.status).toEqual({ type: "string", enum: ["a", "b", "c"] });
    expect(Object.keys(props.status).sort()).toEqual(["enum", "type"]);

    // offset: default 0 is falsy but explicitly defined -> must still be set,
    // not skipped by a naive truthy check (kills the !== undefined -> ==
    // undefined style EqualityOperator mutants too).
    expect(props.offset).toEqual({ type: "integer", default: 0 });
    expect(Object.keys(props.offset).sort()).toEqual(["default", "type"]);
    expect(props.offset.default).toBe(0);

    // retries: example 0 is falsy but explicitly defined -> must still be set.
    expect(props.retries).toEqual({ type: "integer", example: 0 });
    expect(Object.keys(props.retries).sort()).toEqual(["example", "type"]);
    expect(props.retries.example).toBe(0);

    // Required array: exactly ["count", "itemId"] in encounter order.
    //  - count: required:true, in:"query"        -> included (required alone suffices)
    //  - itemId: required absent, in:"path"        -> included (path alone suffices)
    //  - flag/desc_param/status/offset/retries:
    //      required absent/false, in:"query"       -> excluded
    expect(inputSchema.required).toEqual(["count", "itemId"]);
  });
});
