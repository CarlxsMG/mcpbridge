/**
 * End-to-end coverage for the bridge's THIRD backend kind: a GraphQL upstream
 * (`kind: "graphql"` at POST /register). REST is covered by smoke.spec.ts and
 * mcp-protocol.spec.ts; this file proves the GraphQL path reaches the same
 * `clientName__toolName` identity and therefore the same governance pipeline.
 *
 * The upstream is e2e/support/graphql-fixture.ts, served at the fixture's
 * POST /graphql: a canned introspection payload plus a crude resolver for
 *
 *   type Query    { users(limit: Int): [User!]!  user(id: Int!): User }
 *   type Mutation { createUser(input: NewUser!): User! }
 *   input NewUser { name: String!  email: String }
 *
 * Two queries + one mutation => three discovered tools. What this covers that
 * the backend unit tests don't:
 *
 *   - Registration actually runs introspection over the wire (SSRF-validated,
 *     IP-pinned) and lands three tools in the registry.
 *   - The hand-rolled GraphQL-type -> JSON-Schema mapper in
 *     src/discovery/graphql-discovery.ts produces the schema an MCP client
 *     really sees on `tools/list` — NON_NULL becoming `required`, INPUT_OBJECT
 *     nesting as a real object schema, Int mapping to `"number"`. Pure logic,
 *     the most likely thing to regress silently, and cheap to pin here.
 *   - The synthesized GraphQL document (persisted per tool via setToolGraphql)
 *     is valid enough that a real call round-trips: tool args become GraphQL
 *     `variables`, and the `{ data: ... }` envelope comes back to the caller.
 *   - A GraphQL-over-HTTP failure (200 + top-level `errors[]`, null `data`)
 *     surfaces as an MCP `isError:true` result, the same contract the REST
 *     path has in mcp-protocol.spec.ts.
 *
 * Naming note: the tools are `users`, `user` and `create_user` — NOT
 * `createUser`. src/discovery/tool-naming.ts's sanitizeToolName snake_cases the
 * camelCase field name before it enters the registry.
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { APP_BASE_URL, FIXTURE_BASE_URL, FIXTURE_GRAPHQL_PATH } from "./support/env";
import {
  adminAuthHeaders,
  apiHeaders,
  deleteClient,
  login,
  mintMcpKey,
  registerGraphqlViaApi,
  type AdminAuth,
} from "./support/admin";
import { closeTrackedMcpSessions, initMcpSession, mcpCall, mcpToolsCall, parseSseJson } from "./support/mcp";

/** Unique names per spec run so this file can run alongside the other specs. */
const SERVER_NAME = "e2e-gql-api";
/** Second client, registered with include_mutations:false to prove the filter. */
const QUERIES_ONLY_NAME = "e2e-gql-queries-only";
const DATA_PLANE = `/mcp/${SERVER_NAME}`;

/** Tool names exactly as the discovery layer produces them (see the module doc). */
const T_USERS = "users";
const T_USER = "user";
const T_CREATE_USER = "create_user";

/**
 * The documents graphql-discovery.ts synthesizes for each field. Pinned here
 * because they are what actually gets POSTed upstream — a regression in
 * synthesizeQuery/buildSelectionSet (a dropped variable declaration, an empty
 * selection set) would still register three tools and only fail at call time.
 */
const EXPECTED_DOCUMENTS: Record<string, string> = {
  [T_USERS]: "query users($limit: Int) { users(limit: $limit) { id name } }",
  [T_USER]: "query user($id: Int!) { user(id: $id) { id name } }",
  [T_CREATE_USER]: "mutation create_user($input: NewUser!) { createUser(input: $input) { id name } }",
};

// ── Local shapes + helpers (this spec owns them; support/* belongs to others) ─

/** The slice of JSON Schema the GraphQL mapper can emit. */
interface SchemaNode {
  type?: string;
  description?: string;
  required?: string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
}

/** One entry of an MCP `tools/list` result. */
interface AdvertisedTool {
  name: string;
  description?: string;
  inputSchema?: SchemaNode;
}

/** The POST /register success envelope (src/mcp/registration.ts's RegisterOutcome). */
interface RegisterBody {
  status?: string;
  name?: string;
  tools_count?: number;
  source?: string;
}

/** The fields of GET /admin-api/clients/:name this spec reads. */
interface ClientDetailBody {
  kind: string;
  tools: {
    name: string;
    guards?: { rateLimitPerMin?: number };
    graphql?: { enabled: boolean; query: string };
  }[];
}

/**
 * `tools/list` against this spec's data plane, minus the synthetic
 * `search_tools` meta-tool the gateway appends whenever it has something to
 * search (config.enableSearchTool defaults on and the e2e env doesn't disable
 * it). That one carries no `client__` prefix, so filtering on the prefix leaves
 * exactly the client's own tools.
 */
