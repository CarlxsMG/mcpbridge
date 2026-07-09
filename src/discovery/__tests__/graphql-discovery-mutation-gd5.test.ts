import { describe, test, expect, afterEach } from "bun:test";
import { discoverToolsFromGraphQl } from "../graphql-discovery.js";
import { config } from "../../config.js";

/**
 * Domain 6 mutation-testing backstop for src/discovery/graphql-discovery.ts.
 * Cluster: discoverToolsFromGraphQl — errors guard, introspection-disabled,
 * too-many-types, query/mutation field iteration (lines 281-313).
 *
 * Targets the following surviving mutants from the baseline Stryker run
 * (272 mutants, 118 killed, 154 survived, 43.38%):
 *   - L282:102-282:106  StringLiteral   ", " -> ""     (errors.join separator)
 *   - L284:18-284:37    OptionalChaining `json.data?.__schema` -> `json.data.__schema`
 *   - L289:33-289:35    ArrayDeclaration `schema.types ?? []` -> placeholder
 *   - L290:7-290:44     EqualityOperator `>` -> `>=`   (too-many-types boundary)
 *   - L295:48-295:75    MethodExpression `types.filter((t) => t.name)` -> `types` (filter removed)
 *   - L297:42-297:44    ArrayDeclaration `const tools: GraphqlDiscoveredTool[] = []` -> placeholder
 *   - L300:21-300:43    OptionalChaining `schema.queryType?.name` -> `schema.queryType.name`
 *   - L301:23-301:40    OptionalChaining `queryType?.fields` -> `queryType.fields`
 *   - L301:44-301:46    ArrayDeclaration `queryType?.fields ?? []` -> placeholder
 *   - L306:26-306:51    OptionalChaining `schema.mutationType?.name` -> `schema.mutationType.name`
 *   - L307:25-307:45    OptionalChaining `mutationType?.fields` -> `mutationType.fields`
 *   - L307:49-307:51    ArrayDeclaration `mutationType?.fields ?? []` -> placeholder
 *
 * Fixture shapes (typeRef helpers, schema()-style introspection payloads) are
 * redefined locally per the program's per-file self-containment convention —
 * not shared with the sibling graphql-discovery.test.ts file.
 */

const originalFetch = globalThis.fetch;

function typeRef(kind: string, name: string | null = null, ofType: unknown = null) {
  return { kind, name, ofType };
}
const SCALAR = (name: string) => typeRef("SCALAR", name);

