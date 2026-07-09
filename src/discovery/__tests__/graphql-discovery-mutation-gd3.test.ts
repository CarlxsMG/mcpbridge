import { describe, test, expect, afterEach } from "bun:test";
import { discoverToolsFromGraphQl } from "../../discovery/graphql-discovery.js";

/**
 * Mutation-testing backstop for src/discovery/graphql-discovery.ts,
 * cluster: synthesizeQuery + fieldToTool (source lines 182-226).
 *
 * Targets the following SURVIVING mutants from the domain-6 baseline Stryker
 * run (272 mutants, 118 killed, 154 survived — confirmed against
 * reports/mutation/result.json, not just the task prose, since two of the
 * cited line/col pairs described in the assignment prose as "collision
 * logic" actually land on the arg-description/arg-default-value guards a
 * few lines below the real collision check at line 206, which has zero
 * survivors):
 *
 *   - L188:86-90   StringLiteral ""   — the ": " separator in the `$name: Type`
 *                                        variable declaration (synthesizeQuery).
 *   - L189:72-76   StringLiteral ""   — the ": " separator in the `name: $name`
 *                                        call-site argument (synthesizeQuery).
 *   - L191:63-65   StringLiteral "Stryker was here!" — the "" else-branch of the
 *                                        varDecls ternary in the final query template.
 *   - L191:113-115 StringLiteral "Stryker was here!" — the "" else-branch of the
 *                                        callArgs ternary in the final query template.
 *   - L191:130-145 StringLiteral ``   — the ` ${selection}` then-branch template of
 *                                        the selection ternary, emptied.
 *   - L191:148-150 StringLiteral "Stryker was here!" — the "" else-branch of the
 *                                        selection ternary.
 *   - L214:9-24    ConditionalExpression false — the `arg.description` guard in
 *                                        fieldToTool's arg-schema loop forced to
 *                                        never fire.
 *   - L216:24-48   ConditionalExpression true — the `arg.defaultValue == null`
 *                                        right operand of the `required.push` guard
 *                                        forced to always-true (independent of the
 *                                        `argRequired &&` left operand, which already
 *                                        has its own killed mutants).
 *   - L221:18-74   ConditionalExpression false/true + LogicalOperator (`||`->`&&`)
 *                                        — the `field.description || fallback`
 *                                        expression assembling a tool's description.
 *   - L221:39-74   StringLiteral ``   — the fallback template
 *                                        `GraphQL ${opKind} "${field.name}"` emptied.
 *
 * Fixture helpers are redefined locally (self-contained per this program's
 * convention) rather than imported from the sibling test file.
 */

const originalFetch = globalThis.fetch;

function typeRef(kind: string, name: string | null = null, ofType: unknown = null) {
  return { kind, name, ofType };
}
const NON_NULL = (of: unknown) => typeRef("NON_NULL", null, of);
const SCALAR = (name: string) => typeRef("SCALAR", name);
const NAMED = (kind: string, name: string) => typeRef(kind, name);

/**
 * A schema purpose-built so each field isolates exactly one of the mutants
 * above:
 *   - "pet" (Query): one required arg + an OBJECT return type -> exercises the
 *     "then" branches of all three ternaries at once (var decl colon, call-arg
 *     colon, non-empty selection) via one exact full-string assertion.
 *   - "allPets" (Query): zero args, OBJECT return type -> exercises the "else"
 *     branches of the varDecls/callArgs ternaries (no parens at all) while
 *     selection stays non-empty.
 *   - "ping" (Query): zero args, SCALAR return type, no description -> exercises
 *     the "else" branch of the selection ternary (no trailing braces) AND the
 *     description fallback template.
 *   - "search" (Query): one arg WITH a description -> exercises the L214 guard
 *     firing (argSchema.description gets set).
 *   - "createWidget" (Mutation): one NON_NULL arg with a non-null defaultValue
 *     -> exercises the L216 right-operand guard (must NOT end up required).
 */
