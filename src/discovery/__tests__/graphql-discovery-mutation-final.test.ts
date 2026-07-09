/**
 * Stryker mutation-testing backstop for src/discovery/graphql-discovery.ts —
 * manual closing pass after the 5-agent cold round (gd1-gd5), closing the
 * remaining real gaps and documenting genuine equivalents for the rest.
 *
 * Targets these surviving mutants from the post-cold-round verify run:
 *
 *   L140:7-140:28 ConditionalExpression true (`named.kind === "ENUM"` forced
 *   always-true, in typeToJsonSchema's `if (named.kind === "ENUM" &&
 *   full?.enumValues)`). Every existing test's ENUM-kind fixtures are
 *   internally consistent (a type actually kind:"ENUM" genuinely has
 *   enumValues) — forcing this sub-condition true is only observable via a
 *   MALFORMED fixture where a NON-ENUM-kind type's typeMap entry still
 *   happens to carry a populated enumValues array (the code never validates
 *   this consistency, so nothing prevents it).
 *
 *   L142:14-142:43 ConditionalExpression true (the INPUT_OBJECT mirror of
 *   the above, on `named.kind === "INPUT_OBJECT" && full?.inputFields`).
 *   Same technique: a non-INPUT_OBJECT-kind type whose entry still has
 *   inputFields populated.
 *
 *   L164:7-164:29 ConditionalExpression false + L164:22-164:29 StringLiteral
 *   "" (`named.kind === "UNION"` forced always-false, in buildSelectionSet's
 *   `if (named.kind === "UNION" || depth > config.graphqlSelectionMaxDepth)
 *   return "{ __typename }";`). The cold round's UNION test fixture had
 *   `fields: null` on the UNION type's typeMap entry (realistic for a real
 *   GraphQL union), which ALSO makes the fallback-to-empty-picks path at the
 *   bottom of the function produce the identical "{ __typename }" text
 *   regardless of whether this specific guard fires — needs a UNION type
 *   whose entry ALSO carries populated (but never normally present) `fields`
 *   to prove the guard itself is what's short-circuiting, not the unrelated
 *   empty-picks fallback.
 *
 *   L188:86-188:90 / L189:72-189:76 StringLiteral "" (the `.join(", ")`
 *   separators on the variable-declaration and call-argument strings,
 *   emptied to `.join("")`). The cold round's test used a field with only
 *   ONE arg, so `.join(...)` had nothing to actually join — the separator is
 *   never consulted regardless of its value with a single-element array.
 *   Needs a field with TWO OR MORE args to exercise the join.
 *
 *   L289:33-289:35 ArrayDeclaration (`schema.types ?? []` fallback, mutated
 *   to `?? ["Stryker was here"]`). The cold round's "fully minimal schema"
 *   test (no `types` field at all) couldn't distinguish the two fallbacks
 *   because the placeholder string element gets filtered out of the
 *   downstream `typeMap` construction anyway (a plain string has no `.name`
 *   property, so `.filter((t) => t.name)` drops it) — both fallbacks
 *   converge on an empty typeMap and empty tools array either way. Needs a
 *   test that inspects `types.length` directly via the `graphqlMaxTypes`
 *   cap: with the cap forced to exactly 0, a genuinely-empty real fallback
 *   must NOT throw (0 is not > 0), while the placeholder-array fallback
 *   (length 1) WOULD throw (1 > 0).
 *
 * Documented equivalents (each already investigated and verified empirically
 * by the cold-round agent that owned that cluster — re-confirmed consistent
 * with the actual verify-round result, not re-litigated here):
 *
 *   L176:11-176:17 ConditionalExpression true (buildSelectionSet's `if
 *   (nested)` forced always-true) — gd2 traced that the recursive branch is
 *   only ever entered after the SAME type reference already passed the
 *   structurally-identical guard at line 172 one level up, so the recursive
 *   call's own line-163 guard can never return "" at that call site —
 *   `nested` is provably always truthy whenever this line executes.
 *
 *   L274:9-274:33 ConditionalExpression false (`err instanceof TypeError`
 *   forced always-false) + L275:23-275:103 StringLiteral + L275:105-277:8
 *   ObjectLiteral (the "GRAPHQL_CYCLIC_REFERENCE" message/cause) — gd4
 *   confirmed this file only ever calls `JSON.parse` (no YAML fallback,
 *   unlike openapi-discovery.ts), and JSON.parse's output can never contain
 *   a real cycle or a BigInt — the only two documented causes of a
 *   `JSON.stringify` TypeError — so this branch is unreachable through the
 *   public API.
 *
 *   L295:48-295:75 MethodExpression (`types.filter((t) => t.name)` reduced
 *   to plain `types`) — gd5 traced every consumer of `typeMap` in this file
 *   (typeToJsonSchema, buildSelectionSet, and the queryType/mutationType
 *   lookups) and confirmed each guards with `named.name ? typeMap.get(...) :
 *   undefined` before ever querying it — a spurious Map entry keyed by a
 *   missing/null/empty name (left behind if the filter is dropped) can never
 *   actually be looked up through any reachable code path.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { config } from "../../config.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function typeRef(kind: string, name: string | null = null, ofType: unknown = null) {
  return { kind, name, ofType };
}
const NON_NULL = (of: unknown) => typeRef("NON_NULL", null, of);
const SCALAR = (name: string) => typeRef("SCALAR", name);

function mockFetch(json: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(json), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("typeToJsonSchema — a non-ENUM type is not treated as an enum, even with enumValues present", () => {
  test("a type kind:OBJECT with (malformed but unvalidated) enumValues still falls back to scalar mapping", async () => {
    mockFetch({
      data: {
        __schema: {
          queryType: { name: "Query" },
          mutationType: null,
          types: [
            {
              kind: "OBJECT",
              name: "Query",
              fields: [
                {
                  name: "field",
                  description: null,
                  args: [{ name: "arg", description: null, type: NAMED_TYPE("Weird"), defaultValue: null }],
                  type: SCALAR("String"),
                },
              ],
              inputFields: null,
              enumValues: null,
            },
            // A malformed but code-permitted entry: kind is OBJECT (not ENUM), yet
            // carries a populated enumValues array. Real code must ignore it.
            {
              kind: "OBJECT",
              name: "Weird",
              fields: null,
              inputFields: null,
              enumValues: [{ name: "SHOULD_NOT_APPEAR" }],
            },
          ],
        },
      },
    });

    const { discoverToolsFromGraphQl } = await import("../../discovery/graphql-discovery.js");
    const tools = await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
    const tool = tools.find((t) => t.name === "field")!;
    const props = tool.inputSchema.properties as Record<string, { type: string; enum?: string[] }>;
    expect(props.arg).toEqual({ type: "string" });
    expect(props.arg.enum).toBeUndefined();
  });
});

describe("typeToJsonSchema — a non-INPUT_OBJECT type is not treated as an input object, even with inputFields present", () => {
  test("a type kind:OBJECT with (malformed but unvalidated) inputFields still falls back to scalar mapping", async () => {
    mockFetch({
      data: {
        __schema: {
          queryType: { name: "Query" },
          mutationType: null,
          types: [
            {
              kind: "OBJECT",
              name: "Query",
              fields: [
                {
                  name: "field",
                  description: null,
                  args: [{ name: "arg", description: null, type: NAMED_TYPE("Weird"), defaultValue: null }],
                  type: SCALAR("String"),
                },
              ],
              inputFields: null,
              enumValues: null,
            },
            {
              kind: "OBJECT",
              name: "Weird",
              fields: null,
              inputFields: [{ name: "shouldNotAppear", description: null, type: SCALAR("String"), defaultValue: null }],
              enumValues: null,
            },
          ],
        },
      },
    });

    const { discoverToolsFromGraphQl } = await import("../../discovery/graphql-discovery.js");
    const tools = await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
    const tool = tools.find((t) => t.name === "field")!;
    const props = tool.inputSchema.properties as Record<string, unknown>;
    expect(props.arg).toEqual({ type: "string" });
  });
});

describe("buildSelectionSet — a UNION return type always collapses to { __typename }", () => {
  test("a UNION type whose entry (unusually) has fields still collapses to { __typename }, not a built selection", async () => {
    mockFetch({
      data: {
        __schema: {
          queryType: { name: "Query" },
          mutationType: null,
          types: [
            {
              kind: "OBJECT",
              name: "Query",
              fields: [{ name: "field", description: null, args: [], type: typeRef("UNION", "SearchResult") }],
              inputFields: null,
              enumValues: null,
            },
            // A UNION whose entry carries fields (never true for a real GraphQL union,
            // but the code never checks) — the `kind === "UNION"` guard, not the
            // fallback-to-empty-picks path, must be what forces "{ __typename }".
            // Note: buildSelectionSet's branching reads `named.kind` from the TYPE
            // REFERENCE above (`typeRef("UNION", ...)`), not from this typeMap entry's
            // own `kind` field below — the entry's `kind` here is only used to look up
            // `full.fields`, so it doesn't need to match.
            {
              kind: "UNION",
              name: "SearchResult",
              fields: [{ name: "shouldNotAppear", description: null, args: [], type: SCALAR("String") }],
              inputFields: null,
              enumValues: null,
            },
          ],
        },
      },
    });

    const { discoverToolsFromGraphQl } = await import("../../discovery/graphql-discovery.js");
    const tools = await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
    const tool = tools.find((t) => t.name === "field")!;
    expect(tool.query).toContain("{ __typename }");
    expect(tool.query).not.toContain("shouldNotAppear");
  });
});

describe("synthesizeQuery — multiple args are comma-space joined, not concatenated", () => {
  test("a field with two args emits both var decls and call args separated by ', '", async () => {
    mockFetch({
      data: {
        __schema: {
          queryType: { name: "Query" },
          mutationType: null,
          types: [
            {
              kind: "OBJECT",
              name: "Query",
              fields: [
                {
                  name: "twoArgs",
                  description: null,
                  args: [
                    { name: "id", description: null, type: NON_NULL(SCALAR("ID")), defaultValue: null },
                    { name: "name", description: null, type: NON_NULL(SCALAR("String")), defaultValue: null },
                  ],
                  type: SCALAR("String"),
                },
              ],
              inputFields: null,
              enumValues: null,
            },
          ],
        },
      },
    });

    const { discoverToolsFromGraphQl } = await import("../../discovery/graphql-discovery.js");
    const tools = await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
    const tool = tools.find((t) => t.name === "two_args")!;
    expect(tool.query).toBe("query two_args($id: ID!, $name: String!) { twoArgs(id: $id, name: $name) }");
  });
});

describe("discoverToolsFromGraphQl — the types ?? [] fallback is genuinely empty", () => {
  test("an absent types field, with graphqlMaxTypes forced to 0, does not throw GRAPHQL_TOO_MANY_TYPES", async () => {
    const original = config.graphqlMaxTypes;
    (config as Record<string, unknown>).graphqlMaxTypes = 0;
    try {
      mockFetch({ data: { __schema: { queryType: null, mutationType: null } } });
      const { discoverToolsFromGraphQl } = await import("../../discovery/graphql-discovery.js");
      const tools = await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
      expect(tools).toEqual([]);
    } finally {
      (config as Record<string, unknown>).graphqlMaxTypes = original;
    }
  });
});

function NAMED_TYPE(name: string) {
  return typeRef("OBJECT", name);
}
