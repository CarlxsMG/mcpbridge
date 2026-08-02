/**
 * End-to-end test for the curated-bundle data plane, `/mcp-custom/:bundleName`.
 *
 * A bundle is an admin-curated, CROSS-CLIENT subset of the registry: named
 * `(client, tool)` pairs plus optional composite macros, served at their own
 * top-level endpoint. It is one of the bridge's two narrowing filters in front
 * of the unchanged dispatch pipeline (the other being the per-client shard
 * `/mcp/:clientName`).
 *
 * What this proves that the unit tests don't:
 *
 *   - The whole stack agrees on one bundle. The SPA's create form writes it,
 *     SQLite stores it, `initBundles`/`liveBundles` serves it, and a real MCP
 *     client reaches exactly the curated subset over the wire — a chain no
 *     single unit test spans. The bundle is created by driving the real
 *     `/admin/bundles/new` page (name field + BundleToolPicker + submit)
 *     rather than by POSTing to the admin API, because the tool picker is the
 *     only place a human ever selects bundle members and nothing else in the
 *     e2e suite exercises it; every *other* step here uses the admin API,
 *     which is not what this spec is about.
 *
 *   - The bundle is an access FILTER, not a display filter. A bundle that
 *     merely hides tools from `tools/list` while still dispatching them on
 *     `tools/call` is a broken authorization boundary that a `tools/list`-only
 *     assertion would happily pass. Both refusal tests below therefore probe
 *     tools that would visibly SUCCEED if the filter leaked (an `echo` on a
 *     client that is itself represented in the bundle), and assert on the
 *     exact refusal text, so a dispatched call could not be mistaken for a
 *     refusal.
 *
 *   - The `/mcp/:clientName` vs `/mcp-custom/:bundleName` route split holds.
 *     `/mcp-custom` is deliberately a sibling top-level path rather than a
 *     path nested under `/mcp` (see the mounting comments in
 *     src/mcp/transports.ts: `app.use` prefix-matches on segments, so nesting
 *     would double-run the origin/auth/rate-limit chains). An unknown bundle
 *     name must therefore 404 as a *bundle*, never fall through to the `/mcp`
 *     control-plane chain — which, for the plain managed key used here, would
 *     produce a rootMcpAuth 403 instead. The status code is the observable
 *     difference between the two mountings.
 *
 * Registration uses the fixture backend twice under two names so the bundle is
 * genuinely cross-client: one server discovered from the shared
 * fixtures/simple-openapi.json (`list-users` + `create-user`), one from the
 * e2e-only extended document (same two, plus `echo` and friends) to give the
 * refusal tests a would-otherwise-succeed sibling tool to probe with.
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { APP_BASE_URL, FIXTURE_OPENAPI_EXTENDED_PATH } from "./support/env";
import { apiHeaders, loginAs, mintMcpKey, registerViaApi, type AdminAuth } from "./support/admin";
import { initMcpSession, mcpCall, mcpToolsCall, parseSseJson } from "./support/mcp";

/** Two servers, so the bundle spans more than one client. Unique per spec file. */
const SERVER_A = "e2e-bundle-alpha-api";
const SERVER_B = "e2e-bundle-beta-api";

const BUNDLE_NAME = "e2e-bundle-cross";
const BUNDLE_PLANE = `/mcp-custom/${BUNDLE_NAME}`;

/** A composite (macro) tool — reachable ONLY once added to a bundle's composites[]. */
const COMPOSITE_NAME = "e2e-bundle-macro";

/** The gateway's own discovery meta-tool, appended to every non-empty tools/list. */
const SEARCH_TOOL = "search_tools";

/** What the bridge sees as this spec's client identity in `initialize`. */
const CLIENT_LABEL = "e2e-bundles";

/** The two curated members: one tool from each server. */
const IN_BUNDLE_A = `${SERVER_A}__list-users`;
const IN_BUNDLE_B = `${SERVER_B}__list-users`;

/**
 * Out-of-bundle probes. Both belong to clients that ARE represented in the
 * bundle, which is the case that matters: membership is per TOOL, not per
 * client, so a filter that checked only the client prefix would leak these.
 * `echo` is the sharper of the two — it is a live GET that returns a
 * recognisable body, so a leaked dispatch cannot be confused with a refusal.
 */
const OUT_OF_BUNDLE_ECHO = `${SERVER_B}__echo`;
const OUT_OF_BUNDLE_CREATE = `${SERVER_A}__create-user`;

interface AdvertisedToolShape {
  name: string;
}

