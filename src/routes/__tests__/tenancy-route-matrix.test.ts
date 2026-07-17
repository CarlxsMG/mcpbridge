/**
 * STRUCTURAL tenancy regression test (finding #21).
 *
 * Tenancy scoping in this repo is enforced per-route (each handler calls
 * `callerTeamId`/`ensureClientAccess`/… itself — see src/middleware/authz.ts),
 * never structurally. That has let an unscoped `/admin-api/*` route ship more
 * than once (the many *-tenancy.test.ts files in this directory each closed one
 * such hole after the fact). This test is the backstop that makes the NEXT one
 * fail by default: it enumerates every registered GET route under `/admin-api`
 * from the real `createApp()` wiring and asserts each one is explicitly
 * classified as either
 *
 *   - GLOBAL   — intentionally readable across tenants (platform config, the
 *                caller's own self-info, a super-admin-only surface, an
 *                aggregate counter, or a resource that carries no team_id),
 *                each with a written reason; or
 *   - SCOPED   — returns tenant-owned rows and is team-scoped, with a note of
 *                the scoping mechanism.
 *
 * A brand-new GET route is on NEITHER list, so this test fails until its author
 * consciously files it under one — and if they file it under SCOPED, the
 * dedicated behavioural checks at the bottom (plus this file's siblings) are
 * where the actual "a team viewer can't read another team's row" proof lives.
 *
 * When you add/rename/remove a GET `/admin-api` route, update the matching list
 * below. A stale entry (listed but no longer registered) also fails, so the
 * catalogue can't rot.
 *
 * NOTE: the enumerator walks Express 5 router internals (`app.router.stack`,
 * `layer.matchers`, `layer.route.methods`). If a future Express bump changes
 * that shape the floor assertion (`finds a realistic number of routes`) fails
 * loudly rather than silently discovering nothing.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { requestIdMiddleware } from "../../middleware/request-id.js";
import { createApp } from "../../server.js";
import { registry } from "../../mcp/registry.js";
import { setToolTags } from "../../tool-meta/tool-tags.js";
import { setMonitor } from "../../observability/monitor.js";
import { recordUsage, __clearUsageForTesting } from "../../observability/usage.js";
import { createUser } from "../../security/user-store.js";
import { createSession } from "../../security/session-store.js";
import { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } from "../../security/cookies.js";
import { createTeam, setUserTeam, setClientTeam } from "../../admin/entities/teams.js";

const ADMIN_KEY = "test-admin-key-tenancy-matrix";

// ─── Route enumeration (Express 5 router-stack introspection) ────────────────

const ADMIN_PREFIX = "/admin-api";

interface ExpressRoute {
  path: string;
  methods: Record<string, boolean>;
}
interface ExpressLayer {
  route?: ExpressRoute;
  name?: string;
  handle?: { stack?: ExpressLayer[] };
  matchers?: Array<(p: string) => { path?: string } | null | false>;
}

/** Runs a mounted router layer's path-to-regexp matcher and returns the prefix it consumed. */
function consumedPrefix(layer: ExpressLayer, probe: string): string | null {
  const m = layer.matchers?.[0];
  if (typeof m !== "function") return null;
  try {
    const r = m(probe);
    return r ? (r.path ?? null) : null;
  } catch {
    return null;
  }
}

function methodsOf(route: ExpressRoute): string[] {
  return Object.keys(route.methods).filter((k) => route.methods[k]);
}

/**
 * Collects every leaf route reachable through a chain of `/`-mounted
 * sub-routers (how `adminRoutes` composes its per-area routers). Each leaf's
 * `route.path` already carries its full sub-path relative to `/admin-api`.
 */
function collectUnderAdmin(stack: ExpressLayer[], out: Array<{ method: string; path: string }>): void {
  for (const l of stack) {
    if (l.route) {
      for (const method of methodsOf(l.route))
        out.push({ method: method.toUpperCase(), path: ADMIN_PREFIX + l.route.path });
    } else if (l.handle?.stack) {
      collectUnderAdmin(l.handle.stack, out);
    }
  }
}

