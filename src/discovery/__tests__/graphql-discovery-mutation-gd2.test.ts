import { describe, test, expect, afterEach } from "bun:test";
import { discoverToolsFromGraphQl } from "../../discovery/graphql-discovery.js";
import { config } from "../../config.js";

/**
 * Targets the surviving mutants in the `buildSelectionSet` cluster
 * (src/discovery/graphql-discovery.ts, lines 159-181) from the domain-6
 * baseline Stryker run. `buildSelectionSet` is not exported, so every
 * assertion here observes its output indirectly via the `.query` string on
 * tools returned by `discoverToolsFromGraphQl`.
 *
 * Self-contained: fixture helpers are redefined locally rather than shared
 * with the sibling test file or other mutation-test files in this program.
 */

const originalFetch = globalThis.fetch;

function typeRef(kind: string, name: string | null = null, ofType: unknown = null) {
  return { kind, name, ofType };
}
const NON_NULL = (of: unknown) => typeRef("NON_NULL", null, of);
const SCALAR = (name: string) => typeRef("SCALAR", name);
const NAMED = (kind: string, name: string) => typeRef(kind, name);

/**
 * One shared schema exercising every branch of buildSelectionSet:
 *  - ghostField   -> OBJECT type absent from typeMap        (L163 "!full")
 *  - scalarField  -> SCALAR type present in typeMap         (L163 SCALAR)
 *  - enumField    -> ENUM type present in typeMap           (L163 ENUM)
 *  - unionField   -> UNION type present in typeMap          (L164 UNION)
 *  - widgetField  -> real OBJECT (Widget), exercising the full field loop:
 *      idField          : SCALAR sub-field (present)        -> included (L172 SCALAR, subFull truthy)
 *      ghostSubField    : OBJECT sub-field absent from map  -> included (L172 !subFull)
 *      enumSubField     : ENUM sub-field (present)          -> included (L172 ENUM, subFull truthy)
 *      scalarSubField   : SCALAR sub-field (present)        -> included (L172 SCALAR, subFull truthy)
 *      childField       : OBJECT sub-field -> NestedWidget -> recurses (L174-176)
 *        NestedWidget.leaf            : SCALAR -> included
 *        NestedWidget.grandchildField : OBJECT -> DoubleNested -> recurses again at depth 2
 *          DoubleNested.deep          : SCALAR -> included
 *      noDefaultField   : 2 args, exactly ONE required-with-no-default -> excluded (L169 .some)
 *      withDefaultField : 1 required arg but WITH a default             -> included (L169 && / == null)
 *  - allExcludedField -> OBJECT (AllExcluded) whose only field is excluded by
 *      the args check -> empty picks -> "{ __typename }" ternary fallback (L179)
 *  - emptyFieldsField -> OBJECT (EmptyFieldsType) with fields: null -> exercises
 *      the `full.fields ?? []` fallback without crashing (L166/L167)
 */