function mockFetch(json: unknown, opts: { ok?: boolean; status?: number; contentLength?: string } = {}): void {
  globalThis.fetch = (async () => {
    const text = JSON.stringify(json);
    return new Response(text, {
      status: opts.status ?? 200,
      headers: {
        "content-type": "application/json",
        ...(opts.contentLength ? { "content-length": opts.contentLength } : {}),
      },
    });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("discoverToolsFromGraphQl mutation backstop (gd5)", () => {
  // Kills L282:102-282:106 (StringLiteral ", " -> ""). With TWO distinct error
  // messages, only a ", " join keeps them individually visible & separated;
  // "" concatenation would glue them into one unbroken run.
  test("joins multiple introspection errors with a comma-space separator", async () => {
    mockFetch({ errors: [{ message: "not authorized" }, { message: "rate limited" }] });
    await expect(discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" })).rejects.toThrow(
      "GraphQL introspection returned errors: not authorized, rate limited",
    );
  });

  // Kills L284:18-284:37 (OptionalChaining `json.data?.__schema` -> `json.data.__schema`).
  // Response has NO `data` key at all (not even an empty object) — if the `?.`
  // guarding `.__schema` were removed, `json.data.__schema` would throw a
  // TypeError reading a property of undefined instead of cleanly reporting
  // GRAPHQL_INTROSPECTION_DISABLED.
  test("throws GRAPHQL_INTROSPECTION_DISABLED cleanly when `data` itself is absent", async () => {
    mockFetch({});
    await expect(discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" })).rejects.toThrow(
      /GRAPHQL_INTROSPECTION_DISABLED/,
    );
  });

  // Kills L289:33-289:35 (ArrayDeclaration `schema.types ?? []`), L300:21-300:43
  // (OptionalChaining `schema.queryType?.name`), L306:26-306:51 (OptionalChaining
  // `schema.mutationType?.name`), and reinforces L297:42-297:44 (ArrayDeclaration
  // on the `tools` accumulator's initial `[]`) — a schema with none of `types`,
  // `queryType`, or `mutationType` present must resolve to an exactly-empty
  // tools array with no crash, not a placeholder array or thrown TypeError.
  test("handles a fully minimal __schema (no types, no queryType, no mutationType) without crashing", async () => {
    mockFetch({ data: { __schema: {} } });
    const tools = await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
    expect(tools).toEqual([]);
  });

  // Kills L290:7-290:44 (EqualityOperator `>` -> `>=`). Exact boundary: schema
  // has precisely config.graphqlMaxTypes types — the check must be exclusive
  // (`>`), so this must NOT throw. (The sibling test file already covers the
  // exceeds-the-cap direction with graphqlMaxTypes:1 and 7 types.)
  test("does not throw GRAPHQL_TOO_MANY_TYPES when types.length equals the cap exactly", async () => {
    const original = config.graphqlMaxTypes;
    (config as Record<string, unknown>).graphqlMaxTypes = 2;
    try {
      mockFetch({
        data: {
          __schema: {
            queryType: { name: "Query" },
            types: [
              {
                kind: "OBJECT",
                name: "Query",
                fields: [{ name: "ping", description: null, args: [], type: SCALAR("String") }],
                inputFields: null,
                enumValues: null,
              },
              { kind: "SCALAR", name: "String", fields: null, inputFields: null, enumValues: null },
            ],
          },
        },
      });
      const tools = await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
      expect(tools.map((t) => t.name)).toEqual(["ping"]);
    } finally {
      (config as Record<string, unknown>).graphqlMaxTypes = original;
    }
  });

  // Targets L295:48-295:75 (MethodExpression `types.filter((t) => t.name)` ->
  // `types`, i.e. the .filter(...) call dropped entirely per Stryker's
  // method-expression-mutator "remove method expression" rule for `filter`).
  // An anonymous (name: null) type sits alongside normally-named types. Even
  // with the filter removed, the anonymous entry would only ever occupy Map
  // key `null` — every call site in this file (typeToJsonSchema,
  // buildSelectionSet, and the queryType/mutationType lookups here) guards
  // `named.name ? typeMap.get(named.name) : undefined` before ever calling
  // `.get`, so a falsy-named key can never actually be queried. This test
  // empirically verifies there's no crash and the real named type ("Query")
  // still resolves correctly with the anonymous entry present; a genuine
  // black-box divergence for this specific mutant looks unreachable (noted
  // as a likely-equivalent survivor in the summary), but this still locks in
  // the no-crash, correct-resolution behavior as regression coverage.
  test("tolerates an anonymous (name: null) type entry without breaking named-type resolution", async () => {
    mockFetch({
      data: {
        __schema: {
          queryType: { name: "Query" },
          types: [
            { kind: "OBJECT", name: null, fields: null, inputFields: null, enumValues: null },
            {
              kind: "OBJECT",
              name: "Query",
              fields: [{ name: "ping", description: null, args: [], type: SCALAR("String") }],
              inputFields: null,
              enumValues: null,
            },
          ],
        },
      },
    });
    const tools = await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
    expect(tools).toEqual([
      {
        name: "ping",
        description: 'GraphQL query "ping"',
        inputSchema: { type: "object", properties: {} },
        query: expect.stringContaining("ping"),
      },
    ]);
  });

  // Kills L301:23-301:40 (OptionalChaining `queryType?.fields`) and L307:25-307:45
  // (OptionalChaining `mutationType?.fields`). Both queryType.name and
  // mutationType.name point at type names that are NOT present anywhere in
  // `types`, so the local `typeMap.get(...)` lookups miss and the local
  // `queryType`/`mutationType` consts are `undefined` — distinct from
  // `schema.queryType`/`schema.mutationType` themselves being absent (already
  // covered above). If the `?.` guarding `.fields` on the lookup RESULT were
  // removed, iterating `undefined.fields` would throw instead of yielding zero
  // tools cleanly.
  test("produces zero tools (no crash) when queryType/mutationType names don't resolve in typeMap", async () => {
    mockFetch({
      data: {
        __schema: {
          queryType: { name: "Query" },
          mutationType: { name: "Mutation" },
          types: [{ kind: "SCALAR", name: "String", fields: null, inputFields: null, enumValues: null }],
        },
      },
    });
    const tools = await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
    expect(tools).toEqual([]);
  });

  // Kills L301:44-301:46 (ArrayDeclaration `queryType?.fields ?? []`) and
  // L307:49-307:51 (ArrayDeclaration `mutationType?.fields ?? []`). Here the
  // Query/Mutation types DO resolve via typeMap (unlike the previous test),
  // but neither carries a `fields` property at all, so the `?? []` fallback
  // is what's exercised (whether omitted or explicitly null, `??` treats both
  // identically) — confirms no crash iterating and zero tools produced, not a
  // placeholder-array artifact.
  test("produces zero tools (no crash) when the resolved Query/Mutation types have no fields", async () => {
    mockFetch({
      data: {
        __schema: {
          queryType: { name: "Query" },
          mutationType: { name: "Mutation" },
          types: [
            { kind: "OBJECT", name: "Query", inputFields: null, enumValues: null },
            { kind: "OBJECT", name: "Mutation", inputFields: null, enumValues: null },
          ],
        },
      },
    });
    const tools = await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
    expect(tools).toEqual([]);
  });
});
