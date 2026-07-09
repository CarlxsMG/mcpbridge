import { describe, test, expect, afterEach } from "bun:test";
import { discoverToolsFromGraphQl } from "../../discovery/graphql-discovery.js";
import { config } from "../../config.js";

/**
 * Stryker mutation backstop for src/discovery/graphql-discovery.ts.
 *
 * Cluster covered: unwrap / printTypeRef / scalarToJsonType / typeToJsonSchema
 * (source lines ~103-157). None of `unwrap`, `printTypeRef`, `scalarToJsonType`,
 * or `typeToJsonSchema` is exported, so every assertion here observes them
 * indirectly through `discoverToolsFromGraphQl`'s output: a tool's
 * `inputSchema` (built from arg types via typeToJsonSchema/unwrap/
 * scalarToJsonType) and its `query` text (var declarations built from
 * printTypeRef).
 *
 * Self-contained: this file redefines its own `typeRef`/`NON_NULL`/`LIST`/
 * `SCALAR`/`NAMED` fixture helpers rather than importing the sibling test
 * file's, per the program's per-file isolation convention.
 *
 * Targeted survivors (baseline Stryker run, 272 mutants / 154 survived):
 *   - unwrap()'s NON_NULL branch: ConditionalExpression false, StringLiteral
 *     "", BlockStatement emptied, BooleanLiteral `required = true` -> false.
 *   - unwrap()'s LIST branch (incl. nested NON_NULL-after-LIST unwrap):
 *     ConditionalExpression true/false, EqualityOperator ===/!==,
 *     StringLiteral "".
 *   - printTypeRef()'s NON_NULL and LIST branches: ConditionalExpression
 *     false, StringLiteral "" (both the compared literal and the template
 *     output).
 *   - scalarToJsonType()'s Int/Float check: ConditionalExpression,
 *     LogicalOperator ||->&&, StringLiteral "".
 *   - scalarToJsonType()'s Boolean check: ConditionalExpression,
 *     StringLiteral "" (both literals).
 *   - typeToJsonSchema()'s depth cap: EqualityOperator >->=, ConditionalExpression,
 *     BlockStatement, ObjectLiteral, StringLiteral.
 *   - typeToJsonSchema()'s ENUM check: LogicalOperator &&->||,
 *     ConditionalExpression, OptionalChaining.
 *   - typeToJsonSchema()'s INPUT_OBJECT check: same mirrored cluster.
 *   - typeToJsonSchema()'s recursive `depth + 1` -> `depth - 1`.
 *   - typeToJsonSchema()'s `if (f.description)` guard: ConditionalExpression false.
 *   - typeToJsonSchema()'s `fieldRequired && f.defaultValue == null`:
 *     LogicalOperator &&->||, ConditionalExpression.
 *   - typeToJsonSchema()'s final scalar-fallback ObjectLiteral/StringLiteral.
 */

const originalFetch = globalThis.fetch;

function typeRef(kind: string, name: string | null = null, ofType: unknown = null) {
  return { kind, name, ofType };
}
const NON_NULL = (of: unknown) => typeRef("NON_NULL", null, of);
const LIST = (of: unknown) => typeRef("LIST", null, of);
const SCALAR = (name: string) => typeRef("SCALAR", name);
const NAMED = (kind: string, name: string) => typeRef(kind, name);

interface ArgFixture {
  name: string;
  description?: string | null;
  type: unknown;
  defaultValue?: string | null;
}

/** Builds a minimal introspection response with a single Query field "op" taking the given args. */
function schemaWithArgs(args: ArgFixture[], extraTypes: unknown[] = []) {
  return {
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
                name: "op",
                description: null,
                args: args.map((a) => ({
                  name: a.name,
                  description: a.description ?? null,
                  type: a.type,
                  defaultValue: a.defaultValue ?? null,
                })),
                type: SCALAR("String"),
              },
            ],
            inputFields: null,
            enumValues: null,
          },
          ...extraTypes,
        ],
      },
    },
  };
}