async function listClientTools(sessionId: string, authHeader: string): Promise<AdvertisedTool[]> {
  const res = await fetch(`${APP_BASE_URL}${DATA_PLANE}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      authorization: authHeader,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 2, params: {} }),
  });
  expect(res.status).toBe(200);
  const parsed = parseSseJson(await res.text());
  const tools = (parsed.result as { tools?: AdvertisedTool[] } | undefined)?.tools ?? [];
  return tools.filter((t) => t.name.startsWith(`${SERVER_NAME}__`));
}

/** Look an advertised tool up by its bare (unprefixed) name, failing loudly if absent. */
function advertised(tools: AdvertisedTool[], toolName: string): AdvertisedTool {
  const found = tools.find((t) => t.name === `${SERVER_NAME}__${toolName}`);
  if (!found) {
    throw new Error(`tool "${toolName}" not advertised — got: ${tools.map((t) => t.name).join(", ") || "(none)"}`);
  }
  return found;
}

/** Read a schema property, failing with the surrounding schema rather than a null deref. */
function propOf(schema: SchemaNode | undefined, name: string): SchemaNode {
  const prop = schema?.properties?.[name];
  if (!prop) throw new Error(`schema has no property "${name}": ${JSON.stringify(schema)}`);
  return prop;
}

/**
 * POST /register for a GraphQL client, returning the parsed body.
 *
 * support/admin.ts's `registerGraphqlViaApi` covers the default case and is
 * used for the main client below; this variant exists only because the spec
 * needs (a) the response body — `tools_count` / `source` are the registration
 * contract — and (b) the `include_mutations` flag that
 * performGraphqlRegistration reads but the shared helper doesn't expose.
 */
async function registerGraphqlRaw(
  request: APIRequestContext,
  auth: AdminAuth,
  serverName: string,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: RegisterBody }> {
  const res = await request.post(`${APP_BASE_URL}/register`, {
    headers: apiHeaders(auth),
    data: {
      name: serverName,
      kind: "graphql",
      health_url: `${FIXTURE_BASE_URL}/health`,
      graphql_url: `${FIXTURE_BASE_URL}${FIXTURE_GRAPHQL_PATH}`,
      ...extra,
    },
  });
  const text = await res.text();
  expect([200, 201, 409], `register graphql(${serverName}) failed: ${res.status()} ${text}`).toContain(res.status());
  return { status: res.status(), body: JSON.parse(text) as RegisterBody };
}

async function clientDetail(
  request: APIRequestContext,
  auth: AdminAuth,
  serverName: string,
): Promise<ClientDetailBody> {
  const res = await request.get(`${APP_BASE_URL}/admin-api/clients/${serverName}`, { headers: apiHeaders(auth) });
  expect(res.status(), `client detail failed: ${await res.text()}`).toBe(200);
  return (await res.json()) as ClientDetailBody;
}

/** PATCH one body key onto a tool's policy (guards, graphql, ...). */
async function patchTool(
  request: APIRequestContext,
  auth: AdminAuth,
  toolName: string,
  body: Record<string, unknown>,
): Promise<void> {
  const res = await request.patch(`${APP_BASE_URL}/admin-api/clients/${SERVER_NAME}/tools/${toolName}`, {
    headers: apiHeaders(auth),
    data: body,
  });
  expect(res.status(), `tool patch failed: ${await res.text()}`).toBe(200);
}

test.describe("GraphQL backend kind — discovery, schema mapping, dispatch, governance", () => {
  let page: Page;
  let request: APIRequestContext;
  let auth: AdminAuth;
  let authHeader: string;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    request = page.context().request;
    await login(page);
    auth = await adminAuthHeaders(page);

    // Registration goes through the API, not the register-server form: the
    // subject here is the GraphQL discovery + dispatch path, not the SPA.
    await registerGraphqlViaApi(request, auth, SERVER_NAME);

    // Mint a key so the data plane is in a known auth-required state and this
    // spec is independent of the order it runs in.
    const minted = await mintMcpKey(request, auth, "e2e-gql");
    authHeader = minted.authHeader;
  });

  test.afterAll(async () => {
    // Hand session slots back to the process-wide maxSessions budget.
    await closeTrackedMcpSessions();
    await page.close();
  });

  /** Fresh session per test — the Streamable HTTP transport keeps per-session state. */
  async function session(): Promise<string> {
    const init = await initMcpSession(DATA_PLANE, { authHeader, clientName: "e2e-gql" });
    return init.sessionId;
  }

  test("introspection discovers exactly one tool per query/mutation field, with the discovery layer's names", async () => {
    const tools = await listClientTools(await session(), authHeader);

    // Three fields => three tools. `createUser` is advertised as `create_user`:
    // sanitizeToolName (src/discovery/tool-naming.ts) snake_cases the camelCase
    // GraphQL field name into the registry's tool-name rule.
    expect(tools.map((t) => t.name).sort()).toEqual([
      `${SERVER_NAME}__${T_CREATE_USER}`,
      `${SERVER_NAME}__${T_USER}`,
      `${SERVER_NAME}__${T_USERS}`,
    ]);
  });

  test("the generated inputSchema maps scalars, NON_NULL and INPUT_OBJECT the way graphql-discovery.ts intends", async () => {
    const tools = await listClientTools(await session(), authHeader);

    // `users(limit: Int)` — a nullable Int arg: a `number` property, NOT required.
    // (GraphQL Int/Float both map to JSON Schema "number", never "integer".)
    const users = advertised(tools, T_USERS).inputSchema;
    expect(users?.type).toBe("object");
    expect(propOf(users, "limit").type).toBe("number");
    expect(users?.required ?? []).not.toContain("limit");

    // `user(id: Int!)` — NON_NULL becomes membership in the parent's `required`.
    const user = advertised(tools, T_USER).inputSchema;
    expect(propOf(user, "id").type).toBe("number");
    expect(user?.required).toEqual(["id"]);

    // `createUser(input: NewUser!)` — the INPUT_OBJECT nests as a real object
    // schema carrying its own required list, rather than collapsing to a string.
    const createUser = advertised(tools, T_CREATE_USER).inputSchema;
    expect(createUser?.required).toEqual(["input"]);
    const input = propOf(createUser, "input");
    expect(input.type).toBe("object");
    expect(propOf(input, "name").type).toBe("string");
    expect(propOf(input, "email").type).toBe("string");
    expect(input.required).toEqual(["name"]);
  });

  test("field and argument descriptions survive into the advertised MCP tool", async () => {
    const tools = await listClientTools(await session(), authHeader);

    expect(advertised(tools, T_USERS).description).toBe("List users");
    expect(advertised(tools, T_USER).description).toBe("Fetch one user by id");
    expect(advertised(tools, T_CREATE_USER).description).toBe("Create a user");

    // Argument descriptions ride along on the schema properties (they pass
    // through sanitizeToolDescription unchanged — nothing here is suspicious).
    expect(propOf(advertised(tools, T_USERS).inputSchema, "limit").description).toBe("Maximum results");
    expect(propOf(advertised(tools, T_USER).inputSchema, "id").description).toBe("User id");

    const input = propOf(advertised(tools, T_CREATE_USER).inputSchema, "input");
    expect(input.description).toBe("The new user");
    expect(propOf(input, "name").description).toBe("Display name");
  });

  test("each tool persists its synthesized GraphQL document, on an otherwise ordinary REST-kind client", async () => {
    const detail = await clientDetail(request, auth, SERVER_NAME);

    // NOTE — the registry has no "graphql" upstream kind. `UpstreamKind` is
    // "rest" | "mcp" (src/mcp/types.ts) and performGraphqlRegistration calls
    // registry.register(), so a GraphQL backend is persisted as a REST client
    // whose tools each carry a per-tool GraphQL config (see the module doc of
    // src/proxy/backends.ts: "Extra backend protocols exposed as per-tool
    // config on an existing REST client (no new registry `kind` needed)").
    // That is exactly why every governance feature applies unchanged — there is
    // no second code path to keep in sync.
    expect(detail.kind).toBe("rest");

    for (const [toolName, document] of Object.entries(EXPECTED_DOCUMENTS)) {
      const tool = detail.tools.find((t) => t.name === toolName);
      expect(tool, `tool ${toolName} missing from client detail`).toBeDefined();
      expect(tool?.graphql?.enabled).toBe(true);
      expect(tool?.graphql?.query).toBe(document);
    }
  });

  test("a query dispatches for real — the bridge POSTs the synthesized document and unwraps the response", async () => {
    const call = await mcpToolsCall(DATA_PLANE, await session(), `${SERVER_NAME}__${T_USERS}`, authHeader);

    expect(call.status).toBe(200);
    expect(call.isError).toBeFalsy();
    // The fixture resolver's canned users, returned inside the GraphQL
    // `{ data: { users: [...] } }` envelope the bridge passes straight through.
    expect(call.text).toContain("Ada Lovelace");
    expect(call.text).toContain("Grace Hopper");
  });

  test("tool arguments are forwarded as GraphQL variables (limit:1 returns one user)", async () => {
    // Connectivity alone would return both users regardless of the argument —
    // the fixture resolver honours `variables.limit`, so a single result proves
    // the args really became the document's variables.
    const call = await mcpToolsCall(DATA_PLANE, await session(), `${SERVER_NAME}__${T_USERS}`, authHeader, {
      limit: 1,
    });

    expect(call.status).toBe(200);
    expect(call.isError).toBeFalsy();
    expect(call.text).toContain("Ada Lovelace");
    expect(call.text).not.toContain("Grace Hopper");
  });

  test("a mutation dispatches, nested input-object args included", async () => {
    // GraphQL tools are registered with method POST, which is non-idempotent
    // and therefore NEVER retried on failure (dispatch-rest.ts's isIdempotent) —
    // so this single call is exactly one upstream request.
    const call = await mcpToolsCall(DATA_PLANE, await session(), `${SERVER_NAME}__${T_CREATE_USER}`, authHeader, {
      input: { name: "Ada Byron" },
    });

    expect(call.status).toBe(200);
    expect(call.isError).toBeFalsy();
    // The fixture echoes the input name back with a fixed id of 99.
    expect(call.text).toContain("Ada Byron");
    expect(call.text).toMatch(/"id":\s*99/);
  });

  test("include_mutations:false registers only the query fields", async () => {
    try {
      const registered = await registerGraphqlRaw(request, auth, QUERIES_ONLY_NAME, { include_mutations: false });
      expect(registered.body.source).toBe("graphql");
      expect(registered.body.tools_count).toBe(2);

      const detail = await clientDetail(request, auth, QUERIES_ONLY_NAME);
      expect(detail.tools.map((t) => t.name).sort()).toEqual([T_USER, T_USERS]);
    } finally {
      // Independent of the main client, so it can go straight back out again.
      await deleteClient(request, auth, QUERIES_ONLY_NAME);
    }
  });

  test("a per-tool guard is enforced on a GraphQL tool exactly as on a REST one", async () => {
    // The `user` tool is not called by any other test in this file, so the
    // per-tool rate-limit bucket (keyed on `client__tool`) is this test's alone.
    try {
      await patchTool(request, auth, T_USER, { guards: { rateLimitPerMin: 1 } });

      const detail = await clientDetail(request, auth, SERVER_NAME);
      expect(detail.tools.find((t) => t.name === T_USER)?.guards?.rateLimitPerMin).toBe(1);

      const sessionId = await session();
      await mcpToolsCall(DATA_PLANE, sessionId, `${SERVER_NAME}__${T_USER}`, authHeader, { id: 1 });
      const second = await mcpToolsCall(DATA_PLANE, sessionId, `${SERVER_NAME}__${T_USER}`, authHeader, { id: 1 });

      // Enforced at the dispatch point (proxyToolCall's gate pipeline), which
      // the GraphQL path shares with REST — hence the identical message. Only
      // the second call is asserted on: a reused dev server could carry a
      // partially-consumed bucket from an earlier run into the first one.
      expect(second.status).toBe(200);
      expect(second.isError).toBe(true);
      expect(second.text).toMatch(/rate limit/i);
    } finally {
      await patchTool(request, auth, T_USER, { guards: null });
    }
  });

  test("a GraphQL-level error surfaces as isError:true, not a transport error", async () => {
    // GraphQL answers 200 even for a failed operation, signalling failure only
    // via a top-level `errors[]` with null/absent `data`. Reaching that state
    // needs a document the fixture's resolver doesn't recognise, so temporarily
    // point one tool at a bogus operation via the per-tool graphql policy.
    const original = EXPECTED_DOCUMENTS[T_CREATE_USER];
    try {
      await patchTool(request, auth, T_CREATE_USER, {
        graphql: { enabled: true, query: "mutation e2eBogusOperation { nothingHere }" },
      });

      const call = await mcpCall(
        DATA_PLANE,
        await session(),
        {
          jsonrpc: "2.0",
          method: "tools/call",
          id: 3,
          params: { name: `${SERVER_NAME}__${T_CREATE_USER}`, arguments: { input: { name: "Ada Byron" } } },
        },
        authHeader,
      );

      // Same contract the REST path has in mcp-protocol.spec.ts: a 200 JSON-RPC
      // envelope carrying isError:true, so the agent keeps its session.
      expect(call.status).toBe(200);
      expect(call.isError).toBe(true);
      expect(call.text).toMatch(/Unknown operation/i);
    } finally {
      await patchTool(request, auth, T_CREATE_USER, { graphql: { enabled: true, query: original } });
    }

    // The restore really took — and the client is healthy again after the
    // deliberate failure above (which records one circuit-breaker failure).
    const restored = await mcpToolsCall(DATA_PLANE, await session(), `${SERVER_NAME}__${T_CREATE_USER}`, authHeader, {
      input: { name: "Grace Hopper" },
    });
    expect(restored.isError).toBeFalsy();
    expect(restored.text).toContain("Grace Hopper");
  });
});