/** Enumerates every distinct `GET /admin-api/*` route the real app wires up. */
function enumerateAdminGetRoutes(app: express.Express): string[] {
  const rootStack = (app as unknown as { router: { stack: ExpressLayer[] } }).router.stack;
  const found: Array<{ method: string; path: string }> = [];
  for (const layer of rootStack) {
    if (layer.route) {
      // Routes registered directly on the app carry an absolute path.
      if (layer.route.path.startsWith(ADMIN_PREFIX)) {
        for (const method of methodsOf(layer.route))
          found.push({ method: method.toUpperCase(), path: layer.route.path });
      }
    } else if (layer.handle?.stack && consumedPrefix(layer, `${ADMIN_PREFIX}/__probe__`) === ADMIN_PREFIX) {
      collectUnderAdmin(layer.handle.stack, found);
    }
  }
  return [...new Set(found.filter((r) => r.method === "GET").map((r) => r.path))].sort();
}

// ─── The classification (this IS the allowlist finding #21 asks for) ─────────
//
// Every GET /admin-api route must appear in exactly one of the two maps below.

/** Intentionally cross-tenant readable — each with the reason it's safe to be. */
const GLOBAL_GET_ROUTES: Record<string, string> = {
  "/admin-api/alerts":
    "alert_rules is gateway-wide alerting config (no team_id); read is operator+, mutate super-admin",
  "/admin-api/audit-log/actions":
    "distinct action-name vocabulary for the UI filter dropdown — a fixed taxonomy, not tenant rows",
  "/admin-api/audit-log/verify":
    "hash-chain integrity check over the whole audit log — returns a status, not tenant rows",
  "/admin-api/auth/me": "the caller's OWN auth context (self)",
  "/admin-api/auth/oidc/callback": "public SSO callback (browser navigation)",
  "/admin-api/auth/oidc/config": "public SSO config (drives the login button)",
  "/admin-api/auth/oidc/settings": "platform SSO settings — super-admin only (requireSuperAdmin)",
  "/admin-api/auth/oidc/start": "public SSO start redirect",
  "/admin-api/auth/sessions": "the caller's OWN active sessions (self)",
  "/admin-api/bundles":
    "bundles are deliberately global cross-client curation (no team_id); read open, mutate super-admin to close the existence-oracle — see routes/bundles.ts",
  "/admin-api/bundles/:name": "bundle detail — same global-by-design rationale as GET /bundles",
  "/admin-api/bundles/:name/install-links": "install links for a (global) bundle; bundles carry no tenancy",
  "/admin-api/catalog": "single shared marketplace (no team_id); read open, mutate super-admin — see routes/catalog.ts",
  "/admin-api/composites":
    "composites are global cross-client macros (no team_id); read open, mutate super-admin (existence-oracle parity with bundles)",
  "/admin-api/composites/:name": "composite detail — same global-by-design rationale as GET /composites",
  "/admin-api/config/export": "whole-gateway config export — super-admin only (requireSuperAdmin)",
  "/admin-api/config/snapshots": "whole-gateway config snapshots — super-admin only",
  "/admin-api/config/snapshots/:id": "whole-gateway config snapshot detail — super-admin only",
  "/admin-api/config/snapshots/:id/diff": "whole-gateway config snapshot diff — super-admin only",
  "/admin-api/connect/gateway-url": "returns the configured gateway public URL — a global config value, no tenant data",
  "/admin-api/overview":
    "gateway-wide aggregate counters (client/tool/breaker/cache totals + admin-user count) — aggregate numbers only, no per-tenant rows or names",
  "/admin-api/policies":
    "guard_policies are global reusable guard templates (no team_id); application to tools is tenancy-checked at apply-time",
  "/admin-api/teams":
    "team roster is tenancy-structure metadata; any admin may read the list, mutations are super-admin",
  "/admin-api/teams/:id": "team detail — same tenancy-metadata rationale as GET /teams",
  "/admin-api/users": "admin-user roster — super-admin only (requireSuperAdmin)",
  "/admin-api/ws-proxy-targets":
    "ws_proxy_targets are gateway-level infrastructure (no team_id, not clients) — see routes/ws-proxy-admin.ts",
  "/admin-api/ws-proxy-targets/:name": "ws-proxy target detail — same gateway-infra rationale as the list",
};

