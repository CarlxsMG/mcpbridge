/**
 * A dependency-free GraphQL fixture: a canned introspection response plus a
 * tiny resolver, enough for the bridge's `kind: "graphql"` discovery path
 * (src/discovery/graphql-discovery.ts) to produce real tools and for those
 * tools to return real data when called.
 *
 * No `graphql` package is pulled in — the bridge's own discovery is hand-rolled
 * against the introspection JSON, so the fixture only has to emit that JSON in
 * the shape the standard introspection query returns. The schema it describes:
 *
 *   type Query    { users(limit: Int): [User!]!  user(id: Int!): User }
 *   type Mutation { createUser(input: NewUser!): User! }
 *   input NewUser { name: String!  email: String }
 *   type User     { id: Int!  name: String! }
 *
 * Two queries and one mutation => three discovered tools.
 */

interface TypeRef {
  kind: string;
  name: string | null;
  ofType: TypeRef | null;
}

/** Leaf type reference, e.g. `Int`. */
const named = (kind: string, name: string): TypeRef => ({ kind, name, ofType: null });
/** `T!` */
const nonNull = (of: TypeRef): TypeRef => ({ kind: "NON_NULL", name: null, ofType: of });
/** `[T]` */
const list = (of: TypeRef): TypeRef => ({ kind: "LIST", name: null, ofType: of });

const INT = named("SCALAR", "Int");
const STRING = named("SCALAR", "String");
const USER = named("OBJECT", "User");
const NEW_USER = named("INPUT_OBJECT", "NewUser");

/**
 * The introspection payload. Field/arg descriptions are spelled out because the
 * discovery layer copies them into the MCP tool description, and a spec asserts
 * on that text — an empty description would make the assertion vacuous.
 */
export const GRAPHQL_INTROSPECTION = {
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
              name: "users",
              description: "List users",
              args: [{ name: "limit", description: "Maximum results", type: INT, defaultValue: null }],
              type: nonNull(list(nonNull(USER))),
            },
            {
              name: "user",
              description: "Fetch one user by id",
              args: [{ name: "id", description: "User id", type: nonNull(INT), defaultValue: null }],
              type: USER,
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
              name: "createUser",
              description: "Create a user",
              args: [{ name: "input", description: "The new user", type: nonNull(NEW_USER), defaultValue: null }],
              type: nonNull(USER),
            },
          ],
          inputFields: null,
          enumValues: null,
        },
        {
          kind: "OBJECT",
          name: "User",
          fields: [
            { name: "id", description: null, args: [], type: nonNull(INT) },
            { name: "name", description: null, args: [], type: nonNull(STRING) },
          ],
          inputFields: null,
          enumValues: null,
        },
        {
          kind: "INPUT_OBJECT",
          name: "NewUser",
          fields: null,
          inputFields: [
            { name: "name", description: "Display name", type: nonNull(STRING), defaultValue: null },
            { name: "email", description: "Contact email", type: STRING, defaultValue: null },
          ],
          enumValues: null,
        },
        { kind: "SCALAR", name: "Int", fields: null, inputFields: null, enumValues: null },
        { kind: "SCALAR", name: "String", fields: null, inputFields: null, enumValues: null },
      ],
    },
  },
};

const USERS = [
  { id: 1, name: "Ada Lovelace" },
  { id: 2, name: "Grace Hopper" },
];

/**
 * Resolve a non-introspection operation. Deliberately crude — it matches on the
 * operation name appearing in the document rather than parsing GraphQL, which
 * is all the fixture needs to prove a call reached the upstream and came back.
 */
function resolveOperation(query: string, variables: Record<string, unknown>): Record<string, unknown> {
  if (query.includes("createUser")) {
    const input = (variables.input ?? {}) as { name?: string };
    return { data: { createUser: { id: 99, name: input.name ?? "unnamed" } } };
  }
  if (/\buser\s*\(/.test(query) || query.includes("user(")) {
    const id = Number(variables.id ?? 1);
    const match = USERS.find((u) => u.id === id);
    return { data: { user: match ?? null } };
  }
  if (query.includes("users")) {
    const limit = typeof variables.limit === "number" ? variables.limit : USERS.length;
    return { data: { users: USERS.slice(0, limit) } };
  }
  return { errors: [{ message: `Unknown operation in document: ${query.slice(0, 80)}` }] };
}

/**
 * Handle a POST to the fixture's `/graphql`. Returns the JSON body to send —
 * the introspection payload when the bridge is discovering, resolved data
 * otherwise.
 */
export function handleGraphqlRequest(rawBody: string): Record<string, unknown> {
  let parsed: { query?: string; variables?: Record<string, unknown> };
  try {
    parsed = JSON.parse(rawBody) as { query?: string; variables?: Record<string, unknown> };
  } catch {
    return { errors: [{ message: "Malformed JSON body" }] };
  }
  const query = parsed.query ?? "";
  if (query.includes("__schema")) return GRAPHQL_INTROSPECTION;
  return resolveOperation(query, parsed.variables ?? {});
}
