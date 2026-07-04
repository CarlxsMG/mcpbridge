// ─────────────────────────────────────────────────────────────────────────────
// DEMO MODE — in-browser mock of the /admin-api/* + /register backend.
//
// Loaded ONLY when built with VITE_DEMO=true (see useApi.ts — dynamic import in a
// statically-false branch, so this file is tree-shaken out of the real product
// build). Powers the public "try it" demo on GitHub Pages with realistic, mutable
// fixture data — no server, no persistence beyond the current tab.
//
// Fixture data (the arrays/objects route() reads and mutates, plus the pure
// data-shaping helpers that derive from them) lives under ./fixtures/, one
// module per domain — see that folder for the actual mock data. This file is
// just the router: every fixture is imported back in by name and used exactly
// as if it were declared here, since ES module bindings are live singletons
// (route handlers still push/splice/assign onto the very same array/object
// instances the fixture modules export). What must stay physically in THIS
// file's source text is every path-equality check and every anchored,
// caret-prefixed path-matching regex literal below — demo-contract.test.ts
// statically scrapes this file's raw source for exactly those two shapes to
// verify every real admin-api route has a demo mock, so moving a matching
// literal elsewhere would make that test blind to it even though the route
// still works fine at runtime.
// ─────────────────────────────────────────────────────────────────────────────
import type {
  AdminSession,
  ApprovalStatus,
  BundleDetail,
  BundleInstallLinkWithToken,
  CatalogEntry,
  CurrentUser,
  McpApiKeyWithSecret,
  OidcPublicConfig,
  OidcSettings,
  WsProxyTarget,
} from "../types/api";
import { days, NOW } from "./fixtures/time";
import { DEMO_USER } from "./fixtures/auth";
import { clients } from "./fixtures/clients";
import { bundles, installLinks } from "./fixtures/bundles";
import { catalogEntries, discoveryPreview } from "./fixtures/catalog";
import { wsProxyTargets } from "./fixtures/ws-proxy-targets";
import { clientDetail, flatTools, tagCounts, toolsByTag, TOOLS } from "./fixtures/tools";
import { consumers, mcpKeys } from "./fixtures/keys-consumers";
import { alerts } from "./fixtures/alerts";
import { auditLog } from "./fixtures/audit-log";
import { composites, policies, schedules, snapshots, teams, users } from "./fixtures/administration";
import { byKey, overview, topTools, usageSummary, usageTimeseries } from "./fixtures/usage";
import { trafficRecords } from "./fixtures/traffic";
import { spansByTrace, topSessions, traces } from "./fixtures/traces";
import { monitors } from "./fixtures/monitors";
import { approvals } from "./fixtures/approvals";

// ─── Mutable session state (toggles persist within the tab) ──────────────────

// SSO is off by default in the public demo (there's no real IdP to redirect
// to) but the settings form itself is still interactive, like every other
// admin-only config screen in this demo.
let oidcSettings: OidcSettings | null = null;

let installLinkNextId = 1;

// ─── Router ──────────────────────────────────────────────────────────────────

function ok<T>(v: T): T {
  return v;
}

