/**
 * End-to-end test for the MCP -> MCP gateway direction.
 *
 * The rest of the e2e suite only covers REST/OpenAPI -> MCP. This file covers
 * the other half of the bridge: registering an existing MCP server as an
 * upstream (`kind: "mcp"`), discovering its tools/resources/prompts, and
 * re-exposing them under the gateway's own `clientName__toolName` namespace.
 *
 * ── Why this spec hosts its own MCP server ────────────────────────────────
 * The obvious trick — point an upstream at the bridge's OWN data plane so it
 * proxies to itself — does not work here, for two independent reasons found by
 * reading the source:
 *
 *   1. The data plane advertises every tool as `clientName__toolName`
 *      (registry.effectiveAdvertised), but registry.registerMcp() REJECTS any
 *      discovered tool whose name contains the reserved `__` separator
 *      (validateToolIdentity), and mcp-discovery's normalizeToolName() does not
 *      strip it. So a self-registration fails at discovery time — which is a
 *      real contract, and is asserted below rather than worked around.
 *   2. The bridge injects upstream credentials only from the stored per-client
 *      credential (registration.ts reads getUpstreamAuthHeaders(name); there is
 *      NO `auth` field on the /register payload). Storing one needs
 *      SECRET_ENCRYPTION_KEY, which the e2e stack does not set, so
 *      PUT /admin-api/clients/:name/upstream-auth answers 501. Meanwhile the
 *      data plane is fail-closed the moment any managed key exists
 *      (auth-fail-closed.spec.ts mints one before this file runs), so a
 *      self-pointed upstream could never authenticate.
 *
 * So the upstream is a minimal, hand-rolled MCP server hosted by this spec on an
 * ephemeral loopback port (port 0 — no fixed port to collide with anything
 * else). Its `list-users` tool proxies to the shared REST fixture, so the
 * payload asserted at the end is real fixture data rather than a string this
 * file typed into itself. The full chain exercised is:
 *
 *     playwright -> bridge /mcp/<gw> -> fake MCP upstream -> fixture REST API
 *
 * ALLOW_PRIVATE_IPS=true (playwright.config.ts) is what lets the SSRF guard
 * accept a loopback upstream at all.
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { APP_BASE_URL, FIXTURE_BASE_URL } from "./support/env";
import { apiHeaders, deleteClient, loginAs, mintMcpKey, type AdminAuth } from "./support/admin";
import { initMcpSession, parseSseJson } from "./support/mcp";

// ── Names ───────────────────────────────────────────────────────────────────

/** The gateway-side client the fake upstream is registered as. */
const GW = "e2e-upstream-gw";
/** Registered against the upstream endpoint whose tool name carries the reserved `__`. */
const GW_COLLIDE = "e2e-upstream-collide";
/** Registered against a plain REST URL that does not speak MCP at all. */
const GW_NOT_MCP = "e2e-upstream-notmcp";

const DATA_PLANE = `/mcp/${GW}`;

/** Path on the fake upstream serving the well-formed tool set. */
const UPSTREAM_PATH = "/mcp";
/** Path on the fake upstream serving a tool name the registry must refuse. */
const COLLIDING_PATH = "/mcp-colliding";

/**
 * An upstream tool name that is legal on the MCP wire but illegal in the
 * registry (uppercase, a dot, a space, a bang). mcp-discovery's
 * normalizeToolName lowercases it and maps every char outside [a-z0-9_-] to
 * "_", so this is what the gateway must advertise instead.
 */
const RAW_WEIRD_TOOL = "Weird.Tool Name!";
const NORMALIZED_WEIRD_TOOL = "weird_tool_name_";
/** Returned only when the upstream is called with RAW_WEIRD_TOOL — pins the dispatch name. */
const WEIRD_TOOL_MARKER = "reached the raw upstream tool name";

/** A tool that declares outputSchema AND returns matching structuredContent. */
const STRUCTURED_TOOL = "structured-stats";
const STRUCTURED_SOURCE = "e2e-upstream-fake-mcp";

/** An upstream tool whose name collides with the gateway's composite-key separator. */
const COLLIDING_TOOL = "e2e-upstream-origin__list-users";

