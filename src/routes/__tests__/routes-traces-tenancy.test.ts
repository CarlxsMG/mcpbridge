/**
 * Tenancy-scoping regression tests for src/routes/traces.ts.
 *
 * `tool_spans.mcp_tool_name` is always a `clientName__toolName` composite key
 * (every persisted span comes from proxyToolCall's single startSpan call
 * site), so traces/spans/top-sessions/purge can and must be scoped to the
 * caller's own team's clients the same way GET /admin-api/clients already is
 * — a team-scoped admin must not be able to see (or purge) another tenant's
 * tool-call history via the trace viewer.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { startSpan, endSpan, _internalsForTesting as tracingInternals } from "../../observability/tracing.js";
import { __clearSpansForTesting } from "../../observability/trace-store.js";
import { createUser } from "../../security/user-store.js";
import { createSession } from "../../security/session-store.js";
import { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } from "../../security/cookies.js";
import { createTeam, setUserTeam, setClientTeam } from "../../admin/entities/teams.js";

let baseUrl = "";
let activeServer: Server | null = null;
const ADMIN_KEY = "test-admin-key-traces-tenancy";
// startApp() turns trace storage on. All test files share one process and one
// `config` object, so leaving it on leaks into every file that runs afterwards —
// `tracingEnabled()` is `Boolean(otelEndpoint) || traceStorageEnabled`, so a test
// elsewhere asserting that tracing is OFF then fails, and which file gets hit
// depends on the filesystem's discovery order (it was CI's Linux ordering, not
// the maintainer's Windows one). Mirrors the sibling routes-traces-mutation.test.ts.
const originalTraceStorage = config.traceStorageEnabled;

async function startApp(): Promise<void> {
  __resetDbForTesting();
  __clearSpansForTesting();
  tracingInternals.clear();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  (config as Record<string, unknown>).traceStorageEnabled = true;

  const { tracesRoutes } = await import("../../routes/traces.js");
  const app = express();
  app.use(express.json());
  tracesRoutes(app);

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

function recordSpan(mcpToolName: string, sessionId?: string): { traceId: string } {
  const span = startSpan(`tool_call ${mcpToolName}`, { "mcp.tool": mcpToolName });
  endSpan(span, sessionId ? { "mcp.session_id": sessionId } : {}, 1);
  return span;
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

function teamSessionHeaders(username: string): { headers: Record<string, string>; teamId: number } {
  const team = createTeam(`team-${username}`, "test");
  if (typeof team === "string") throw new Error(`createTeam failed: ${team}`);
  const user = createUser(username, "irrelevant-hash", "admin", null);
  setUserTeam(user.username, team.id);
  const session = createSession(user.id, "127.0.0.1", "test-agent");
  return {
    teamId: team.id,
    headers: {
      "Content-Type": "application/json",
      Cookie: `${SESSION_COOKIE_NAME}=${session.token}; ${CSRF_COOKIE_NAME}=${session.csrfToken}`,
      "X-CSRF-Token": session.csrfToken,
    },
  };
}

beforeEach(() => {
  __resetDbForTesting();
  __clearSpansForTesting();
  tracingInternals.clear();
});

afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __clearSpansForTesting();
  tracingInternals.clear();
  (config as Record<string, unknown>).traceStorageEnabled = originalTraceStorage;
  await new Promise<void>((resolve) => {
    if (activeServer)
      activeServer.close(() => {
        activeServer = null;
        resolve();
      });
    else resolve();
  });
});

describe("GET /admin-api/traces — team scoping", () => {
  test("a team-scoped caller only sees traces for its own team's clients", async () => {
    await startApp();
    await reg("svc-a");
    await reg("svc-b");
    const { headers, teamId } = teamSessionHeaders("traces-team-user");
    setClientTeam("svc-a", teamId);
    // svc-b left unowned (null team) — must NOT be visible to a team-scoped caller.

    recordSpan("svc-a__t");
    recordSpan("svc-b__t");

    const res = await fetch(`${baseUrl}/admin-api/traces`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { mcpToolName: string | null }[] };
    expect(body.items.map((i) => i.mcpToolName)).toEqual(["svc-a__t"]);
  });

  test("a bearer (super-admin) caller sees traces across every team", async () => {
    await startApp();
    await reg("svc-a");
    await reg("svc-b");
    const otherTeam = createTeam("bearer-visible-team", "test");
    if (typeof otherTeam === "string") throw new Error("createTeam failed");
    setClientTeam("svc-a", otherTeam.id);

    recordSpan("svc-a__t");
    recordSpan("svc-b__t");

    const res = await fetch(`${baseUrl}/admin-api/traces`, { headers: bearer() });
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(2);
  });
});

describe("GET /admin-api/traces/:traceId — team scoping", () => {
  test("a team-scoped caller gets TRACE_NOT_FOUND for another team's trace", async () => {
    await startApp();
    await reg("svc-a");
    await reg("svc-b");
    const { headers, teamId } = teamSessionHeaders("traces-team-detail-user");
    setClientTeam("svc-a", teamId);

    const foreignSpan = recordSpan("svc-b__t");

    const res = await fetch(`${baseUrl}/admin-api/traces/${foreignSpan.traceId}`, { headers });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("TRACE_NOT_FOUND");
  });

  test("a team-scoped caller CAN read its own team's trace", async () => {
    await startApp();
    await reg("svc-a");
    const { headers, teamId } = teamSessionHeaders("traces-team-detail-own");
    setClientTeam("svc-a", teamId);

    const ownSpan = recordSpan("svc-a__t");

    const res = await fetch(`${baseUrl}/admin-api/traces/${ownSpan.traceId}`, { headers });
    expect(res.status).toBe(200);
  });
});

describe("GET /admin-api/traces/top-sessions — team scoping", () => {
  test("a team-scoped caller's session counts only reflect its own team's spans", async () => {
    await startApp();
    await reg("svc-a");
    await reg("svc-b");
    const { headers, teamId } = teamSessionHeaders("traces-team-sessions-user");
    setClientTeam("svc-a", teamId);

    recordSpan("svc-a__t", "shared-session");
    recordSpan("svc-b__t", "shared-session");
    recordSpan("svc-b__t", "other-team-session");

    const res = await fetch(`${baseUrl}/admin-api/traces/top-sessions`, { headers });
    const body = (await res.json()) as { items: { sessionId: string; calls: number; hasError: boolean }[] };
    expect(body.items).toEqual([{ sessionId: "shared-session", calls: 1, hasError: false }]);
  });
});

describe("DELETE /admin-api/traces — team-scoped purge", () => {
  test("a team-scoped caller's purge only removes its own team's spans", async () => {
    await startApp();
    await reg("svc-a");
    await reg("svc-b");
    const { headers, teamId } = teamSessionHeaders("traces-team-purge-user");
    setClientTeam("svc-a", teamId);

    recordSpan("svc-a__t");
    recordSpan("svc-b__t");

    const res = await fetch(`${baseUrl}/admin-api/traces`, { method: "DELETE", headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; removed: number };
    expect(body).toEqual({ status: "purged", removed: 1 });

    const after = await fetch(`${baseUrl}/admin-api/traces`, { headers: bearer() });
    const afterBody = (await after.json()) as { items: { mcpToolName: string | null }[] };
    expect(afterBody.items.map((i) => i.mcpToolName)).toEqual(["svc-b__t"]);
  });
});
