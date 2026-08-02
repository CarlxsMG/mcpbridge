/**
 * End-to-end test for the `/mcp` CONTROL PLANE — the gateway's own management
 * surface (`sys_*` tools, src/mcp/system-tools.ts), as opposed to the two
 * data-plane shards (`/mcp/:clientName`, `/mcp-custom/:bundleName`) that proxy
 * to registered backends.
 *
 * What only an end-to-end test can prove here:
 *
 *   - **Fail-closed auth, for real.** `/mcp` is guarded by `rootMcpAuth`
 *     (src/middleware/auth.ts), which resolves the caller through
 *     `resolveSystemRole` (src/security/system-role.ts). Unlike the data
 *     plane's `mcpAuth`, there is NO "no auth material configured => allow
 *     all" fallback. The e2e stack runs with `ADMIN_API_KEYS=""` and
 *     `MCP_API_KEYS=""` (playwright.config.ts), so a managed `mcp_api_keys`
 *     row with `adminRole` set is the ONLY way in — which is exactly the
 *     configuration in which a regression to "open mode" would be invisible
 *     to a unit test that stubs the env.
 *   - **A plain managed key is not enough.** The same credential that opens
 *     the data plane must bounce off `/mcp` (403), because `resolveSystemRole`
 *     requires `rec.adminRole` to be non-null. This is the one assertion that
 *     distinguishes `rootMcpAuth` from `mcpAuth`.
 *   - **Backend tools are not reachable here.** The repo deliberately REMOVED
 *     the old "everything flattened together" aggregation from `/mcp` (see
 *     src/mcp/transports.ts's `setupTransports`). Nothing else in the suite
 *     would notice if it came back: the tool would simply start working.
 *   - **Both authorization axes.** `runSystemTool` enforces a role tier
 *     (read/operate/admin, mirroring `requireOperator`/`requireAdminRole`) AND
 *     an independent step-up gate (`checkConfirmGate` in src/proxy/gates.ts —
 *     the same one `proxyToolCall` applies to sensitive backend tools), plus
 *     an `envBearerOnly` flag that no managed key can ever satisfy.
 *
 * Every assertion below is against a REAL credential minted through the admin
 * API, not a stub, so the DB round trip (`resolveMcpKeyByToken` →
 * `adminRole`/`elevated` columns) is part of what's under test.
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { APP_BASE_URL } from "./support/env";
import { adminAuthHeaders, login, mintMcpKey, registerViaApi, revokeMcpKey, type AdminAuth } from "./support/admin";
import { closeTrackedMcpSessions, initMcpSession, mcpToolsCall, parseSseJson } from "./support/mcp";

/** The control plane. Never takes a `:clientName` — the scope IS "system". */
const CONTROL_PLANE = "/mcp";

/** Registered REST backend used as the "this exists, but not HERE" control. */
const SERVER_NAME = "e2e-ctrl-api";
/** A second backend, registered only to be destroyed through `sys_delete_client`. */
const DOOMED_SERVER_NAME = "e2e-ctrl-doomed-api";

/** Every session announces itself as this, so the bridge's logs attribute the traffic. */
const CLIENT_NAME = "e2e-control-plane";

/** What a raw (pre-JSON-RPC) POST to an MCP endpoint told us about the auth verdict. */
interface RawMcpPost {
  status: number;
  /** `error.code` from the middleware's JSON body — only present on a rejection. */
  code?: string;
  /** Set by the Streamable HTTP transport on a successful initialize. */
  sessionId: string | null;
  bodyText: string;
}

/**
 * POST an `initialize` to `path` and report only the transport-level verdict.
 *
 * `initMcpSession` throws on a non-200, which is the right behaviour for the
 * happy path but useless for the rejection cases this spec is mostly about —
 * so the auth assertions go through this instead. `authHeader: null` sends no
 * Authorization header at all, which `rootMcpAuth` distinguishes from an
 * offered-but-worthless credential (401 vs 403).
 */
async function rawMcpPost(path: string, authHeader: string | null): Promise<RawMcpPost> {
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
        clientInfo: { name: CLIENT_NAME, version: "1.0" },
      },
    }),
  });
  // Read the session-id header before draining the body — `res.text()` is a
  // one-shot stream reader (same ordering discipline as auth-fail-closed.spec.ts).
  const sessionId = res.headers.get("mcp-session-id");
  const bodyText = await res.text();
  let code: string | undefined;
  try {
    code = (JSON.parse(bodyText) as { error?: { code?: string } }).error?.code;
  } catch {
    // A 200 comes back SSE-framed, not as JSON — there is no error code to read.
  }
  return { status: res.status, code, sessionId, bodyText };
}