const RESOURCE_URI = "mem://e2e-upstream/greeting";
const RESOURCE_TEXT = "greeting text served by the e2e MCP upstream";
const PROMPT_NAME = "e2e-upstream-greeting";
const PROMPT_TEXT = "A canned prompt body from the e2e MCP upstream.";

// ── The fake MCP upstream ───────────────────────────────────────────────────

/** Minimal shape of the JSON-RPC envelopes the bridge's SDK client sends. */
interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** One tool as advertised over the wire by the fake upstream. */
interface UpstreamToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

/** One request the bridge made against the fake upstream. */
interface UpstreamRequestLog {
  method: string;
  path: string;
  /** The JSON-RPC method, when the body parsed as one. */
  rpc: string | null;
}

interface FakeUpstream {
  baseUrl: string;
  requests: UpstreamRequestLog[];
  close: () => Promise<void>;
}

const UPSTREAM_TOOLS: UpstreamToolDef[] = [
  {
    name: "list-users",
    description: "List all users, proxied from the fixture REST backend",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: RAW_WEIRD_TOOL,
    description: "An upstream name the registry identifier rules cannot accept verbatim",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: STRUCTURED_TOOL,
    description: "Declares an outputSchema and returns conforming structuredContent",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: { userCount: { type: "number" }, source: { type: "string" } },
      required: ["userCount", "source"],
    },
  },
];

const COLLIDING_TOOLS: UpstreamToolDef[] = [
  {
    name: COLLIDING_TOOL,
    description: "Its name contains the reserved clientName__toolName separator",
    inputSchema: { type: "object", properties: {} },
  },
];

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Dispatches one upstream tools/call. Matches on the RAW upstream name the bridge sends. */
async function callUpstreamTool(params: Record<string, unknown>): Promise<unknown> {
  const name = typeof params.name === "string" ? params.name : "";

  if (name === "list-users") {
    // Proxied from the shared REST fixture on purpose: it makes the
    // "Ada Lovelace" assertion at the end evidence of a real round trip
    // rather than a constant this file wrote and then read back.
    const upstream = await fetch(`${FIXTURE_BASE_URL}/api/v1/users`);
    return { content: [{ type: "text", text: await upstream.text() }] };
  }
  if (name === RAW_WEIRD_TOOL) {
    return { content: [{ type: "text", text: WEIRD_TOOL_MARKER }] };
  }
  if (name === STRUCTURED_TOOL) {
    const payload = { userCount: 2, source: STRUCTURED_SOURCE };
    return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
  }
  return { content: [{ type: "text", text: `Unknown upstream tool: ${name}` }], isError: true };
}

/**
 * Produces the JSON-RPC `result` for one upstream method, or null when the
 * method is unknown (the caller turns that into a -32601 error envelope).
 */
async function upstreamResult(path: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "initialize":
      return {
        // Echo whatever the bridge asked for: the SDK client rejects a
        // protocolVersion outside its SUPPORTED_PROTOCOL_VERSIONS list, and
        // the version it requests is by definition in it.
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: STRUCTURED_SOURCE, version: "1.0.0" },
      };
    case "ping":
      // The health loop probes MCP upstreams with a JSON-RPC ping rather than
      // an HTTP GET on health_url (observability/health.ts).
      return {};
    case "tools/list":
      return { tools: path === COLLIDING_PATH ? COLLIDING_TOOLS : UPSTREAM_TOOLS };
    case "tools/call":
      return callUpstreamTool(params);
    case "resources/list":
      return {
        resources: [
          { uri: RESOURCE_URI, name: "greeting", description: "A canned upstream resource", mimeType: "text/plain" },
        ],
      };
    case "resources/read":
      return {
        contents: [
          {
            uri: typeof params.uri === "string" ? params.uri : RESOURCE_URI,
            mimeType: "text/plain",
            text: RESOURCE_TEXT,
          },
        ],
      };
    case "prompts/list":
      return {
        prompts: [{ name: PROMPT_NAME, description: "A canned upstream prompt", arguments: [] }],
      };
    case "prompts/get":
      return {
        description: "A canned upstream prompt",
        messages: [{ role: "user", content: { type: "text", text: PROMPT_TEXT } }],
      };
    default:
      return null;
  }
}