function route(
  pathname: string,
  method: string,
  body: Record<string, unknown> | undefined,
  params: URLSearchParams,
): unknown {
  const p = pathname.replace(/\/+$/, "") || "/";

  // Auth — always "logged in" as the demo admin.
  if (p === "/admin-api/auth/me")
    return ok<CurrentUser>({ authenticated: true, auth_method: "session", user: DEMO_USER });
  if (p === "/admin-api/auth/login") return ok({ user: DEMO_USER, csrf_token: "demo-csrf-token" });
  if (p === "/admin-api/auth/logout") return ok({});
  if (p === "/admin-api/auth/me/password" && method === "PATCH") return ok({});
  if (p === "/admin-api/auth/sessions" && method === "GET") {
    return ok<{ sessions: AdminSession[] }>({
      sessions: [
        {
          id: 1,
          createdAt: NOW - 3600_000,
          lastSeenAt: NOW,
          expiresAt: NOW + 3600_000,
          ipAddress: "203.0.113.10",
          userAgent: "Mozilla/5.0 (this device)",
        },
        {
          id: 2,
          createdAt: NOW - 86_400_000,
          lastSeenAt: NOW - 7200_000,
          expiresAt: NOW + 86_400_000,
          ipAddress: "198.51.100.42",
          userAgent: "Mozilla/5.0 (another device)",
        },
      ],
    });
  }
  if (/^\/admin-api\/auth\/sessions\/[^/]+$/.test(p) && method === "DELETE") return ok({});

  // SSO — GET/config is what LoginPage.vue checks pre-auth; the demo never
  // enables it (no real IdP to redirect to), but /settings is still a real,
  // interactive form like the rest of this demo's admin-only config screens.
  // /start and /callback are real OAuth redirect targets a static demo SPA
  // has no backend to stand behind, so they're excluded from the demo-vs-real
  // contract test instead of mocked here.
  if (p === "/admin-api/auth/oidc/config") return ok<OidcPublicConfig>({ enabled: oidcSettings?.enabled ?? false });
  if (p === "/admin-api/auth/oidc/settings") {
    if (method === "GET") return ok<{ settings: OidcSettings | null }>({ settings: oidcSettings });
    if (method === "PUT") {
      const b = body ?? {};
      oidcSettings = {
        issuer: typeof b.issuer === "string" ? b.issuer : "",
        clientId: typeof b.clientId === "string" ? b.clientId : "",
        redirectUri: typeof b.redirectUri === "string" ? b.redirectUri : "",
        scopes: typeof b.scopes === "string" ? b.scopes : "openid profile email",
        enabled: b.enabled === true,
        defaultRole: "viewer",
        updatedAt: NOW,
      };
      return ok({ status: "updated" });
    }
  }

  if (p === "/admin-api/overview") return ok(overview);
  if (p === "/admin-api/connect/gateway-url") return ok({ publicUrl: null });

  // Clients (servers)
  if (p === "/admin-api/clients" && method === "GET") return ok({ items: clients });
  const clientDetailMatch = p.match(/^\/admin-api\/clients\/([^/]+)$/);
  if (clientDetailMatch) {
    const name = decodeURIComponent(clientDetailMatch[1]);
    if (method === "GET") return ok(clientDetail(name));
    if (method === "PATCH") {
      const c = clients.find((x) => x.name === name);
      if (c && body && typeof body.enabled === "boolean") c.enabled = body.enabled;
      return ok(clientDetail(name));
    }
    if (method === "DELETE") return undefined;
  }
  if (/^\/admin-api\/clients\/[^/]+\/canary$/.test(p)) return ok({ canary: null });
  if (/^\/admin-api\/clients\/[^/]+\/upstream-auth$/.test(p)) return ok({ configured: false });
  if (/^\/admin-api\/clients\//.test(p)) return ok({}); // any other per-client mutation

  // Bundles
  if (p === "/admin-api/bundles" && method === "GET") return ok({ items: bundles });
  if (p === "/admin-api/bundles" && method === "POST") {
    const name = String(body?.name ?? "new-bundle");
    return ok<BundleDetail>({
      name,
      description: (body?.description as string) ?? null,
      enabled: true,
      createdAt: NOW,
      updatedAt: NOW,
      tools: [],
    });
  }
  const bundleDetailMatch = p.match(/^\/admin-api\/bundles\/([^/]+)$/);
  if (bundleDetailMatch) {
    const name = decodeURIComponent(bundleDetailMatch[1]);
    if (method === "DELETE") return undefined;
    if (method === "PATCH") {
      const b = bundles.find((x) => x.name === name);
      if (b && body && typeof body.enabled === "boolean") b.enabled = body.enabled;
    }
    const b = bundles.find((x) => x.name === name);
    return ok<BundleDetail>({
      name,
      description: b?.description ?? null,
      enabled: b?.enabled ?? true,
      createdAt: days(9),
      updatedAt: NOW,
      tools: (TOOLS[clients[0].name] ?? []).slice(0, 2).map((t) => ({ client: clients[0].name, tool: t.name })),
    });
  }

  // Bundle install links
  const installLinksListMatch = p.match(/^\/admin-api\/bundles\/([^/]+)\/install-links$/);
  if (installLinksListMatch) {
    const bundleName = decodeURIComponent(installLinksListMatch[1]);
    if (method === "GET") {
      return ok({ items: installLinks.filter((l) => l.bundleName === bundleName) });
    }
    if (method === "POST") {
      const id = installLinkNextId++;
      const tokenPrefix = `bil_demo${String(id).padStart(3, "0")}`;
      const link: BundleInstallLinkWithToken = {
        id,
        bundleName,
        tokenPrefix,
        mcpKeyId: 900 + id,
        createdBy: "demo",
        createdAt: NOW,
        expiresAt: null,
        revokedAt: null,
        lastUsedAt: null,
        token: `${tokenPrefix}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
      };
      installLinks.unshift(link);
      return ok<BundleInstallLinkWithToken>(link);
    }
  }
  const installLinkRevokeMatch = p.match(/^\/admin-api\/bundles\/[^/]+\/install-links\/(\d+)$/);
  if (installLinkRevokeMatch && method === "DELETE") {
    const id = Number(installLinkRevokeMatch[1]);
    const link = installLinks.find((l) => l.id === id);
    if (link) link.revokedAt = NOW;
    return ok({ status: "revoked", id });
  }

  if (p === "/admin-api/tools") return ok({ items: flatTools });

  // Catalog
  if (p === "/admin-api/catalog" && method === "GET") return ok({ items: catalogEntries });
  if (p === "/admin-api/catalog" && method === "POST") {
    const entry: CatalogEntry = {
      id: `custom:${catalogEntries.length + 1}`,
      source: "custom",
      slug: String(body?.slug ?? "new-entry"),
      name: String(body?.name ?? "New entry"),
      description: (body?.description as string) ?? null,
      kind: (body?.kind as "rest" | "mcp") ?? "rest",
      category: (body?.category as string) ?? null,
      tags: [],
      icon: null,
      healthUrl: (body?.healthUrl as string) ?? null,
      openapiUrl: (body?.openapiUrl as string) ?? null,
      mcpUrl: (body?.mcpUrl as string) ?? null,
      featured: false,
    };
    catalogEntries.push(entry);
    return ok(entry);
  }
  const catalogInstallMatch = p.match(/^\/admin-api\/catalog\/([^/]+)\/install$/);
  if (catalogInstallMatch) {
    const entry = catalogEntries.find((e) => e.id === decodeURIComponent(catalogInstallMatch[1]));
    const name = String(body?.name ?? entry?.slug ?? "new-server");
    return ok({ status: "registered", name, tools_count: 3, source: entry?.kind === "mcp" ? "mcp" : "openapi" });
  }
  const catalogEntryMatch = p.match(/^\/admin-api\/catalog\/([^/]+)$/);
  if (catalogEntryMatch) {
    const id = decodeURIComponent(catalogEntryMatch[1]);
    if (method === "DELETE") {
      const idx = catalogEntries.findIndex((e) => e.id === id);
      if (idx !== -1) catalogEntries.splice(idx, 1);
      return ok({ status: "deleted", id });
    }
    if (method === "PATCH") {
      const e = catalogEntries.find((x) => x.id === id);
      if (e && body) Object.assign(e, body);
      return ok(e ?? {});
    }
  }

  // WS proxy targets
  if (p === "/admin-api/ws-proxy-targets" && method === "GET") return ok({ items: wsProxyTargets });
  if (p === "/admin-api/ws-proxy-targets" && method === "POST") {
    const target: WsProxyTarget = {
      name: String(body?.name ?? "new-target"),
      backendWsUrl: String(body?.backendWsUrl ?? ""),
      resolvedIp: "203.0.113.99",
      maxConnections: Number(body?.maxConnections ?? 10),
      maxMessageBytes: Number(body?.maxMessageBytes ?? 1_048_576),
      idleTimeoutMs: Number(body?.idleTimeoutMs ?? 300_000),
      enabled: true,
      activeConnections: 0,
      createdAt: NOW,
      updatedAt: NOW,
    };
    wsProxyTargets.push(target);
    return ok(target);
  }
  const wsProxyDisconnectMatch = p.match(/^\/admin-api\/ws-proxy-targets\/([^/]+)\/disconnect-all$/);
  if (wsProxyDisconnectMatch) {
    const t = wsProxyTargets.find((x) => x.name === decodeURIComponent(wsProxyDisconnectMatch[1]));
    const closed = t?.activeConnections ?? 0;
    if (t) t.activeConnections = 0;
    return ok({ status: "disconnected", closed });
  }
  const wsProxyTargetMatch = p.match(/^\/admin-api\/ws-proxy-targets\/([^/]+)$/);
  if (wsProxyTargetMatch) {
    const name = decodeURIComponent(wsProxyTargetMatch[1]);
    if (method === "DELETE") {
      const idx = wsProxyTargets.findIndex((x) => x.name === name);
      if (idx !== -1) wsProxyTargets.splice(idx, 1);
      return ok({ status: "deleted", name });
    }
    if (method === "PATCH") {
      const t = wsProxyTargets.find((x) => x.name === name);
      if (t && body) Object.assign(t, body);
      return ok(t ?? {});
    }
  }

  // Keys & consumers
  if (p === "/admin-api/mcp-keys" && method === "GET") return ok({ items: mcpKeys });
  if (p === "/admin-api/mcp-keys" && method === "POST") {
    return ok<McpApiKeyWithSecret>({
      id: 99,
      label: String(body?.label ?? "New key"),
      keyPrefix: "mcp_live_new0",
      consumerId: null,
      elevated: Boolean(body?.elevated),
      scopes: null,
      enabled: true,
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: "demo",
      key: "mcp_live_new0DEMOxxxxxxxxxxxxxxxxxxxxxxxx",
    });
  }
  if (/^\/admin-api\/mcp-keys\/\d+\/revoke$/.test(p)) return ok({});
  if (/^\/admin-api\/mcp-keys\//.test(p)) return undefined;
  if (p === "/admin-api/consumers" && method === "GET") return ok({ items: consumers });
  const consumerUsageMatch = p.match(/^\/admin-api\/consumers\/(\d+)\/usage$/);
  if (consumerUsageMatch && method === "GET") {
    const c = consumers.find((x) => x.id === Number(consumerUsageMatch[1]));
    return ok({ used: c?.usedThisMonth ?? 0, quota: c?.monthlyQuota ?? null });
  }
  if (/^\/admin-api\/consumers/.test(p)) return ok({ id: 99, name: String(body?.name ?? "New") });

  // Tags (browse-by-tag)
  if (p === "/admin-api/tags" && method === "GET") return ok({ items: tagCounts });
  const tagToolsMatch = p.match(/^\/admin-api\/tags\/([^/]+)\/tools$/);
  if (tagToolsMatch && method === "GET") return ok({ items: toolsByTag(decodeURIComponent(tagToolsMatch[1])) });

  // Observability
  if (p === "/admin-api/usage/summary") return ok(usageSummary);
  if (p === "/admin-api/usage/top-tools") return ok({ items: topTools });
  if (p === "/admin-api/usage/by-key") return ok({ items: byKey });
  if (p === "/admin-api/usage/timeseries") return ok(usageTimeseries);
  if (p === "/admin-api/alerts" && method === "GET") return ok({ items: alerts });
  if (/^\/admin-api\/alerts/.test(p)) return ok({ id: 99 });
  if (p === "/admin-api/audit-log/actions") {
    return ok({ actions: Array.from(new Set(auditLog.map((e) => e.action))).sort() });
  }
  if (p === "/admin-api/audit-log") return ok({ items: auditLog });
  if (p === "/admin-api/audit-log/export") return ok({ items: auditLog });
  if (p === "/admin-api/audit-log/verify") return ok({ ok: true, checked: auditLog.length });

  // Traffic explorer
  if (p === "/admin-api/traffic" && method === "GET") {
    let items = trafficRecords.slice();
    const client = params.get("client");
    const tool = params.get("tool");
    if (client) items = items.filter((r) => r.clientName === client);
    if (tool) items = items.filter((r) => r.toolName === tool);
    if (params.get("errors") === "true") items = items.filter((r) => r.isError);
    return ok({ items });
  }
  const trafficDetailMatch = p.match(/^\/admin-api\/traffic\/(\d+)$/);
  if (trafficDetailMatch && method === "GET") {
    const rec = trafficRecords.find((r) => r.id === Number(trafficDetailMatch[1]));
    return rec ? ok(rec) : undefined;
  }
  if (/^\/admin-api\/traffic\/\d+\/replay$/.test(p) && method === "POST") {
    return ok({
      content: [{ type: "text", text: "Replayed successfully (demo — no real upstream was called)." }],
      isError: false,
    });
  }

  // Trace viewer
  if (p === "/admin-api/traces" && method === "GET") {
    const tool = params.get("tool");
    const sessionId = params.get("session_id");
    let items = tool ? traces.filter((t) => t.mcpToolName === tool) : traces;
    if (sessionId) items = items.filter((t) => t.sessionId === sessionId);
    return ok({ items });
  }
  if (p === "/admin-api/traces" && method === "DELETE") {
    return ok({ status: "purged", removed: traces.length });
  }
  if (p === "/admin-api/traces/top-sessions" && method === "GET") {
    return ok({ items: topSessions });
  }
  const traceDetailMatch = p.match(/^\/admin-api\/traces\/([^/]+)$/);
  if (traceDetailMatch && method === "GET") {
    const spans = spansByTrace[traceDetailMatch[1]];
    return spans ? ok({ traceId: traceDetailMatch[1], spans }) : undefined;
  }

  // Synthetic monitors
  if (p === "/admin-api/monitors") return ok({ items: monitors });

  // Approvals
  if (p === "/admin-api/approvals" && method === "GET") {
    const status = params.get("status") as ApprovalStatus | null;
    // Always return a fresh array (never the live `approvals` reference) — Vue's ref
    // setter no-ops on an unchanged object identity, so reusing the same reference
    // across reloads would silently stop the status-breakdown donut from updating.
    const items = status ? approvals.filter((a) => a.status === status) : approvals.slice();
    return ok({ items });
  }
  const approvalDecideMatch = p.match(/^\/admin-api\/approvals\/(\d+)\/(approve|reject)$/);
  if (approvalDecideMatch && method === "POST") {
    const id = Number(approvalDecideMatch[1]);
    const decision: ApprovalStatus = approvalDecideMatch[2] === "approve" ? "approved" : "rejected";
    const a = approvals.find((x) => x.id === id);
    if (a && a.status === "pending") {
      const note = typeof body?.note === "string" ? body.note : null;
      a.decisions.push({
        id: a.decisions.length + 1,
        approvalId: a.id,
        decidedBy: "demo",
        decision,
        note,
        decidedAt: NOW,
      });
      const approvedCount = a.decisions.filter((d) => d.decision === "approved").length;
      if (decision === "rejected" || approvedCount >= a.requiredLevels) {
        a.status = decision === "rejected" ? "rejected" : "approved";
        a.decidedAt = NOW;
        a.decidedBy = "demo";
        a.note = note;
      }
    }
    return ok({ status: a?.status ?? decision, id });
  }

  // Administration
  if (p === "/admin-api/users" && method === "GET") return ok({ users });
  const userTeamMatch = p.match(/^\/admin-api\/users\/([^/]+)\/team$/);
  if (userTeamMatch && method === "PUT") {
    const u = users.find((x) => x.username === decodeURIComponent(userTeamMatch[1]));
    const teamId = body?.teamId === null ? null : typeof body?.teamId === "number" ? body.teamId : null;
    if (u) u.team_id = teamId;
    return ok({ status: "updated", username: u?.username, teamId });
  }
  if (/^\/admin-api\/users/.test(p)) return ok({ ok: true });
  if (p === "/admin-api/teams" && method === "GET") return ok({ items: teams });
  if (/^\/admin-api\/teams/.test(p)) return ok({ id: 99 });
  if (p === "/admin-api/policies") return ok({ items: policies });
  if (/^\/admin-api\/policies/.test(p)) return ok({ applied: 3, skipped: [] });
  if (p === "/admin-api/composites") return ok({ items: composites });
  if (/^\/admin-api\/composites/.test(p)) return ok({});
  if (p === "/admin-api/schedules") return ok({ items: schedules });
  if (/^\/admin-api\/schedules/.test(p)) return ok({ id: 99 });
  if (p === "/admin-api/config/snapshots") return ok({ items: snapshots });
  if (p === "/admin-api/config/export") return ok({ version: 1, clients: clients.length, bundles: bundles.length });
  if (/^\/admin-api\/config\/(snapshots|import)/.test(p))
    return ok({
      dryRun: true,
      applied: { bundles: 3, alertRules: 3, clientsConfigured: 6, toolsConfigured: 42 },
      skipped: [],
    });

  // Discovery preview (Add server / re-sync)
  if (p === "/admin-api/discovery/preview" || p === "/admin-api/discovery/preview-graphql" || p === "/register")
    return ok(discoveryPreview);

  // Graceful default: never 404 the demo.
  if (method === "GET") return ok({ items: [] });
  return ok({ ok: true });
}

/** Drop-in replacement for the real fetch path, used only in demo builds. */
export async function demoFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  let body: Record<string, unknown> | undefined;
  if (typeof init.body === "string") {
    try {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      body = undefined;
    }
  }
  const [pathname, search] = path.split("?");
  const params = new URLSearchParams(search ?? "");
  // A touch of latency so spinners/skeletons behave like the real thing.
  await new Promise((r) => setTimeout(r, 90 + Math.floor(Math.random() * 120)));
  return route(pathname, method, body, params) as T;
}