/**
 * `tools/list` on an established control-plane session, flattened to the
 * advertised names. Visibility is role-filtered (`listSystemTools(role)` is the
 * only place a tier decides what a caller can SEE), so the caller's key matters.
 */
async function listToolNames(sessionId: string, authHeader: string): Promise<string[]> {
  const res = await fetch(`${APP_BASE_URL}${CONTROL_PLANE}`, {
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
  const tools = (parsed.result as { tools?: { name: string }[] } | undefined)?.tools ?? [];
  return tools.map((t) => t.name);
}

/**
 * One control-plane session per credential, reused by the tests below.
 *
 * Reuse is safe here specifically because auth is never bound to the session:
 * `rootMcpAuth` is mounted with `app.use` and so re-runs on EVERY request, and
 * `resolveSystemRole` is re-derived per JSON-RPC call inside mcp-server.ts's
 * system-scope handlers — a session therefore cannot outlive, or launder, the
 * credential that opened it. Worth doing because `config.maxSessions` (100) is
 * a whole-process budget shared with every other spec in the suite, and an
 * opened session holds its slot for SESSION_TTL_MS (30 min).
 */
const sessionByAuth = new Map<string, string>();

async function controlSession(authHeader: string): Promise<string> {
  const cached = sessionByAuth.get(authHeader);
  if (cached) return cached;
  const { sessionId } = await initMcpSession(CONTROL_PLANE, { authHeader, clientName: CLIENT_NAME });
  sessionByAuth.set(authHeader, sessionId);
  return sessionId;
}

/** One `sys_*` call — the shape most assertions below need. */
async function callSystemTool(
  authHeader: string,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<{ status: number; isError?: boolean; text?: string }> {
  const sessionId = await controlSession(authHeader);
  return mcpToolsCall(CONTROL_PLANE, sessionId, toolName, authHeader, args);
}

test.describe("MCP control plane (/mcp) — fail-closed auth, role tiers, and step-up", () => {
  let page: Page;
  let request: APIRequestContext;
  let auth: AdminAuth;

  /** adminRole: null — opens the data plane, must NOT open the control plane. */
  let plainKey: { id: number; authHeader: string };
  /** adminRole: "viewer" — the read floor (ROLE_RANK viewer/auditor both = 0). */
  let viewerKey: { id: number; authHeader: string };
  /** adminRole: "operator" — read + operate, but NOT elevated (the confirm gate applies). */
  let operatorKey: { id: number; authHeader: string };
  /** adminRole: "admin" AND elevated — every tier, and skips the confirm gate. */
  let adminElevatedKey: { id: number; authHeader: string };
  /** A throwaway plain key that exists only to be revoked through `sys_revoke_key`. */
  let victimKey: { id: number; authHeader: string };

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    request = page.context().request;
    await login(page);
    auth = await adminAuthHeaders(page);

    // Two backends registered through the admin API (the register FORM is
    // smoke.spec.ts's subject, not this one). Both tolerate the 409 a re-run
    // against a reused server produces.
    await registerViaApi(request, auth, SERVER_NAME);
    await registerViaApi(request, auth, DOOMED_SERVER_NAME);

    // Minting `adminRole`/`elevated` requires a super-admin caller (see
    // routes/mcp-keys.ts) — the bootstrap admin is exactly that (admin role,
    // no team), which is who `login()` signs in as.
    plainKey = await mintMcpKey(request, auth, "e2e-ctrl-plain");
    viewerKey = await mintMcpKey(request, auth, "e2e-ctrl-viewer", { adminRole: "viewer" });
    operatorKey = await mintMcpKey(request, auth, "e2e-ctrl-operator", { adminRole: "operator" });
    adminElevatedKey = await mintMcpKey(request, auth, "e2e-ctrl-admin-elevated", {
      adminRole: "admin",
      elevated: true,
    });
    victimKey = await mintMcpKey(request, auth, "e2e-ctrl-victim");
  });

  test.afterAll(async () => {
    // Hand the session slots back to the process-wide `maxSessions` budget
    // instead of letting them idle out over SESSION_TTL_MS. This spec used to
    // walk `sessionByAuth` and DELETE each one by hand; the shared helper does
    // exactly that for every session `initMcpSession` opened, including the
    // ones this spec establishes outside that map.
    await closeTrackedMcpSessions();

    // Don't leave control-plane-capable credentials live for the rest of the
    // suite. `victimKey` is deliberately absent — the step-up test revokes it,
    // and revoking twice is an error the helper would fail on.
    for (const key of [plainKey, viewerKey, operatorKey, adminElevatedKey]) {
      if (key) await revokeMcpKey(request, auth, key.id);
    }
    await page.close();
  });

  // ── (1) Fail-closed with no credential ────────────────────────────────────

  test("no Authorization header is rejected 401 UNAUTHORIZED (no open-mode fallback)", async () => {
    const res = await rawMcpPost(CONTROL_PLANE, null);
    expect(res.status, `body: ${res.bodyText}`).toBe(401);
    expect(res.code).toBe("UNAUTHORIZED");
    // Nothing was established — a rejected request never reaches the transport.
    expect(res.sessionId).toBeNull();
  });

  test("a bogus Bearer is rejected 403 FORBIDDEN (credential offered, no system role)", async () => {
    // 403 rather than 401 is load-bearing: `rootMcpAuth` distinguishes "no
    // credential offered" from "offered and worthless" by checking for the
    // `Bearer ` prefix, not for a truthy token.
    const res = await rawMcpPost(CONTROL_PLANE, "Bearer mcp_definitely-not-a-real-key");
    expect(res.status, `body: ${res.bodyText}`).toBe(403);
    expect(res.code).toBe("FORBIDDEN");
  });

  // ── (2) The distinguishing assertion: a plain managed key is not enough ───

  test("a managed key with adminRole:null opens the DATA plane but is refused on /mcp", async () => {
    // Positive control first — the exact same credential works on the data
    // plane, so the control-plane rejection below is about the system-role
    // requirement and not about a broken/expired key.
    const dataPlane = await rawMcpPost(`/mcp/${SERVER_NAME}`, plainKey.authHeader);
    expect(dataPlane.status, `body: ${dataPlane.bodyText}`).toBe(200);
    expect(dataPlane.sessionId).toBeTruthy();

    // …and is rejected outright on the control plane. `resolveSystemRole`
    // returns null for a key whose `adminRole` column is null, which
    // `rootMcpAuth` turns into a 403 (a credential WAS offered).
    const controlPlane = await rawMcpPost(CONTROL_PLANE, plainKey.authHeader);
    expect(controlPlane.status, `body: ${controlPlane.bodyText}`).toBe(403);
    expect(controlPlane.code).toBe("FORBIDDEN");
    expect(controlPlane.sessionId).toBeNull();
  });

  // ── (3) A managed key WITH adminRole gets in ──────────────────────────────

  test("an adminRole key completes the handshake and tools/list advertises sys_* tools", async () => {
    // Deliberately NOT the cached `controlSession` — the handshake itself is
    // what this test is asserting on, so it has to perform a real one.
    const init = await initMcpSession(CONTROL_PLANE, {
      authHeader: adminElevatedKey.authHeader,
      clientName: CLIENT_NAME,
    });
    expect(init.sessionId).toBeTruthy();
    expect(init.serverInfo.name).toBeTruthy();

    const names = await listToolNames(init.sessionId, adminElevatedKey.authHeader);
    // An admin-tier caller sees the whole catalog — one representative per tier.
    expect(names).toContain("sys_list_clients"); // read
    expect(names).toContain("sys_set_client_enabled"); // operate
    expect(names).toContain("sys_mint_key"); // admin
  });

  // ── (4) Backend tools are NOT reachable on the control plane ──────────────

  test("a registered backend's client__tool is not advertised on /mcp", async () => {
    const sessionId = await controlSession(adminElevatedKey.authHeader);
    const names = await listToolNames(sessionId, adminElevatedKey.authHeader);

    expect(names).not.toContain(`${SERVER_NAME}__list-users`);
    // Stronger than the exact-name check: `__` is THE client/tool separator
    // (and registration rejects it inside a client or tool name), so its total
    // absence proves no backend identity leaked into this catalog at all —
    // which is what a reintroduced "everything flattened together" aggregation
    // would break, whatever the client happened to be called.
    expect(names.filter((n) => n.includes("__"))).toEqual([]);
  });

  test("a registered backend's tool cannot be CALLED on /mcp, but works on its own shard", async () => {
    const toolName = `${SERVER_NAME}__list-users`;

    // On the control plane the name is not in `SYSTEM_TOOLS`, so `runSystemTool`
    // reports it as unknown — an isError result, not a transport error, and
    // emphatically not a proxied call to the backend.
    const onControlPlane = await callSystemTool(adminElevatedKey.authHeader, toolName);
    expect(onControlPlane.status).toBe(200);
    expect(onControlPlane.isError).toBe(true);
    expect(onControlPlane.text).toContain(`Unknown tool: ${toolName}`);

    // The tool itself is perfectly callable — on the shard that owns it. Without
    // this half, the assertion above would also pass if discovery had simply
    // failed to register the tool anywhere.
    const dataPlane = `/mcp/${SERVER_NAME}`;
    const sessionId = (await initMcpSession(dataPlane, { authHeader: plainKey.authHeader, clientName: CLIENT_NAME }))
      .sessionId;
    const onDataPlane = await mcpToolsCall(dataPlane, sessionId, toolName, plainKey.authHeader);
    expect(onDataPlane.status).toBe(200);
    expect(onDataPlane.isError).toBeFalsy();
    expect(onDataPlane.text).toContain("Ada Lovelace");
  });

  // ── (5) Role tiers are enforced ───────────────────────────────────────────

  test("a viewer-role key may call a read-tier tool but is refused an operate-tier one", async () => {
    const readTier = await callSystemTool(viewerKey.authHeader, "sys_metrics");
    expect(readTier.status).toBe(200);
    expect(readTier.isError, `sys_metrics rejected a viewer: ${readTier.text}`).toBeFalsy();

    // `sys_set_client_enabled` is tier "operate" and NOT sensitive, so the tier
    // check is the only thing that can reject this call.
    const operateTier = await callSystemTool(viewerKey.authHeader, "sys_set_client_enabled", {
      name: SERVER_NAME,
      enabled: true,
    });
    expect(operateTier.status).toBe(200);
    expect(operateTier.isError).toBe(true);
    expect(operateTier.text).toContain("requires the 'operate' tier or higher");
  });

  test("the viewer's tools/list hides everything above the read tier", async () => {
    // Tier is the only thing in this codebase that decides tools/list
    // VISIBILITY (listSystemTools), so an under-privileged caller shouldn't
    // even learn the names/schemas of what it can't call.
    const sessionId = await controlSession(viewerKey.authHeader);
    const names = await listToolNames(sessionId, viewerKey.authHeader);

    expect(names).toContain("sys_list_clients");
    expect(names).toContain("sys_audit_tail");
    expect(names).not.toContain("sys_set_client_enabled"); // operate
    expect(names).not.toContain("sys_delete_client"); // operate
    expect(names).not.toContain("sys_revoke_key"); // admin
    expect(names).not.toContain("sys_mint_key"); // admin
  });

  test("an operator-role key may call the operate tier but is refused an admin-tier tool", async () => {
    // Re-enabling an already-enabled client is a no-op that still exercises the
    // whole operate-tier path (the UPDATE matches its row), so this positive
    // control can't disturb any other spec's fixture.
    const operateTier = await callSystemTool(operatorKey.authHeader, "sys_set_client_enabled", {
      name: SERVER_NAME,
      enabled: true,
    });
    expect(operateTier.status).toBe(200);
    expect(operateTier.isError, `sys_set_client_enabled rejected an operator: ${operateTier.text}`).toBeFalsy();
    expect(operateTier.text).toContain("enabled");

    // `sys_revoke_key` is tier "admin" AND sensitive; `runSystemTool` checks the
    // tier BEFORE the confirm gate, so passing __confirm here leaves the tier as
    // the only possible reason for the rejection.
    const adminTier = await callSystemTool(operatorKey.authHeader, "sys_revoke_key", {
      id: victimKey.id,
      __confirm: true,
    });
    expect(adminTier.status).toBe(200);
    expect(adminTier.isError).toBe(true);
    expect(adminTier.text).toContain("requires the 'admin' tier or higher");
  });

  test("no managed key, however privileged, may mint another (envBearerOnly)", async () => {
    // `sys_mint_key` is the one tool flagged `envBearerOnly` — it demands the
    // literal env admin Bearer, which the e2e stack deliberately does not
    // configure (ADMIN_API_KEYS=""). An admin-role, elevated key clears both
    // the tier check and the confirm gate and still cannot self-escalate.
    const res = await callSystemTool(adminElevatedKey.authHeader, "sys_mint_key", {
      label: "e2e-ctrl-should-never-exist",
      __confirm: true,
    });
    expect(res.status).toBe(200);
    expect(res.isError).toBe(true);
    expect(res.text).toContain("requires the environment admin Bearer credential");
  });

  // ── (6) Step-up confirmation ──────────────────────────────────────────────

  test("a sensitive tool is refused without step-up — and the side effect does not happen", async () => {
    // `sys_delete_client` is tier "operate" + sensitive:true. The operator key
    // clears the tier but is NOT elevated, so `checkConfirmGate` stops it.
    const refused = await callSystemTool(operatorKey.authHeader, "sys_delete_client", { name: DOOMED_SERVER_NAME });
    expect(refused.status).toBe(200);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("is sensitive");
    expect(refused.text).toContain("__confirm");

    // The gate runs before the handler, so the client must still be there —
    // asserting on the error message alone would not catch a gate that rejects
    // AFTER doing the work.
    const stillThere = await callSystemTool(operatorKey.authHeader, "sys_get_client", { name: DOOMED_SERVER_NAME });
    expect(stillThere.isError, `client was deleted despite the refused call: ${stillThere.text}`).toBeFalsy();
    expect(stillThere.text).toContain(DOOMED_SERVER_NAME);
  });

  test('the same sensitive tool succeeds with {"__confirm": true}', async () => {
    const confirmed = await callSystemTool(operatorKey.authHeader, "sys_delete_client", {
      name: DOOMED_SERVER_NAME,
      __confirm: true,
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.isError, `confirmed delete failed: ${confirmed.text}`).toBeFalsy();
    expect(confirmed.text).toContain("deleted");

    // The delete really happened — the registry no longer knows the client.
    const gone = await callSystemTool(operatorKey.authHeader, "sys_get_client", { name: DOOMED_SERVER_NAME });
    expect(gone.isError).toBe(true);
    expect(gone.text).toContain("Client not found");
  });

  test("an elevated credential satisfies the step-up gate without __confirm", async () => {
    // The other half of `checkConfirmGate`: `confirmed || elevated`. The admin
    // key is elevated, so a sensitive admin-tier tool goes through with no
    // __confirm argument at all.
    const revoked = await callSystemTool(adminElevatedKey.authHeader, "sys_revoke_key", { id: victimKey.id });
    expect(revoked.status).toBe(200);
    expect(revoked.isError, `elevated revoke was gated: ${revoked.text}`).toBeFalsy();
    expect(revoked.text).toContain(`API key ${victimKey.id} revoked`);

    // Revocation is real: the key it just burned no longer opens the data plane.
    const afterRevoke = await rawMcpPost(`/mcp/${SERVER_NAME}`, victimKey.authHeader);
    expect(afterRevoke.status).toBe(403);
  });

  // ── (7) A read-tier tool returns live registry data, not a stub ───────────

  test("sys_list_clients reports a client this spec actually registered", async () => {
    // `q` is a name-substring filter (SQL LIKE) — without it the read model's
    // default page size (50) could push this client off the first page once the
    // suite has registered enough fixtures.
    const res = await callSystemTool(viewerKey.authHeader, "sys_list_clients", { q: SERVER_NAME });
    expect(res.status).toBe(200);
    expect(res.isError, `sys_list_clients failed: ${res.text}`).toBeFalsy();

    const payload = JSON.parse(res.text ?? "{}") as { items?: { name: string; toolsCount?: number; live?: boolean }[] };
    const found = payload.items?.find((c) => c.name === SERVER_NAME);
    expect(found, `sys_list_clients did not return ${SERVER_NAME}: ${res.text}`).toBeDefined();
    // Discovery ran against the OpenAPI fixture, so the row carries real tools,
    // and `live` is computed from the in-memory registry map — proof this is the
    // live read model wired to the registry, not a canned response.
    expect(found?.toolsCount).toBeGreaterThan(0);
    expect(found?.live).toBe(true);
  });
});
