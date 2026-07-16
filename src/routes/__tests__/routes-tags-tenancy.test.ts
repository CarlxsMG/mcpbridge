/**
 * Tenancy-scoping regression tests for src/routes/tags.ts.
 *
 * tool_tags rows are keyed by client_name, so a tool's tags belong to whatever
 * team owns the client. A team-scoped admin must not be able to (a) write tags
 * on another team's tool — nor use the PUT's 200-vs-404 as a cross-tenant
 * existence oracle — nor (b) enumerate every team's client/tool names via
 * GET /tags or GET /tags/:tag/tools. Bearer/super-admin callers still see all.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { setToolTags } from "../../tool-meta/tool-tags.js";
import { createUser } from "../../security/user-store.js";
import { createSession } from "../../security/session-store.js";
import { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } from "../../security/cookies.js";
import { createTeam, setUserTeam, setClientTeam } from "../../admin/entities/teams.js";

let baseUrl = "";
let activeServer: Server | null = null;
const ADMIN_KEY = "test-admin-key-tags-tenancy";

async function startApp(): Promise<void> {
  __resetDbForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;

  const { tagRoutes } = await import("../../routes/tags.js");
  const app = express();
  app.use(express.json());
  tagRoutes(app);

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
});

afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  await new Promise<void>((resolve) => {
    if (activeServer)
      activeServer.close(() => {
        activeServer = null;
        resolve();
      });
    else resolve();
  });
});

describe("PUT /admin-api/clients/:name/tools/:tool/tags — team scoping", () => {
  test("a team-scoped admin gets CLIENT_NOT_FOUND (not an oracle) for another team's client", async () => {
    await startApp();
    await reg("svc-a");
    await reg("svc-b");
    const { headers, teamId } = teamSessionHeaders("tags-put-user");
    setClientTeam("svc-a", teamId);
    // svc-b left unowned (null team) — must be indistinguishable from non-existent.

    const res = await fetch(`${baseUrl}/admin-api/clients/svc-b/tools/t/tags`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ tags: ["alpha"] }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CLIENT_NOT_FOUND");
  });

  test("a team-scoped admin CAN write tags on its own team's tool", async () => {
    await startApp();
    await reg("svc-a");
    const { headers, teamId } = teamSessionHeaders("tags-put-own-user");
    setClientTeam("svc-a", teamId);

    const res = await fetch(`${baseUrl}/admin-api/clients/svc-a/tools/t/tags`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ tags: ["alpha"] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tags: string[] };
    expect(body.tags).toEqual(["alpha"]);
  });
});

describe("GET /admin-api/tags — team scoping", () => {
  test("a team-scoped caller only sees tags on its own team's tools", async () => {
    await startApp();
    await reg("svc-a");
    await reg("svc-b");
    const { headers, teamId } = teamSessionHeaders("tags-list-user");
    setClientTeam("svc-a", teamId);
    setToolTags("svc-a", "t", ["alpha"]);
    setToolTags("svc-b", "t", ["beta"]);

    const res = await fetch(`${baseUrl}/admin-api/tags`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { tag: string; count: number }[] };
    expect(body.items.map((i) => i.tag)).toEqual(["alpha"]);
  });

  test("a bearer (super-admin) caller sees tags across every team", async () => {
    await startApp();
    await reg("svc-a");
    await reg("svc-b");
    const team = createTeam("bearer-visible-tags-team", "test");
    if (typeof team === "string") throw new Error("createTeam failed");
    setClientTeam("svc-a", team.id);
    setToolTags("svc-a", "t", ["alpha"]);
    setToolTags("svc-b", "t", ["beta"]);

    const res = await fetch(`${baseUrl}/admin-api/tags`, { headers: bearer() });
    const body = (await res.json()) as { items: { tag: string }[] };
    expect(body.items.map((i) => i.tag).sort()).toEqual(["alpha", "beta"]);
  });
});

describe("GET /admin-api/tags/:tag/tools — team scoping", () => {
  test("a team-scoped caller only sees its own team's tools carrying a shared tag", async () => {
    await startApp();
    await reg("svc-a");
    await reg("svc-b");
    const { headers, teamId } = teamSessionHeaders("tags-by-tag-user");
    setClientTeam("svc-a", teamId);
    setToolTags("svc-a", "t", ["shared"]);
    setToolTags("svc-b", "t", ["shared"]);

    const res = await fetch(`${baseUrl}/admin-api/tags/shared/tools`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { client: string; tool: string }[] };
    expect(body.items).toEqual([{ client: "svc-a", tool: "t" }]);
  });

  test("a bearer (super-admin) caller sees every team's tools carrying a shared tag", async () => {
    await startApp();
    await reg("svc-a");
    await reg("svc-b");
    const team = createTeam("bearer-by-tag-team", "test");
    if (typeof team === "string") throw new Error("createTeam failed");
    setClientTeam("svc-a", team.id);
    setToolTags("svc-a", "t", ["shared"]);
    setToolTags("svc-b", "t", ["shared"]);

    const res = await fetch(`${baseUrl}/admin-api/tags/shared/tools`, { headers: bearer() });
    const body = (await res.json()) as { items: { client: string }[] };
    expect(body.items.map((i) => i.client).sort()).toEqual(["svc-a", "svc-b"]);
  });
});