interface RawMcpResponse {
  status: number;
  body: string;
  sessionId: string | null;
}

/**
 * A sessionless `initialize` POST, kept raw. `initMcpSession` throws on any
 * non-200, which is exactly the case the unknown-bundle and auth tests need to
 * inspect rather than blow up on.
 */
async function rawInitialize(path: string, authHeader?: string): Promise<RawMcpResponse> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (authHeader) headers.authorization = authHeader;
  const res = await fetch(`${APP_BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      id: 1,
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: CLIENT_LABEL, version: "1.0" },
      },
    }),
  });
  return { status: res.status, sessionId: res.headers.get("mcp-session-id"), body: await res.text() };
}

/** The advertised tool names on an established bundle session. */
async function toolNamesOn(path: string, sessionId: string, authHeader: string): Promise<string[]> {
  const res = await fetch(`${APP_BASE_URL}${path}`, {
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
  const tools = (parsed.result as { tools?: AdvertisedToolShape[] } | undefined)?.tools ?? [];
  return tools.map((t) => t.name).sort();
}

/**
 * Tick one tool in the BundleToolPicker.
 *
 * The picker lists every registered tool across every client, and this suite
 * shares one database with a dozen other specs' servers — so narrow with the
 * picker's own client-side filter first (it matches client / tool /
 * description substrings) and the row lookup stays unambiguous no matter what
 * else is registered. Filtering also keeps the selection inside the picker's
 * 22.5rem scroll box, away from its sticky header.
 */
async function pickTool(page: Page, clientName: string, toolName: string): Promise<void> {
  await page.locator(".tool-picker .search-input input").fill(clientName);
  const row = page.locator(".tool-picker li").filter({ hasText: toolName });
  await expect(row, `expected exactly one "${toolName}" row under ${clientName} in the tool picker`).toHaveCount(1);
  await row.getByRole("checkbox").check();
}

test.describe("MCP curated bundles — /mcp-custom/:bundleName", () => {
  let page: Page;
  let request: APIRequestContext;
  let auth: AdminAuth;
  let authHeader: string;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    request = page.context().request;
    auth = await loginAs(page);

    // Both servers point at the same fixture upstream; only the discovery
    // document differs, so SERVER_B carries the extra `echo` tool the refusal
    // tests probe with.
    await registerViaApi(request, auth, SERVER_A);
    await registerViaApi(request, auth, SERVER_B, FIXTURE_OPENAPI_EXTENDED_PATH);

    // The data plane is fail-closed as soon as any auth material exists, and by
    // the time this file runs another spec has almost certainly minted a key.
    // Mint our own so the spec never depends on which.
    ({ authHeader } = await mintMcpKey(request, auth, "e2e-bundles"));

    // Start from no bundle. Unlike the servers above (whose registration
    // tolerates a 409), the bundle is created through the SPA below, and a
    // form submit against an existing name would fail — so a local re-run,
    // which meets the database the previous run left behind, has to clear it
    // first. 404 means it simply wasn't there.
    const dropped = await request.delete(`${APP_BASE_URL}/admin-api/bundles/${BUNDLE_NAME}`, {
      headers: apiHeaders(auth),
    });
    expect([200, 404], `bundle cleanup failed: ${dropped.status()}`).toContain(dropped.status());

    // A composite that chains a single real tool call. Created here but
    // deliberately NOT added to the bundle yet: composites are unreachable
    // everywhere until a bundle names them, which the tools/list test asserts.
    const composite = await request.post(`${APP_BASE_URL}/admin-api/composites`, {
      headers: apiHeaders(auth),
      data: {
        name: COMPOSITE_NAME,
        description: "e2e composite: fetch the user list through the bundle",
        inputSchema: { type: "object", properties: {} },
        steps: [{ targetClient: SERVER_A, targetTool: "list-users", argsTemplate: {} }],
      },
    });
    expect([201, 409], `composite create failed: ${composite.status()} ${await composite.text()}`).toContain(
      composite.status(),
    );
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("an admin curates a cross-client bundle through the SPA", async () => {
    await page.goto("/admin/bundles/new");

    await page.locator("#new-bundle-name").fill(BUNDLE_NAME);
    await page.locator("#new-bundle-description").fill("e2e cross-client bundle");
    await pickTool(page, SERVER_A, "list-users");
    await pickTool(page, SERVER_B, "list-users");

    // Wait on the POST itself rather than only on the redirect, so a rejected
    // create reports its status and body instead of timing out on a URL.
    const [created] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/admin-api/bundles")),
      page.locator("form.form-card button[type='submit']").click(),
    ]);
    expect(created.status(), `bundle create failed: ${await created.text()}`).toBe(201);

    // The SPA lands on the detail page, which is where an operator reads the
    // endpoint to paste into an MCP client — the same URL the rest of this
    // file then talks to.
    await expect(page).toHaveURL(new RegExp(`/admin/bundles/${BUNDLE_NAME}$`));
    await expect(page.getByText(BUNDLE_PLANE).first()).toBeVisible();

    // And the persisted membership is the cross-client pair we ticked, read
    // back from the API rather than from the form state that wrote it.
    const detail = await request.get(`${APP_BASE_URL}/admin-api/bundles/${BUNDLE_NAME}`, {
      headers: apiHeaders(auth),
    });
    expect(detail.status()).toBe(200);
    const body = (await detail.json()) as { tools: { client: string; tool: string }[]; enabled: boolean };
    expect(body.enabled).toBe(true);
    expect(body.tools.map((t) => `${t.client}__${t.tool}`).sort()).toEqual([IN_BUNDLE_A, IN_BUNDLE_B].sort());
  });

  test("tools/list advertises exactly the curated subset — nothing else from those clients", async () => {
    const init = await initMcpSession(BUNDLE_PLANE, { authHeader, clientName: CLIENT_LABEL });
    const names = await toolNamesOn(BUNDLE_PLANE, init.sessionId, authHeader);

    // `search_tools` is the gateway's own discovery meta-tool, appended by
    // mcp-server.ts to any non-empty scope when ENABLE_SEARCH_TOOL is on (the
    // default). It is not curated content, so it is set aside before the
    // exact-set comparison rather than baked into the expected list.
    const curated = names.filter((n) => n !== SEARCH_TOOL);
    expect(curated).toEqual([IN_BUNDLE_A, IN_BUNDLE_B].sort());

    // Spelled out because it is the whole point: both clients expose more
    // tools than this, and none of the rest may appear.
    expect(curated).not.toContain(OUT_OF_BUNDLE_ECHO);
    expect(curated).not.toContain(OUT_OF_BUNDLE_CREATE);
    // The composite exists in the database but no bundle names it yet.
    expect(curated).not.toContain(COMPOSITE_NAME);
  });

  test("tools/call for an out-of-bundle tool is REFUSED, even though the same client is in the bundle", async () => {
    const init = await initMcpSession(BUNDLE_PLANE, { authHeader, clientName: CLIENT_LABEL });
    const call = await mcpToolsCall(BUNDLE_PLANE, init.sessionId, OUT_OF_BUNDLE_ECHO, authHeader);

    // Refusal is an in-band MCP error result, not a transport error: the
    // session survives and the agent can recover, same as any unknown tool.
    expect(call.status).toBe(200);
    expect(call.isError).toBe(true);
    // Exact text, because the alternative outcome is not a *different* error —
    // it is a SUCCESS. `echo` is a live GET that reflects the request the
    // bridge sent upstream, so a bundle that filtered only tools/list while
    // still dispatching would return that reflection here. Matching the exact
    // refusal makes the two impossible to conflate.
    expect(call.text).toBe(`Unknown tool: ${OUT_OF_BUNDLE_ECHO}`);
    // Belt and braces: nothing from the fixture upstream came back.
    expect(call.text).not.toContain("127.0.0.1");
  });

  test("tools/call for a second out-of-bundle tool is refused before argument validation", async () => {
    const init = await initMcpSession(BUNDLE_PLANE, { authHeader, clientName: CLIENT_LABEL });
    const call = await mcpToolsCall(BUNDLE_PLANE, init.sessionId, OUT_OF_BUNDLE_CREATE, authHeader);

    expect(call.status).toBe(200);
    expect(call.isError).toBe(true);
    expect(call.text).toBe(`Unknown tool: ${OUT_OF_BUNDLE_CREATE}`);
    // `create-user` has required arguments and was called with none, so a
    // leaked dispatch would have surfaced a schema-validation message instead
    // (see mcp-protocol.spec.ts). Membership is checked first, and no argument
    // ever reaches the pipeline.
    expect(call.text).not.toMatch(/validation|argument/i);
  });

  test("a tool that IS in the bundle dispatches for real to the upstream", async () => {
    const init = await initMcpSession(BUNDLE_PLANE, { authHeader, clientName: CLIENT_LABEL });
    const call = await mcpToolsCall(BUNDLE_PLANE, init.sessionId, IN_BUNDLE_A, authHeader);

    expect(call.status).toBe(200);
    expect(call.isError).toBeFalsy();
    expect(call.text).toContain("Ada Lovelace");
  });

  test("the bundle's other client dispatches too — the filter is genuinely cross-client", async () => {
    const init = await initMcpSession(BUNDLE_PLANE, { authHeader, clientName: CLIENT_LABEL });
    const call = await mcpToolsCall(BUNDLE_PLANE, init.sessionId, IN_BUNDLE_B, authHeader);

    expect(call.status).toBe(200);
    expect(call.isError).toBeFalsy();
    expect(call.text).toContain("Ada Lovelace");
  });

  test("an unknown bundle name 404s as a bundle instead of falling through to /mcp", async () => {
    const res = await rawInitialize("/mcp-custom/e2e-bundle-does-not-exist", authHeader);

    expect(res.status).toBe(404);
    const body = JSON.parse(res.body) as { error?: { code?: string } };
    expect(body.error?.code).toBe("BUNDLE_NOT_FOUND");
    // That code is what pins the routing decision. `/mcp-custom` is mounted as
    // a sibling of `/mcp`, not underneath it; had it been nested, this request
    // would also traverse the `/mcp` control-plane chain, where rootMcpAuth
    // rejects the plain (adminRole-less) key used here with a 403 FORBIDDEN
    // long before any bundle lookup ran. A 500 or a fall-through to another
    // route would show up here too.
    //
    // No session was opened either — an unknown scope must not reserve a slot
    // against the maxSessions cap.
    expect(res.sessionId).toBeNull();
  });

  test("a bundle session replayed against a client shard is rejected", async () => {
    // Sessions are namespaced `bundle:<name>` / `client:<name>` precisely so a
    // session id cannot be carried across scopes (transports.ts's
    // confused-deputy backstop). Same 404 as an expired session — the reply
    // must not reveal that the id exists elsewhere.
    const init = await initMcpSession(BUNDLE_PLANE, { authHeader, clientName: CLIENT_LABEL });
    const replayed = await mcpCall(
      `/mcp/${SERVER_A}`,
      init.sessionId,
      { jsonrpc: "2.0", method: "tools/list", id: 3, params: {} },
      authHeader,
    );
    expect(replayed.status).toBe(404);
  });

  test("the bundle endpoint is Bearer-guarded: no Authorization is 401, a bogus key 403", async () => {
    // mcpAuth guards both data-plane endpoints identically — MCP clients are
    // programs, so there is no cookie/session path here, only Bearer. The
    // managed key minted in beforeAll guarantees the surface is fail-closed
    // regardless of what else the suite has done.
    const missing = await rawInitialize(BUNDLE_PLANE);
    expect(missing.status).toBe(401);
    expect((JSON.parse(missing.body) as { error?: { code?: string } }).error?.code).toBe("UNAUTHORIZED");

    const bogus = await rawInitialize(BUNDLE_PLANE, "Bearer mcp_definitely-not-a-real-key");
    expect(bogus.status).toBe(403);
    expect((JSON.parse(bogus.body) as { error?: { code?: string } }).error?.code).toBe("FORBIDDEN");
  });

  test("adding a composite macro to the bundle advertises it and runs it through the guard stack", async () => {
    // Runs last on purpose: it mutates the bundle, and the exact-set assertion
    // above depends on the bundle still holding only its two curated tools.
    const patched = await request.patch(`${APP_BASE_URL}/admin-api/bundles/${BUNDLE_NAME}`, {
      headers: apiHeaders(auth),
      data: { composites: [COMPOSITE_NAME] },
    });
    expect(patched.status(), `bundle patch failed: ${await patched.text()}`).toBe(200);

    const init = await initMcpSession(BUNDLE_PLANE, { authHeader, clientName: CLIENT_LABEL });
    const names = await toolNamesOn(BUNDLE_PLANE, init.sessionId, authHeader);
    expect(names.filter((n) => n !== SEARCH_TOOL)).toEqual([IN_BUNDLE_A, IN_BUNDLE_B, COMPOSITE_NAME].sort());

    // The macro's single step forwards to SERVER_A's list-users through the
    // same proxyToolCall every direct call uses, so a working composite is
    // indistinguishable from a direct dispatch in its payload.
    const call = await mcpToolsCall(BUNDLE_PLANE, init.sessionId, COMPOSITE_NAME, authHeader);
    expect(call.status).toBe(200);
    expect(call.isError).toBeFalsy();
    expect(call.text).toContain("Ada Lovelace");
  });
});