async function handleUpstreamRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requests: UpstreamRequestLog[],
): Promise<void> {
  const path = (req.url ?? "").split("?")[0];
  const method = req.method ?? "GET";

  if (method !== "POST") {
    requests.push({ method, path, rpc: null });
    // 405 is the spec-sanctioned "no SSE stream on GET here". The bridge's
    // outbound client never issues this (it is constructed without an auth
    // provider, which is the only thing that opens the GET stream) — the last
    // test in this file asserts exactly that.
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  const raw = await readBody(req);
  let msg: JsonRpcMessage;
  try {
    msg = JSON.parse(raw) as JsonRpcMessage;
  } catch {
    requests.push({ method, path, rpc: null });
    sendJson(res, 400, { error: "invalid JSON" });
    return;
  }
  requests.push({ method, path, rpc: typeof msg.method === "string" ? msg.method : null });

  // A JSON-RPC notification (no `id`) has no response envelope. Answering 200
  // with an inert body — rather than 202 — keeps the SDK client from opening
  // its optional GET/SSE stream after `notifications/initialized`.
  if (msg.id === undefined || msg.id === null) {
    sendJson(res, 200, {});
    return;
  }

  const result = await upstreamResult(path, msg.method ?? "", msg.params ?? {});
  if (result === null) {
    sendJson(res, 200, {
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: `Method not found: ${msg.method ?? ""}` },
    });
    return;
  }
  sendJson(res, 200, { jsonrpc: "2.0", id: msg.id, result });
}