function schema() {
  return {
    data: {
      __schema: {
        queryType: { name: "Query" },
        types: [
          {
            kind: "OBJECT",
            name: "Query",
            fields: [
              { name: "ghostField", description: null, args: [], type: NAMED("OBJECT", "GhostType") },
              { name: "scalarField", description: null, args: [], type: SCALAR("String") },
              { name: "enumField", description: null, args: [], type: NAMED("ENUM", "Status") },
              { name: "unionField", description: null, args: [], type: NAMED("UNION", "SearchResult") },
              { name: "widgetField", description: null, args: [], type: NAMED("OBJECT", "Widget") },
              { name: "allExcludedField", description: null, args: [], type: NAMED("OBJECT", "AllExcluded") },
              { name: "emptyFieldsField", description: null, args: [], type: NAMED("OBJECT", "EmptyFieldsType") },
            ],
            inputFields: null,
            enumValues: null,
          },
          { kind: "SCALAR", name: "String", fields: null, inputFields: null, enumValues: null },
          { kind: "SCALAR", name: "ID", fields: null, inputFields: null, enumValues: null },
          {
            kind: "ENUM",
            name: "Status",
            fields: null,
            inputFields: null,
            enumValues: [{ name: "ACTIVE" }],
          },
          { kind: "UNION", name: "SearchResult", fields: null, inputFields: null, enumValues: null },
          {
            kind: "OBJECT",
            name: "Widget",
            fields: [
              { name: "idField", description: null, args: [], type: SCALAR("ID") },
              { name: "ghostSubField", description: null, args: [], type: NAMED("OBJECT", "GhostType") },
              { name: "enumSubField", description: null, args: [], type: NAMED("ENUM", "Status") },
              { name: "scalarSubField", description: null, args: [], type: SCALAR("String") },
              { name: "childField", description: null, args: [], type: NAMED("OBJECT", "NestedWidget") },
              {
                name: "noDefaultField",
                description: null,
                args: [
                  { name: "a", description: null, type: NON_NULL(SCALAR("String")), defaultValue: null },
                  { name: "b", description: null, type: SCALAR("String"), defaultValue: null },
                ],
                type: SCALAR("String"),
              },
              {
                name: "withDefaultField",
                description: null,
                args: [{ name: "y", description: null, type: NON_NULL(SCALAR("String")), defaultValue: "foo" }],
                type: SCALAR("String"),
              },
            ],
            inputFields: null,
            enumValues: null,
          },
          {
            kind: "OBJECT",
            name: "NestedWidget",
            fields: [
              { name: "leaf", description: null, args: [], type: SCALAR("String") },
              { name: "grandchildField", description: null, args: [], type: NAMED("OBJECT", "DoubleNested") },
            ],
            inputFields: null,
            enumValues: null,
          },
          {
            kind: "OBJECT",
            name: "DoubleNested",
            fields: [{ name: "deep", description: null, args: [], type: SCALAR("String") }],
            inputFields: null,
            enumValues: null,
          },
          {
            kind: "OBJECT",
            name: "AllExcluded",
            fields: [
              {
                name: "onlyField",
                description: null,
                args: [{ name: "z", description: null, type: NON_NULL(SCALAR("String")), defaultValue: null }],
                type: SCALAR("String"),
              },
            ],
            inputFields: null,
            enumValues: null,
          },
          {
            kind: "OBJECT",
            name: "EmptyFieldsType",
            fields: null,
            inputFields: null,
            enumValues: null,
          },
          // GhostType is deliberately absent -> typeMap.get("GhostType") is undefined.
        ],
      },
    },
  };
}