/** Returns tenant-owned rows and is team-scoped — with the mechanism that scopes it. */
const SCOPED_GET_ROUTES: Record<string, string> = {
  "/admin-api/approvals": "listApprovals(status, teamId) — approvals/approvals.ts",
  "/admin-api/audit-log": "listAuditLog({ teamId }) — admin/audit-log.ts",
  "/admin-api/audit-log/export": "exportAuditLog({ teamId }) — admin/audit-log.ts",
  "/admin-api/clients": "registry.listClientsSummary({ teamId }) — admin/clients.ts",
  "/admin-api/clients/:name": "ensureClientAccess — admin/clients.ts",
  "/admin-api/clients/:name/canary": "ensureClientAccess — admin/canary.ts",
  "/admin-api/clients/:name/lb": "ensureClientAccess — admin/lb.ts",
  "/admin-api/clients/:name/oauth": "ensureClientAccess — admin/oauth.ts",
  "/admin-api/clients/:name/tools/:tool/examples": "ensureClientAccess — admin/tools.ts",
  "/admin-api/clients/:name/upstream-auth": "ensureClientAccess — upstream-auth.ts",
  "/admin-api/consumers": "listConsumers({ teamId }) — consumers.ts",
  "/admin-api/consumers/:id/usage": "ensureConsumerAccess — consumers.ts",
  "/admin-api/mcp-keys": "keyVisibleToCaller filter — mcp-keys.ts",
  "/admin-api/mcp-keys/:id": "keyVisibleToCaller — mcp-keys.ts",
  "/admin-api/monitors": "listMonitors(teamId) — admin/monitors.ts",
  "/admin-api/schedules": "listSchedules({ teamId }) — schedules.ts",
  "/admin-api/tags": "team-scoped tag aggregation — tags.ts (routes-tags-tenancy.test.ts)",
  "/admin-api/tags/:tag/tools": "team-scoped tools-by-tag — tags.ts",
  "/admin-api/tools": "registry.listAllTools(teamId) — bundles.ts (the bundle tool-picker)",
  "/admin-api/traces": "listTraces({ teamId }) — traces.ts",
  "/admin-api/traces/:traceId": "getTrace(traceId, teamId) — traces.ts",
  "/admin-api/traces/top-sessions": "getTopSessions(limit, teamId) — traces.ts",
  "/admin-api/traffic": "team-scoped traffic listing — admin/traffic.ts",
  "/admin-api/traffic/:id": "ensureClientAccess on the record's client — admin/traffic.ts",
  "/admin-api/usage/by-key": "getUsageByKey({ teamId }) — usage.ts",
  "/admin-api/usage/summary": "getUsageSummary({ teamId }) + ensureClientAccess on ?client — usage.ts",
  "/admin-api/usage/timeseries": "getUsageTimeseries({ teamId }) — usage.ts",
  "/admin-api/usage/top-tools": "getTopTools({ teamId }) — usage.ts",
};