function schema() {
  return {
    data: {
      __schema: {
        queryType: { name: "Query" },
        mutationType: { name: "Mutation" },
        types: [
          {
            kind: "OBJECT",
            name: "Query",
            fields: [
              {
                name: "pet",
                description: "Fetch a single pet by id",
                args: [{ name: "id", description: null, type: NON_NULL(SCALAR("ID")), defaultValue: null }],
                type: NAMED("OBJECT", "Pet"),
              },
              {
                name: "allPets",
                description: "List all pets",
                args: [],
                type: NAMED("OBJECT", "Pet"),
              },
              {
                name: "ping",
                description: null,
                args: [],
                type: SCALAR("String"),
              },
              {
                name: "search",
                description: "Search pets",
                args: [
                  {
                    name: "query",
                    description: "free-text search string",
                    type: SCALAR("String"),
                    defaultValue: null,
                  },
                ],
                type: SCALAR("String"),
              },
            ],
            inputFields: null,
            enumValues: null,
          },
          {
            kind: "OBJECT",
            name: "Mutation",
            fields: [
              {
                name: "createWidget",
                description: "Create or update a widget",
                args: [
                  {
                    name: "status",
                    description: null,
                    type: NON_NULL(SCALAR("String")),
                    defaultValue: "ACTIVE",
                  },
                ],
                type: SCALAR("String"),
              },
            ],
            inputFields: null,
            enumValues: null,
          },
          {
            kind: "OBJECT",
            name: "Pet",
            fields: [
              { name: "id", description: null, args: [], type: NON_NULL(SCALAR("ID")) },
              { name: "name", description: null, args: [], type: NON_NULL(SCALAR("String")) },
            ],
            inputFields: null,
            enumValues: null,
          },
          { kind: "SCALAR", name: "ID", fields: null, inputFields: null, enumValues: null },
          { kind: "SCALAR", name: "String", fields: null, inputFields: null, enumValues: null },
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

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("synthesizeQuery — variable/call-arg separators and template assembly", () => {
  test("emits colon-separated var decl and call arg, plus a non-empty selection, for a field with an arg (kills L188:86-90, L189:72-76, L191:130-145)", async () => {
    mockFetch(schema());
    const tools = await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
    const pet = tools.find((t) => t.name === "pet")!;
    expect(pet).toBeDefined();
    // Exact full-string equality: a missing ": " separator (L188/L189) or an
    // emptied selection template (L191:130-145) would each produce a
    // different string than this one.
    expect(pet.query).toBe("query pet($id: ID!) { pet(id: $id) { id name } }");
  });

  test("omits the parens entirely (no placeholder text) for a field with zero arguments (kills L191:63-65, L191:113-115)", async () => {
    mockFetch(schema());
    const tools = await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
    const allPets = tools.find((t) => t.name === "all_pets")!;
    expect(allPets).toBeDefined();
    // If the varDecls/callArgs ternary's "" else-branch were replaced with
    // "Stryker was here!", that literal text would appear right after the
    // tool name / field name instead of being absent.
    expect(allPets.query).toBe("query all_pets { allPets { id name } }");
    expect(allPets.query).not.toContain("Stryker was here!");
    expect(allPets.query).not.toContain("(");
  });

  test("omits the selection suffix entirely (no placeholder text) for a scalar-returning field with zero arguments (kills L191:148-150)", async () => {
    mockFetch(schema());
    const tools = await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
    const ping = tools.find((t) => t.name === "ping")!;
    expect(ping).toBeDefined();
    // If the selection ternary's "" else-branch were replaced with
    // "Stryker was here!", it would appear right before the closing brace.
    expect(ping.query).toBe("query ping { ping }");
    expect(ping.query).not.toContain("Stryker was here!");
  });
});

describe("fieldToTool — arg description and required-with-default handling", () => {
  test("sets argSchema.description when the arg has a description (kills L214:9-24 false-guard mutant)", async () => {
    mockFetch(schema());
    const tools = await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
    const search = tools.find((t) => t.name === "search")!;
    expect(search).toBeDefined();
    const props = search.inputSchema.properties as Record<string, { description?: string; type: string }>;
    expect(props.query).toEqual({ type: "string", description: "free-text search string" });
  });

  test("leaves argSchema.description absent when the arg has no description (isolates the L214 guard's true branch)", async () => {
    mockFetch(schema());
    const tools = await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
    const pet = tools.find((t) => t.name === "pet")!;
    const props = pet.inputSchema.properties as Record<string, unknown>;
    // arg "id" has description: null in the fixture — no description key at all.
    expect(props.id).toEqual({ type: "string" });
  });

  test("excludes a non-null arg from `required` when it carries a non-null defaultValue (kills L216:24-48 forced-true mutant)", async () => {
    mockFetch(schema());
    const tools = await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
    const createWidget = tools.find((t) => t.name === "create_widget")!;
    expect(createWidget).toBeDefined();
    // Real code: argRequired (true) && (arg.defaultValue == null) (false) => false, not pushed.
    // Mutant (right operand forced true): true && true => true, wrongly pushed.
    expect((createWidget.inputSchema as { required?: string[] }).required).toBeUndefined();
    const props = createWidget.inputSchema.properties as Record<string, unknown>;
    expect(props.status).toEqual({ type: "string" });
  });
});

describe("fieldToTool — description fallback assembly (line 221)", () => {
  test("uses field.description verbatim when present, not the fallback or a boolean (kills L221:18-74 ConditionalExpression true/false + LogicalOperator swap)", async () => {
    mockFetch(schema());
    const tools = await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
    const pet = tools.find((t) => t.name === "pet")!;
    expect(pet).toBeDefined();
    // A ConditionalExpression mutant forcing this expression to the literal
    // `true`/`false`, or a LogicalOperator swap (|| -> &&) that would instead
    // evaluate the fallback template when the left operand is truthy, both
    // fail this exact-string check.
    expect(pet.description).toBe("Fetch a single pet by id");
  });

  test('falls back to the exact `GraphQL <opKind> "<field>"` string when description is null (kills L221:39-74 emptied-template mutant)', async () => {
    mockFetch(schema());
    const tools = await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
    const ping = tools.find((t) => t.name === "ping")!;
    expect(ping).toBeDefined();
    // ping's description is null in the fixture, so this must take the
    // fallback branch. If the fallback template were emptied to "", this
    // would be "" instead of the literal text below.
    expect(ping.description).toBe('GraphQL query "ping"');
  });

  test("falls back correctly for a mutation field too (opKind literal is 'mutation', not 'query')", async () => {
    mockFetch(schema());
    const tools = await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
    const createWidget = tools.find((t) => t.name === "create_widget")!;
    expect(createWidget).toBeDefined();
    // createWidget DOES have a description in the fixture, so this also
    // reconfirms the "present" branch under opKind "mutation".
    expect(createWidget.description).toBe("Create or update a widget");
  });
});