function mockFetch(json: unknown): void {
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function findByField(tools: { query: string }[], fieldName: string) {
  const tool = tools.find((t) => t.query.includes(`{ ${fieldName}`));
  expect(tool).toBeDefined();
  return tool!;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("buildSelectionSet via discoverToolsFromGraphQl", () => {
  test("L163 cluster: missing/SCALAR/ENUM return types all yield an empty selection (no trailing braces)", async () => {
    mockFetch(schema());
    const tools = await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });

    // (a) return type not present in typeMap at all -> full is undefined -> "".
    expect(findByField(tools, "ghostField").query).toContain("{ ghostField }");
    // (b) return type IS a SCALAR present in typeMap -> "".
    expect(findByField(tools, "scalarField").query).toContain("{ scalarField }");
    // (c) return type IS an ENUM present in typeMap -> "".
    expect(findByField(tools, "enumField").query).toContain("{ enumField }");

    // None of these should have a nested selection block at all (that would
    // read "{ ghostField {" / "{ scalarField {" / "{ enumField {").
    expect(findByField(tools, "ghostField").query).not.toContain("ghostField {");
    expect(findByField(tools, "scalarField").query).not.toContain("scalarField {");
    expect(findByField(tools, "enumField").query).not.toContain("enumField {");
  });

  test("L164 cluster: a UNION return type collapses to exactly `{ __typename }`", async () => {
    mockFetch(schema());
    const tools = await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
    expect(findByField(tools, "unionField").query).toContain("{ unionField { __typename } }");
  });

  test("L163/L164 'clearly not excluded' + full field-loop: a real OBJECT return type builds a real selection set", async () => {
    mockFetch(schema());
    const tools = await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
    const widget = findByField(tools, "widgetField");

    // Exact, fully-specified selection at the default depth cap (2):
    //  - idField/enumSubField/scalarSubField: plain leaf sub-fields, all included (L172 branches).
    //  - ghostSubField: sub-field whose return type is absent from typeMap -> still included (L172 !subFull).
    //  - childField recurses into NestedWidget (depth 1), whose own grandchildField recurses into
    //    DoubleNested (depth 2) -- proving depth+1 propagates correctly across two recursive levels
    //    and that the nested string is appended as `${f.name} ${nested}` (L174-176).
    //  - noDefaultField is excluded (2 args, exactly one required-with-no-default -> L169 .some).
    //  - withDefaultField is included despite being required, because it has a default (L169 && / == null).
    //  - picks are space-joined, not concatenated (L179 join separator).
    expect(widget.query).toContain(
      "{ widgetField { idField ghostSubField enumSubField scalarSubField childField { leaf grandchildField { deep } } withDefaultField } }",
    );
    expect(widget.query).not.toContain("noDefaultField");
  });

  test("L179 ternary fallback: a type whose every field is excluded resolves to exactly `{ __typename }`", async () => {
    mockFetch(schema());
    const tools = await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
    expect(findByField(tools, "allExcludedField").query).toContain("{ allExcludedField { __typename } }");
  });

  test("L166/L167 `full.fields ?? []` fallback: a type with fields: null does not crash and yields `{ __typename }`", async () => {
    mockFetch(schema());
    const tools = await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
    expect(findByField(tools, "emptyFieldsField").query).toContain("{ emptyFieldsField { __typename } }");
  });

  test("L164 depth>cap entry guard: a negative maxDepth collapses even a top-level OBJECT to `{ __typename }`", async () => {
    const original = config.graphqlSelectionMaxDepth;
    (config as Record<string, unknown>).graphqlSelectionMaxDepth = -1;
    try {
      mockFetch(schema());
      const tools = await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
      const widget = findByField(tools, "widgetField");
      // At depth 0, 0 > -1 is true, so the field loop never runs at all.
      expect(widget.query).toContain("{ widgetField { __typename } }");
      expect(widget.query).not.toContain("idField");
    } finally {
      (config as Record<string, unknown>).graphqlSelectionMaxDepth = original;
    }
  });

  test("L174 boundary: maxDepth=0 drops the nested OBJECT sub-field entirely (depth < max is false at the boundary)", async () => {
    const original = config.graphqlSelectionMaxDepth;
    (config as Record<string, unknown>).graphqlSelectionMaxDepth = 0;
    try {
      mockFetch(schema());
      const tools = await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
      const widget = findByField(tools, "widgetField");
      // Entry guard (0 > 0) is false, so the loop DOES run -- but the recursion
      // guard (0 < 0) is also false, so childField's OBJECT sub-field is silently
      // dropped (no fallback push), while sibling leaf fields remain.
      expect(widget.query).toContain(
        "{ widgetField { idField ghostSubField enumSubField scalarSubField withDefaultField } }",
      );
      expect(widget.query).not.toContain("childField");
    } finally {
      (config as Record<string, unknown>).graphqlSelectionMaxDepth = original;
    }
  });

  test("L174/L175 boundary: maxDepth=1 recurses exactly one level, proving depth+1 (not depth-1) is used", async () => {
    const original = config.graphqlSelectionMaxDepth;
    (config as Record<string, unknown>).graphqlSelectionMaxDepth = 1;
    try {
      mockFetch(schema());
      const tools = await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
      const widget = findByField(tools, "widgetField");
      // childField recurses once (0 < 1) into NestedWidget at depth 1. Inside that
      // call, grandchildField's own recursion guard (1 < 1) is false, so
      // grandchildField/DoubleNested/deep must NOT appear anywhere. If `depth + 1`
      // were mutated to `depth - 1`, the propagated depth would go negative and
      // the guard would incorrectly keep allowing recursion, pulling
      // "grandchildField { deep }" into the output.
      expect(widget.query).toContain("childField { leaf }");
      expect(widget.query).not.toContain("grandchildField");
      expect(widget.query).not.toContain("deep");
    } finally {
      (config as Record<string, unknown>).graphqlSelectionMaxDepth = original;
    }
  });
});