describe("structural tenancy matrix — every GET /admin-api route is classified", () => {
  let discovered: string[] = [];

  beforeEach(() => {
    __resetDbForTesting();
    (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
    (config as Record<string, unknown>).authDisabled = false;
    const { app } = createApp();
    discovered = enumerateAdminGetRoutes(app);
  });

  test("the enumerator finds a realistic number of routes (walker still works)", () => {
    // A broken introspection walk (e.g. after an Express bump) would silently
    // find nothing and make the completeness checks vacuous — guard against it.
    expect(discovered.length).toBeGreaterThanOrEqual(40);
  });

  test("no GET /admin-api route is unclassified (a NEW route fails here by default)", () => {
    const classified = new Set([...Object.keys(GLOBAL_GET_ROUTES), ...Object.keys(SCOPED_GET_ROUTES)]);
    const unclassified = discovered.filter((p) => !classified.has(p));
    expect(
      unclassified,
      `Unclassified GET /admin-api route(s): ${unclassified.join(", ")}.\n` +
        "Add each to GLOBAL_GET_ROUTES (with the reason it's safe to read across tenants) " +
        "or to SCOPED_GET_ROUTES (with its team-scoping mechanism), and — if scoped — add a " +
        "cross-team read test proving a team viewer can't see another team's row.",
    ).toEqual([]);
  });

  test("no classification entry is stale (every listed path is still a real route)", () => {
    const live = new Set(discovered);
    const stale = [...Object.keys(GLOBAL_GET_ROUTES), ...Object.keys(SCOPED_GET_ROUTES)].filter((p) => !live.has(p));
    expect(stale, `Listed but no longer registered — remove from the matrix: ${stale.join(", ")}`).toEqual([]);
  });

  test("GLOBAL and SCOPED are disjoint (a route is exactly one kind)", () => {
    const both = Object.keys(GLOBAL_GET_ROUTES).filter((p) => p in SCOPED_GET_ROUTES);
    expect(both, `Route(s) in both GLOBAL and SCOPED: ${both.join(", ")}`).toEqual([]);
  });

  test("every GLOBAL/SCOPED entry carries a non-empty reason", () => {
    const empty = [...Object.entries(GLOBAL_GET_ROUTES), ...Object.entries(SCOPED_GET_ROUTES)]
      .filter(([, reason]) => reason.trim().length === 0)
      .map(([path]) => path);
    expect(empty, `Entries missing a reason: ${empty.join(", ")}`).toEqual([]);
  });
});

// ─── Behavioural proof: scoped list endpoints exclude another team's rows ────
//
// The catalogue above forces classification; these checks prove the SCOPED
// half is real — a team-scoped viewer sees only its own team's rows, while a
// super-admin (bearer) sees every team's. A representative set of the seedable
// collection endpoints stands in for the mechanism; each single-client detail
// route (`/clients/:name/*`) is covered by its own *-tenancy.test.ts sibling.

let baseUrl = "";
let activeServer: Server | null = null;

async function startScopedApp(): Promise<void> {
  __resetDbForTesting();
  __clearUsageForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;

  // Only the routers whose GET list endpoints we exercise below — mounting the
  // whole app (createApp) would also pull in MCP transports + the global rate
  // limiter, neither of which this behavioural slice needs.
  const { adminRoutes } = await import("../../routes/admin.js");
  const { bundleRoutes } = await import("../../routes/bundles.js");
  const { tagRoutes } = await import("../../routes/tags.js");
  const { usageRoutes } = await import("../../routes/usage.js");
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  adminRoutes(app); // /clients, /monitors
  bundleRoutes(app); // /tools
  tagRoutes(app); // /tags
  usageRoutes(app); // /usage/summary

  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      activeServer = srv;
      baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
      resolve();
    });
    srv.on("error", reject);
  });
}