function mockFetch(json: unknown): void {
  globalThis.fetch = (async () => {
    const text = JSON.stringify(json);
    return new Response(text, { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Discovers tools from a single-field ("op") schema and returns that tool. */
async function discoverOp(args: ArgFixture[], extraTypes: unknown[] = []) {
  mockFetch(schemaWithArgs(args, extraTypes));
  const tools = await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
  const op = tools.find((t) => t.name === "op");
  expect(op).toBeDefined();
  return op!;
}

describe("graphql-discovery mutation gd1: unwrap / printTypeRef / scalarToJsonType / typeToJsonSchema", () => {
  // --- unwrap(): NON_NULL branch -------------------------------------------------------------
  test("unwrap: a NON_NULL-wrapped arg is marked required and unwraps to the inner scalar", async () => {
    const op = await discoverOp([{ name: "id", type: NON_NULL(SCALAR("ID")) }]);
    // Exact structural equality: if the NON_NULL check/body/boolean-literal mutants fire,
    // "required" would be omitted entirely (required.length is 0 => key dropped).
    expect(op.inputSchema).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    });
  });

  test("unwrap: a bare (non-NON_NULL) arg is NOT marked required", async () => {
    const op = await discoverOp([{ name: "id", type: SCALAR("ID") }]);
    expect(op.inputSchema).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
    });
    expect(Object.prototype.hasOwnProperty.call(op.inputSchema, "required")).toBe(false);
  });

  // --- unwrap(): LIST branch (incl. nested NON_NULL-after-LIST unwrap) ----------------------
  test("unwrap: a LIST-wrapped arg produces an array schema", async () => {
    const op = await discoverOp([{ name: "tags", type: LIST(SCALAR("String")) }]);
    expect(op.inputSchema).toEqual({
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" } } },
    });
  });

  test("unwrap: a bare (non-LIST) arg is NOT wrapped as an array, and resolution does not throw", async () => {
    // Kills the ConditionalExpression-true mutant on `if (cur.kind === "LIST")`: forcing it
    // true unconditionally would run `cur = cur.ofType!` on a SCALAR (ofType === null), then
    // crash on the next `cur.kind` access — so a clean, exact non-array result kills it.
    const op = await discoverOp([{ name: "name", type: SCALAR("String") }]);
    expect(op.inputSchema).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
    });
  });

  test("unwrap: LIST(NON_NULL(scalar)) unwraps the inner NON_NULL before mapping the scalar type", async () => {
    // If the nested `if (cur.kind === "NON_NULL") cur = cur.ofType!;` inside the LIST branch
    // is disabled, `named` stays the NON_NULL wrapper (name: null) and scalarToJsonType(null)
    // falls back to "string" instead of "number" for this Int-typed list element.
    const op = await discoverOp([{ name: "counts", type: LIST(NON_NULL(SCALAR("Int"))) }]);
    expect(op.inputSchema).toEqual({
      type: "object",
      properties: { counts: { type: "array", items: { type: "number" } } },
    });
  });

  // --- printTypeRef(): NON_NULL and LIST branches -------------------------------------------
  test("printTypeRef: a NON_NULL arg prints a trailing '!'", async () => {
    const op = await discoverOp([{ name: "id", type: NON_NULL(SCALAR("ID")) }]);
    expect(op.query).toContain("$id: ID!");
  });

  test("printTypeRef: a LIST arg prints bracket notation", async () => {
    const op = await discoverOp([{ name: "tags", type: LIST(SCALAR("String")) }]);
    expect(op.query).toContain("$tags: [String]");
  });

  test("printTypeRef: LIST(NON_NULL(scalar)) combines brackets and the bang", async () => {
    const op = await discoverOp([{ name: "tags", type: LIST(NON_NULL(SCALAR("String"))) }]);
    expect(op.query).toContain("$tags: [String!]");
  });

  test("printTypeRef: a bare scalar arg prints just its name (no bang, no brackets) and does not throw", async () => {
    // Kills ConditionalExpression-true mutants on printTypeRef's NON_NULL/LIST checks: forcing
    // either branch true for a plain SCALAR would dereference a null `ofType` and throw.
    const op = await discoverOp([{ name: "name", type: SCALAR("String") }]);
    expect(op.query).toContain("$name: String");
    expect(op.query).not.toContain("String!");
    expect(op.query).not.toContain("[String");
  });

  // --- scalarToJsonType(): Int/Float -> "number" ---------------------------------------------
  test("scalarToJsonType: Int maps to number", async () => {
    const op = await discoverOp([{ name: "count", type: SCALAR("Int") }]);
    expect(op.inputSchema).toEqual({ type: "object", properties: { count: { type: "number" } } });
  });

  test("scalarToJsonType: Float ALSO maps to number (proves both sides of the || matter)", async () => {
    const op = await discoverOp([{ name: "amount", type: SCALAR("Float") }]);
    expect(op.inputSchema).toEqual({ type: "object", properties: { amount: { type: "number" } } });
  });

  test("scalarToJsonType: an unrelated scalar (String) is NOT forced to number", async () => {
    const op = await discoverOp([{ name: "label", type: SCALAR("String") }]);
    expect(op.inputSchema).toEqual({ type: "object", properties: { label: { type: "string" } } });
  });

  // --- scalarToJsonType(): Boolean -> "boolean" ----------------------------------------------
  test("scalarToJsonType: Boolean maps to boolean, not the string fallback or number", async () => {
    const op = await discoverOp([{ name: "flag", type: SCALAR("Boolean") }]);
    expect(op.inputSchema).toEqual({ type: "object", properties: { flag: { type: "boolean" } } });
  });

  // --- typeToJsonSchema(): ENUM branch --------------------------------------------------------
  test("typeToJsonSchema: an ENUM arg present in typeMap renders type:string + its enum values", async () => {
    const colorEnum = {
      kind: "ENUM",
      name: "Color",
      fields: null,
      inputFields: null,
      enumValues: [{ name: "RED" }, { name: "BLUE" }],
    };
    const op = await discoverOp([{ name: "color", type: NAMED("ENUM", "Color") }], [colorEnum]);
    expect(op.inputSchema).toEqual({
      type: "object",
      properties: { color: { type: "string", enum: ["RED", "BLUE"] } },
    });
  });

  test("typeToJsonSchema: an ENUM-kind arg absent from typeMap falls back to scalar mapping without crashing", async () => {
    // Kills the &&->|| swap and the OptionalChaining removal: under either mutant, reaching
    // the ENUM branch with `full` undefined would dereference `full.enumValues` and throw.
    const op = await discoverOp([{ name: "color", type: NAMED("ENUM", "GhostColor") }]);
    expect(op.inputSchema).toEqual({
      type: "object",
      properties: { color: { type: "string" } },
    });
  });

  // --- typeToJsonSchema(): INPUT_OBJECT branch (mirror of ENUM) -------------------------------
  test("typeToJsonSchema: an INPUT_OBJECT-kind arg absent from typeMap falls back to scalar mapping without crashing", async () => {
    const op = await discoverOp([{ name: "filter", type: NAMED("INPUT_OBJECT", "GhostInput") }]);
    expect(op.inputSchema).toEqual({
      type: "object",
      properties: { filter: { type: "string" } },
    });
  });

  test("typeToJsonSchema: an INPUT_OBJECT present in typeMap but with inputFields:null falls back to scalar mapping", async () => {
    const emptyInput = { kind: "INPUT_OBJECT", name: "EmptyInput", fields: null, inputFields: null, enumValues: null };
    const op = await discoverOp([{ name: "filter", type: NAMED("INPUT_OBJECT", "EmptyInput") }], [emptyInput]);
    expect(op.inputSchema).toEqual({
      type: "object",
      properties: { filter: { type: "string" } },
    });
  });

  // --- typeToJsonSchema(): depth cap + recursive depth+1 --------------------------------------
  test("typeToJsonSchema: nested INPUT_OBJECT truncation triggers exactly beyond config.graphqlInputMaxDepth", async () => {
    // With graphqlInputMaxDepth overridden to 1:
    //   depth 0 = OuterInput itself           -> clearly under cap, not truncated
    //   depth 1 = InnerInput (field "b")       -> exact boundary (1 > 1 is false), not truncated
    //   depth 2 = the scalar field "c"         -> clearly over cap, truncated
    // This also kills the `depth + 1` -> `depth - 1` mutant: under `- 1`, depth would go
    // negative and NEVER exceed the cap, so field "c" would never be truncated at all.
    // And it kills the `>` -> `>=` mutant: under `>=`, depth 1 (InnerInput) would ALSO be
    // truncated, collapsing "b" to the truncated placeholder instead of a nested object.
    const original = config.graphqlInputMaxDepth;
    (config as Record<string, unknown>).graphqlInputMaxDepth = 1;
    try {
      const innerInput = {
        kind: "INPUT_OBJECT",
        name: "InnerInput",
        fields: null,
        inputFields: [{ name: "c", description: null, type: SCALAR("String"), defaultValue: null }],
        enumValues: null,
      };
      const outerInput = {
        kind: "INPUT_OBJECT",
        name: "OuterInput",
        fields: null,
        inputFields: [{ name: "b", description: null, type: NAMED("INPUT_OBJECT", "InnerInput"), defaultValue: null }],
        enumValues: null,
      };
      const op = await discoverOp(
        [{ name: "input", type: NAMED("INPUT_OBJECT", "OuterInput") }],
        [innerInput, outerInput],
      );
      expect(op.inputSchema).toEqual({
        type: "object",
        properties: {
          input: {
            type: "object",
            properties: {
              b: {
                type: "object",
                properties: {
                  c: { type: "string", description: "(nested input truncated)" },
                },
              },
            },
          },
        },
      });
    } finally {
      (config as Record<string, unknown>).graphqlInputMaxDepth = original;
    }
  });

  // --- typeToJsonSchema(): `if (f.description)` guard ------------------------------------------
  test("typeToJsonSchema: an input field's description is copied when present, and omitted entirely when absent", async () => {
    const descInput = {
      kind: "INPUT_OBJECT",
      name: "DescInput",
      fields: null,
      inputFields: [
        { name: "withDesc", description: "has a description", type: SCALAR("String"), defaultValue: null },
        { name: "noDesc", description: null, type: SCALAR("String"), defaultValue: null },
      ],
      enumValues: null,
    };
    const op = await discoverOp([{ name: "input", type: NAMED("INPUT_OBJECT", "DescInput") }], [descInput]);
    const inputProp = (
      op.inputSchema as { properties: { input: { properties: Record<string, Record<string, unknown>> } } }
    ).properties.input.properties;
    expect(inputProp.withDesc).toEqual({ type: "string", description: "has a description" });
    // hasOwnProperty, not just falsy — a mutant that always assigns `undefined` would still
    // pass a falsy/loose check but would leave the key present.
    expect(Object.prototype.hasOwnProperty.call(inputProp.noDesc, "description")).toBe(false);
    expect(inputProp.noDesc).toEqual({ type: "string" });
  });

  // --- typeToJsonSchema(): `fieldRequired && f.defaultValue == null` ---------------------------
  test("typeToJsonSchema: only a NON_NULL field with NO defaultValue is pushed to required", async () => {
    // "optionalNoDefault" isolates the &&->|| swap: fieldRequired=false but defaultValue==null
    // is true, so `||` would incorrectly push it, while real `&&` code must not.
    // "requiredWithDefault" isolates the same swap from the other side: fieldRequired=true but
    // defaultValue!=null, so `||` would (also) incorrectly push it via the first operand alone.
    const reqInput = {
      kind: "INPUT_OBJECT",
      name: "ReqInput",
      fields: null,
      inputFields: [
        { name: "requiredNoDefault", description: null, type: NON_NULL(SCALAR("String")), defaultValue: null },
        { name: "requiredWithDefault", description: null, type: NON_NULL(SCALAR("String")), defaultValue: "foo" },
        { name: "optionalNoDefault", description: null, type: SCALAR("String"), defaultValue: null },
      ],
      enumValues: null,
    };
    const op = await discoverOp([{ name: "input", type: NAMED("INPUT_OBJECT", "ReqInput") }], [reqInput]);
    const inputProp = (op.inputSchema as { properties: { input: { required?: string[] } } }).properties.input;
    expect(inputProp.required).toEqual(["requiredNoDefault"]);
  });

  // --- typeToJsonSchema(): final scalar-fallback ObjectLiteral/StringLiteral -------------------
  test("typeToJsonSchema: the plain-scalar fallback schema is exactly { type: <mapped> }, nothing extra", async () => {
    // Kills the ObjectLiteral mutant (whole literal emptied) and the "type" key StringLiteral
    // mutant on the final `{ type: scalarToJsonType(named.name) }` fallback.
    const op = await discoverOp([{ name: "name", type: SCALAR("String") }]);
    expect((op.inputSchema as { properties: Record<string, unknown> }).properties.name).toEqual({ type: "string" });
  });
});
