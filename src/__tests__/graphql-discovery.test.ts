import { describe, test, expect, afterEach } from "bun:test";
import { discoverToolsFromGraphQl } from "../discovery/graphql-discovery.js";
import { config } from "../config.js";

const originalFetch = globalThis.fetch;

function typeRef(kind: string, name: string | null = null, ofType: unknown = null) {
  return { kind, name, ofType };
}
const NON_NULL = (of: unknown) => typeRef("NON_NULL", null, of);
const LIST = (of: unknown) => typeRef("LIST", null, of);
const SCALAR = (name: string) => typeRef("SCALAR", name);
const NAMED = (kind: string, name: string) => typeRef(kind, name);

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
                name: "pets",
                description: "List pets, optionally filtered by status",
                args: [{ name: "status", description: null, type: NAMED("ENUM", "PetStatus"), defaultValue: null }],
                type: NON_NULL(LIST(NON_NULL(NAMED("OBJECT", "Pet")))),
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
                name: "createPet",
                description: "Create a new pet",
                args: [
                  {
                    name: "input",
                    description: null,
                    type: NON_NULL(NAMED("INPUT_OBJECT", "PetInput")),
                    defaultValue: null,
                  },
                ],
                type: NAMED("OBJECT", "Pet"),
              },
              {
                // Collides with the query field "pet" after snake_case normalization is NOT
                // the case here (different name) — this one specifically collides with
                // itself across query/mutation via a shared normalized name "pet".
                name: "Pet",
                description: "Deliberately shares a normalized name with the query field 'pet'",
                args: [],
                type: NAMED("OBJECT", "Pet"),
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
              { name: "status", description: null, args: [], type: NAMED("ENUM", "PetStatus") },
            ],
            inputFields: null,
            enumValues: null,
          },
          {
            kind: "ENUM",
            name: "PetStatus",
            fields: null,
            inputFields: null,
            enumValues: [{ name: "AVAILABLE" }, { name: "SOLD" }],
          },
          {
            kind: "INPUT_OBJECT",
            name: "PetInput",
            fields: null,
            inputFields: [
              { name: "name", description: null, type: NON_NULL(SCALAR("String")), defaultValue: null },
              { name: "status", description: null, type: NAMED("ENUM", "PetStatus"), defaultValue: "AVAILABLE" },
            ],
            enumValues: null,
          },
          { kind: "SCALAR", name: "ID", fields: null, inputFields: null, enumValues: null },
          { kind: "SCALAR", name: "String", fields: null, inputFields: null, enumValues: null },
        ],
      },
    },
  };
}

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

describe("discoverToolsFromGraphQl", () => {
  test("discovers query and mutation fields with type-mapped input schemas", async () => {
    mockFetch(schema());
    const tools = await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });

    const pet = tools.find((t) => t.name === "pet")!;
    expect(pet).toBeDefined();
    expect(pet.inputSchema).toEqual({ type: "object", properties: { id: { type: "string" } }, required: ["id"] });
    expect(pet.query).toContain("query pet($id: ID!)");
    expect(pet.query).toContain("pet(id: $id)");

    const pets = tools.find((t) => t.name === "pets")!;
    expect(pets).toBeDefined();
    expect(pets.inputSchema).toEqual({
      type: "object",
      properties: { status: { type: "string", enum: ["AVAILABLE", "SOLD"] } },
    });

    const createPet = tools.find((t) => t.name === "create_pet")!;
    expect(createPet).toBeDefined();
    const props = createPet.inputSchema.properties as Record<string, unknown>;
    expect(props.input).toEqual({
      type: "object",
      properties: { name: { type: "string" }, status: { type: "string", enum: ["AVAILABLE", "SOLD"] } },
      required: ["name"],
    });
    expect((createPet.inputSchema as { required?: string[] }).required).toEqual(["input"]);
  });

  test("excludes mutations when includeMutations is false", async () => {
    mockFetch(schema());
    const tools = await discoverToolsFromGraphQl({
      graphqlUrl: "http://example.test/graphql",
      includeMutations: false,
    });
    expect(tools.some((t) => t.name === "create_pet")).toBe(false);
    expect(tools.some((t) => t.name === "pet")).toBe(true);
  });

  test("disambiguates a query/mutation field name collision", async () => {
    mockFetch(schema());
    const tools = await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
    // "pet" (query) and "Pet" (mutation, normalizes to "pet") must not collide.
    const names = tools.map((t) => t.name);
    expect(names.filter((n) => n === "pet")).toHaveLength(1);
    expect(names).toContain("mutation_pet");
  });

  test("throws GRAPHQL_INTROSPECTION_DISABLED when __schema is absent", async () => {
    mockFetch({ data: {} });
    await expect(discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" })).rejects.toThrow(
      /GRAPHQL_INTROSPECTION_DISABLED/,
    );
  });

  test("throws on GraphQL errors in the introspection response", async () => {
    mockFetch({ errors: [{ message: "not authorized" }] });
    await expect(discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" })).rejects.toThrow(
      /not authorized/,
    );
  });

  test("throws GRAPHQL_TOO_MANY_TYPES when the schema exceeds the configured cap", async () => {
    const original = config.graphqlMaxTypes;
    (config as Record<string, unknown>).graphqlMaxTypes = 1;
    try {
      mockFetch(schema());
      await expect(discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" })).rejects.toThrow(
        /GRAPHQL_TOO_MANY_TYPES/,
      );
    } finally {
      (config as Record<string, unknown>).graphqlMaxTypes = original;
    }
  });

  test("subscriptions are never discovered (no subscriptionType handling)", async () => {
    const withSub = schema();
    (withSub.data.__schema as Record<string, unknown>).subscriptionType = { name: "Subscription" };
    mockFetch(withSub);
    const tools = await discoverToolsFromGraphQl({ graphqlUrl: "http://example.test/graphql" });
    // No crash, and no tool derived from a subscription (there's no Subscription type in `types`, proving it's never consulted).
    expect(tools.length).toBeGreaterThan(0);
  });
});