function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_KEY}` };
}

async function reg(name: string): Promise<void> {
  await registry.register(
    name,
    [{ name: "t", method: "GET", endpoint: "/t", description: "d", inputSchema: { type: "object", properties: {} } }],
    "http://example.com/health",
    "1.2.3.4",
    "http://example.com",
    "1.2.3.4",
  );
}

/** A viewer session bound to a fresh team (i.e. NOT a super-admin). */
function teamViewerHeaders(username: string): { headers: Record<string, string>; teamId: number } {
  const team = createTeam(`team-${username}`, "test");
  if (typeof team === "string") throw new Error(`createTeam failed: ${team}`);
  const user = createUser(username, "irrelevant-hash", "viewer", null);
  setUserTeam(user.username, team.id);
  const session = createSession(user.id, "127.0.0.1", "test-agent");
  return {
    teamId: team.id,
    headers: {
      Cookie: `${SESSION_COOKIE_NAME}=${session.token}; ${CSRF_COOKIE_NAME}=${session.csrfToken}`,
      "X-CSRF-Token": session.csrfToken,
    },
  };
}

/**
 * Registers svc-a (owned by the caller's team) + svc-b (another team), plus
 * whatever per-endpoint fixtures each check needs (tags, monitors, usage).
 */
async function seedTwoTeams(): Promise<{ headers: Record<string, string> }> {
  await reg("svc-a");
  await reg("svc-b");
  const { headers, teamId } = teamViewerHeaders("matrix-viewer");
  const otherTeam = createTeam("matrix-other-team", "test");
  if (typeof otherTeam === "string") throw new Error("createTeam failed");
  setClientTeam("svc-a", teamId);
  setClientTeam("svc-b", otherTeam.id);

  setToolTags("svc-a", "t", ["alpha"]);
  setToolTags("svc-b", "t", ["beta"]);
  expect(await setMonitor("svc-a", "t", { exampleId: 1, intervalMinutes: 5, enabled: true })).toEqual({ ok: true });
  expect(await setMonitor("svc-b", "t", { exampleId: 1, intervalMinutes: 5, enabled: true })).toEqual({ ok: true });
  recordUsage({ clientName: "svc-a", toolName: "t", keyId: null, statusClass: "2xx", isError: false, durationMs: 10 });
  recordUsage({ clientName: "svc-b", toolName: "t", keyId: null, statusClass: "2xx", isError: false, durationMs: 10 });
  recordUsage({ clientName: "svc-b", toolName: "t", keyId: null, statusClass: "2xx", isError: false, durationMs: 10 });
  return { headers };
}

describe("structural tenancy matrix — scoped list endpoints exclude another team's rows", () => {
  beforeEach(() => {
    __resetDbForTesting();
    __clearUsageForTesting();
  });

  afterEach(async () => {
    for (const c of registry.listClients()) await registry.unregister(c.name);
    __clearUsageForTesting();
    await new Promise<void>((resolve) => {
      if (activeServer)
        activeServer.close(() => {
          activeServer = null;
          resolve();
        });
      else resolve();
    });
  });

  test("GET /clients — a team viewer sees only its own team's clients", async () => {
    await startScopedApp();
    const { headers } = await seedTwoTeams();

    const scoped = await fetch(`${baseUrl}/admin-api/clients`, { headers });
    expect(scoped.status).toBe(200);
    const scopedBody = (await scoped.json()) as { items: { name: string }[] };
    expect(scopedBody.items.map((c) => c.name)).toEqual(["svc-a"]);

    const all = await fetch(`${baseUrl}/admin-api/clients`, { headers: bearer() });
    const allBody = (await all.json()) as { items: { name: string }[] };
    expect(allBody.items.map((c) => c.name).sort()).toEqual(["svc-a", "svc-b"]);
  });

  test("GET /tools — a team viewer's tool picker excludes another team's tools", async () => {
    await startScopedApp();
    const { headers } = await seedTwoTeams();

    const scoped = await fetch(`${baseUrl}/admin-api/tools`, { headers });
    expect(scoped.status).toBe(200);
    const scopedBody = (await scoped.json()) as { items: { client: string }[] };
    expect(scopedBody.items.map((i) => i.client)).toEqual(["svc-a"]);

    const all = await fetch(`${baseUrl}/admin-api/tools`, { headers: bearer() });
    const allBody = (await all.json()) as { items: { client: string }[] };
    expect(allBody.items.map((i) => i.client).sort()).toEqual(["svc-a", "svc-b"]);
  });

  test("GET /tags — a team viewer sees only its own team's tags", async () => {
    await startScopedApp();
    const { headers } = await seedTwoTeams();

    const scoped = await fetch(`${baseUrl}/admin-api/tags`, { headers });
    expect(scoped.status).toBe(200);
    const scopedBody = (await scoped.json()) as { items: { tag: string }[] };
    expect(scopedBody.items.map((i) => i.tag)).toEqual(["alpha"]);

    const all = await fetch(`${baseUrl}/admin-api/tags`, { headers: bearer() });
    const allBody = (await all.json()) as { items: { tag: string }[] };
    expect(allBody.items.map((i) => i.tag).sort()).toEqual(["alpha", "beta"]);
  });

  test("GET /monitors — a team viewer sees only its own team's monitors", async () => {
    await startScopedApp();
    const { headers } = await seedTwoTeams();

    const scoped = await fetch(`${baseUrl}/admin-api/monitors`, { headers });
    expect(scoped.status).toBe(200);
    const scopedBody = (await scoped.json()) as { items: { clientName: string }[] };
    expect(scopedBody.items.map((m) => m.clientName)).toEqual(["svc-a"]);

    const all = await fetch(`${baseUrl}/admin-api/monitors`, { headers: bearer() });
    const allBody = (await all.json()) as { items: { clientName: string }[] };
    expect(allBody.items.map((m) => m.clientName).sort()).toEqual(["svc-a", "svc-b"]);
  });

  test("GET /usage/summary — a team viewer's totals exclude another team's calls", async () => {
    await startScopedApp();
    const { headers } = await seedTwoTeams();

    const scoped = await fetch(`${baseUrl}/admin-api/usage/summary`, { headers });
    expect(scoped.status).toBe(200);
    const scopedBody = (await scoped.json()) as { calls: number };
    expect(scopedBody.calls).toBe(1);

    const all = await fetch(`${baseUrl}/admin-api/usage/summary`, { headers: bearer() });
    const allBody = (await all.json()) as { calls: number };
    expect(allBody.calls).toBe(3);
  });
});