/** Boots the fake upstream on an ephemeral loopback port. */
async function startFakeMcpUpstream(): Promise<FakeUpstream> {
  const requests: UpstreamRequestLog[] = [];
  const server = createServer((req, res) => {
    void handleUpstreamRequest(req, res, requests);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake MCP upstream did not bind to a TCP port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      // The bridge holds a pooled keep-alive connection, which would keep
      // server.close() pending. closeAllConnections exists on Node's http
      // server; probe for it rather than assume the host runtime has it.
      const closeAll = (server as { closeAllConnections?: () => void }).closeAllConnections;
      if (typeof closeAll === "function") closeAll.call(server);
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

// ── Gateway-side helpers ────────────────────────────────────────────────────

interface RegisterResult {
  status: number;
  body: string;
}

/**
 * Registers an MCP upstream through the REAL /register contract, as read off
 * registration.ts's performMcpRegistration: the payload is
 * `{name, kind:"mcp", mcp_url, mcp_transport?}` and nothing else. Notably there
 * is NO `auth` field — upstream credentials come exclusively from the stored
 * per-client credential (getUpstreamAuthHeaders), and `health_url` is ignored
 * on this branch (registerMcp pins health_url to mcp_url itself).
 */
async function registerMcpUpstream(
  request: APIRequestContext,
  auth: AdminAuth,
  payload: Record<string, unknown>,
): Promise<RegisterResult> {
  const res = await request.post(`${APP_BASE_URL}/register`, {
    headers: apiHeaders(auth),
    data: { kind: "mcp", ...payload },
  });
  return { status: res.status(), body: await res.text() };
}

function errorOf(body: string): { code?: string; message?: string } {
  const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } };
  return parsed.error ?? {};
}

interface RpcResponse {
  status: number;
  result?: unknown;
  error?: unknown;
}

/**
 * One JSON-RPC round trip on an established data-plane session. Unlike
 * support/mcp.ts's `mcpCall` this hands back the whole `result` object, which
 * the structuredContent / resources / prompts assertions below need.
 */
async function rpc(sessionId: string, authHeader: string, body: Record<string, unknown>): Promise<RpcResponse> {
  const res = await fetch(`${APP_BASE_URL}${DATA_PLANE}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      authorization: authHeader,
    },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) return { status: res.status };
  const parsed = parseSseJson(await res.text());
  return { status: res.status, result: parsed.result, error: parsed.error };
}

/** A tool as advertised by the gateway's tools/list. */
interface AdvertisedTool {
  name: string;
  description?: string;
  title?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

interface ToolCallResult {
  isError?: boolean;
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

function textOf(result: ToolCallResult | undefined): string {
  return (result?.content ?? []).map((c) => c.text ?? "").join("\n");
}

test.describe("MCP upstream gateway — MCP-to-MCP registration, discovery and dispatch", () => {
  let page: Page;
  let request: APIRequestContext;
  let auth: AdminAuth;
  let authHeader: string;
  let upstream: FakeUpstream;
  let registration: RegisterResult;

  /** Opens a fresh data-plane session — each test gets its own, as in mcp-protocol.spec.ts. */
  async function session(): Promise<string> {
    const init = await initMcpSession(DATA_PLANE, { authHeader, clientName: "e2e-upstream" });
    return init.sessionId;
  }

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    request = page.context().request;
    auth = await loginAs(page);

    // The data plane is fail-closed once any managed key exists; mint our own
    // so this spec does not depend on which other spec ran first.
    authHeader = (await mintMcpKey(request, auth, "e2e-upstream")).authHeader;

    upstream = await startFakeMcpUpstream();
    registration = await registerMcpUpstream(request, auth, {
      name: GW,
      mcp_url: `${upstream.baseUrl}${UPSTREAM_PATH}`,
      mcp_transport: "streamable-http",
    });
  });

  test.afterAll(async () => {
    // Drop the client before the upstream goes away, so the health loop is not
    // left probing a dead port for the rest of the run.
    await deleteClient(request, auth, GW);
    await upstream.close();
    await page.close();
  });

  test('registering an MCP upstream reports source "mcp" and the discovered tool count', () => {
    expect(registration.status, `register failed: ${registration.body}`).toBe(200);
    const body = JSON.parse(registration.body) as {
      status?: string;
      name?: string;
      source?: string;
      tools_count?: number;
    };
    expect(body.status).toBe("registered");
    expect(body.name).toBe(GW);
    expect(body.source).toBe("mcp");
    expect(body.tools_count).toBe(UPSTREAM_TOOLS.length);
  });

  test('the upstream is listed with kind "mcp" in GET /admin-api/clients', async () => {
    const res = await request.get(`${APP_BASE_URL}/admin-api/clients?q=${GW}`, { headers: apiHeaders(auth) });
    expect(res.status()).toBe(200);
    const listed = (await res.json()) as { items: { name: string; kind: string; toolsCount: number }[] };
    const found = listed.items.find((c) => c.name === GW);
    expect(found, `clients list did not contain ${GW}`).toBeDefined();
    expect(found?.kind).toBe("mcp");
    expect(found?.toolsCount).toBe(UPSTREAM_TOOLS.length);
  });

  test("the client detail keeps the MCP URL/transport and pins health_url to it (ping-probed, not GET-probed)", async () => {
    const res = await request.get(`${APP_BASE_URL}/admin-api/clients/${GW}`, { headers: apiHeaders(auth) });
    expect(res.status()).toBe(200);
    const detail = (await res.json()) as {
      kind: string;
      mcpUrl: string | null;
      mcpTransport: string | null;
      healthUrl: string;
      tools: { name: string; upstreamName?: string }[];
    };

    expect(detail.kind).toBe("mcp");
    expect(detail.mcpUrl).toBe(`${upstream.baseUrl}${UPSTREAM_PATH}`);
    expect(detail.mcpTransport).toBe("streamable-http");
    // registerMcp sets health_url = mcp_url: an MCP upstream has no separate
    // HTTP liveness endpoint, because the health loop pings it over JSON-RPC.
    expect(detail.healthUrl).toBe(detail.mcpUrl);

    // The registry-safe name is what the key is built from; the raw upstream
    // name is kept alongside it for dispatch.
    const weird = detail.tools.find((t) => t.name === NORMALIZED_WEIRD_TOOL);
    expect(weird, `discovered tools: ${detail.tools.map((t) => t.name).join(", ")}`).toBeDefined();
    expect(weird?.upstreamName).toBe(RAW_WEIRD_TOOL);
  });

  test("upstream tools are re-exposed under the gateway's clientName__toolName namespace", async () => {
    const sessionId = await session();
    const res = await rpc(sessionId, authHeader, { jsonrpc: "2.0", method: "tools/list", id: 2, params: {} });
    expect(res.status).toBe(200);
    const tools = (res.result as { tools?: AdvertisedTool[] } | undefined)?.tools ?? [];
    const names = tools.map((t) => t.name);

    expect(names).toContain(`${GW}__list-users`);
    expect(names).toContain(`${GW}__${STRUCTURED_TOOL}`);
    // The wire-legal-but-registry-illegal upstream name is advertised only in
    // its normalized form — never verbatim.
    expect(names).toContain(`${GW}__${NORMALIZED_WEIRD_TOOL}`);
    expect(names).not.toContain(`${GW}__${RAW_WEIRD_TOOL}`);
  });

  test("calling a re-exposed tool reaches the upstream and returns its real payload", async () => {
    const sessionId = await session();
    const res = await rpc(sessionId, authHeader, {
      jsonrpc: "2.0",
      method: "tools/call",
      id: 3,
      params: { name: `${GW}__list-users`, arguments: {} },
    });
    expect(res.status).toBe(200);
    const result = res.result as ToolCallResult | undefined;
    expect(result?.isError).toBeFalsy();
    // "Ada Lovelace" originates in the REST fixture, three hops away:
    // playwright -> bridge -> fake MCP upstream -> fixture REST API.
    expect(textOf(result)).toContain("Ada Lovelace");
  });

  test("dispatch sends the RAW upstream tool name, not the normalized one", async () => {
    const sessionId = await session();
    const res = await rpc(sessionId, authHeader, {
      jsonrpc: "2.0",
      method: "tools/call",
      id: 4,
      params: { name: `${GW}__${NORMALIZED_WEIRD_TOOL}`, arguments: {} },
    });
    expect(res.status).toBe(200);
    const result = res.result as ToolCallResult | undefined;
    expect(result?.isError).toBeFalsy();
    // The upstream only emits this marker when it was called with
    // RAW_WEIRD_TOOL, so seeing it proves upstreamName survived the round trip.
    expect(textOf(result)).toContain(WEIRD_TOOL_MARKER);
  });

  test("an advertised outputSchema is always matched by structuredContent on a successful call", async () => {
    // Pins a real past regression: advertising an upstream's outputSchema while
    // dropping structuredContent made SDK clients reject every call with
    // InvalidRequest. Advertise and return must stay consistent.
    const sessionId = await session();
    const listed = await rpc(sessionId, authHeader, { jsonrpc: "2.0", method: "tools/list", id: 5, params: {} });
    const tools = (listed.result as { tools?: AdvertisedTool[] } | undefined)?.tools ?? [];

    const withOutputSchema = tools.filter((t) => t.outputSchema !== undefined);
    // Guards the loop below against passing vacuously.
    expect(withOutputSchema.map((t) => t.name)).toContain(`${GW}__${STRUCTURED_TOOL}`);

    for (const tool of withOutputSchema) {
      const called = await rpc(sessionId, authHeader, {
        jsonrpc: "2.0",
        method: "tools/call",
        id: 6,
        params: { name: tool.name, arguments: {} },
      });
      expect(called.status).toBe(200);
      const result = called.result as ToolCallResult | undefined;
      expect(result?.isError, `${tool.name} returned an error result`).toBeFalsy();
      expect(
        result?.structuredContent,
        `${tool.name} advertises outputSchema but returned no structuredContent`,
      ).toBeDefined();
    }

    const structured = await rpc(sessionId, authHeader, {
      jsonrpc: "2.0",
      method: "tools/call",
      id: 7,
      params: { name: `${GW}__${STRUCTURED_TOOL}`, arguments: {} },
    });
    const result = structured.result as ToolCallResult | undefined;
    expect(result?.structuredContent?.source).toBe(STRUCTURED_SOURCE);
    expect(result?.structuredContent?.userCount).toBe(2);
  });

  test("the upstream's resources are discovered and passed through", async () => {
    const sessionId = await session();
    const listed = await rpc(sessionId, authHeader, { jsonrpc: "2.0", method: "resources/list", id: 8, params: {} });
    expect(listed.status).toBe(200);
    const resources = (listed.result as { resources?: { uri?: string }[] } | undefined)?.resources ?? [];
    expect(resources.map((r) => r.uri)).toContain(RESOURCE_URI);

    const read = await rpc(sessionId, authHeader, {
      jsonrpc: "2.0",
      method: "resources/read",
      id: 9,
      params: { uri: RESOURCE_URI },
    });
    expect(read.status).toBe(200);
    const contents = (read.result as { contents?: { text?: string }[] } | undefined)?.contents ?? [];
    expect(contents.map((c) => c.text ?? "").join("\n")).toContain(RESOURCE_TEXT);
  });

  test("the upstream's prompts are discovered and passed through", async () => {
    const sessionId = await session();
    const listed = await rpc(sessionId, authHeader, { jsonrpc: "2.0", method: "prompts/list", id: 10, params: {} });
    expect(listed.status).toBe(200);
    const prompts = (listed.result as { prompts?: { name?: string }[] } | undefined)?.prompts ?? [];
    expect(prompts.map((p) => p.name)).toContain(PROMPT_NAME);

    const got = await rpc(sessionId, authHeader, {
      jsonrpc: "2.0",
      method: "prompts/get",
      id: 11,
      params: { name: PROMPT_NAME, arguments: {} },
    });
    expect(got.status).toBe(200);
    const messages = (got.result as { messages?: { content?: { text?: string } }[] } | undefined)?.messages ?? [];
    expect(messages.map((m) => m.content?.text ?? "").join("\n")).toContain(PROMPT_TEXT);
  });

  test("an upstream tool name containing the reserved __ separator is refused, leaving no client behind", async () => {
    // `clientName__toolName` has to stay an injective encoding, so registerMcp
    // rejects a discovered tool name carrying the separator — which is also why
    // the bridge's own data plane cannot be registered as an upstream of itself.
    const res = await registerMcpUpstream(request, auth, {
      name: GW_COLLIDE,
      mcp_url: `${upstream.baseUrl}${COLLIDING_PATH}`,
    });
    expect(res.status).toBe(400);
    const err = errorOf(res.body);
    expect(err.code).toBe("DISCOVERY_ERROR");
    expect(err.message).toContain("__");

    const detail = await request.get(`${APP_BASE_URL}/admin-api/clients/${GW_COLLIDE}`, { headers: apiHeaders(auth) });
    expect(detail.status(), "a rejected registration must not leave a half-registered client").toBe(404);
  });

  test("registering a URL that does not speak MCP fails cleanly with no client created", async () => {
    // The fixture's /health is a perfectly good HTTP endpoint that is not an
    // MCP server — the handshake has to fail as a DISCOVERY_ERROR rather than
    // registering a client that can never serve a call.
    const res = await registerMcpUpstream(request, auth, {
      name: GW_NOT_MCP,
      mcp_url: `${FIXTURE_BASE_URL}/health`,
    });
    expect(res.status).toBe(400);
    expect(errorOf(res.body).code).toBe("DISCOVERY_ERROR");

    const detail = await request.get(`${APP_BASE_URL}/admin-api/clients/${GW_NOT_MCP}`, { headers: apiHeaders(auth) });
    expect(detail.status()).toBe(404);
  });

  test("the registration payload is validated before any outbound connection", async () => {
    const badUrl = await registerMcpUpstream(request, auth, { name: GW_NOT_MCP, mcp_url: "ftp://example.com/mcp" });
    expect(badUrl.status).toBe(400);
    expect(errorOf(badUrl.body).code).toBe("VALIDATION_ERROR");
    expect(errorOf(badUrl.body).message).toContain("mcp_url");

    const badTransport = await registerMcpUpstream(request, auth, {
      name: GW_NOT_MCP,
      mcp_url: `${upstream.baseUrl}${UPSTREAM_PATH}`,
      mcp_transport: "grpc",
    });
    expect(badTransport.status).toBe(400);
    expect(errorOf(badTransport.body).code).toBe("VALIDATION_ERROR");
    expect(errorOf(badTransport.body).message).toContain("mcp_transport");
  });

  test("the bridge only ever talks JSON-RPC to an MCP upstream (never an HTTP GET health probe)", () => {
    // MCP upstreams are liveness-checked with a JSON-RPC ping over the pooled
    // connection, not an HTTP GET against health_url. Any GET here would mean
    // the REST health path leaked onto an MCP-kind client.
    const nonPost = upstream.requests.filter((r) => r.method !== "POST");
    expect(nonPost, `unexpected non-POST traffic: ${JSON.stringify(nonPost)}`).toEqual([]);

    // Sanity: the log is non-empty and really is MCP traffic.
    expect(upstream.requests.some((r) => r.rpc === "initialize")).toBe(true);
    expect(upstream.requests.some((r) => r.rpc === "tools/list")).toBe(true);
    expect(upstream.requests.some((r) => r.rpc === "tools/call")).toBe(true);
  });
});
