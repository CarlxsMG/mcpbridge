/**
 * Mutation-testing backstop for src/routes/mcp-keys.ts. Gap-fills whatever
 * routes-mcp-keys.test.ts doesn't already cover — do NOT duplicate its
 * happy-path create/list/patch/revoke/delete/adminRole-gating tests. New
 * ground covered here: consumerId validation (untested at baseline), the
 * expiresAt/label/scopes boundary & type-guard clusters, the `elevated`
 * grant (untested at baseline, both the POST truthy-only `=== true` check
 * and PATCH's `typeof` guard + super-admin gate), recordAudit's exact
 * call args for all 4 mutating actions (create/update/revoke/delete), and
 * the 404/409 exact error-envelope bodies for every route that returns one.
 */
import { describe, test, expect, afterEach, spyOn } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { requestIdMiddleware } from "../../middleware/request-id.js";
import { registry } from "../../mcp/registry.js";
import { createUser } from "../../security/user-store.js";
import { createSession } from "../../security/session-store.js";
import { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } from "../../security/cookies.js";
import { createTeam, setUserTeam, setClientTeam } from "../../admin/entities/teams.js";
import { createConsumer } from "../../admin/entities/consumers.js";
import { getMcpKey, createMcpKey } from "../../security/mcp-key-store.js";
import * as auditMod from "../../admin/audit/audit.js";

let baseUrl = "";
let activeServer: Server | null = null;
const ADMIN_KEY = "test-admin-key-mcpkeys-mut";

async function startApp(): Promise<void> {
  __resetDbForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;

  const { mcpKeyRoutes } = await import("../../routes/mcp-keys.js");
  const app = express();
  app.use(express.json({ limit: "64kb", strict: true }));
  app.use(requestIdMiddleware);
  mcpKeyRoutes(app);

  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      activeServer = srv;
      resolve();
    });
    srv.on("error", reject);
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (activeServer) {
      activeServer.close(() => {
        activeServer = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" };
}

/** A non-super-admin (team-scoped) admin-role session — for grant-gating tests. */
function teamAdminSessionHeaders(username: string): { headers: Record<string, string>; teamId: number } {
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

/** Registers a bare client (fixed loopback-adjacent IPs, no real network I/O) so it can be assigned to a team via `setClientTeam`. */
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

async function mint(
  body: Record<string, unknown> = { label: "k" },
  headers: Record<string, string> = bearer(),
): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
}

/** Same as teamAdminSessionHeaders, but also returns the team id so a test can assign clients to it. */
function createTeamAdminSession(username: string): { teamId: number; headers: Record<string, string> } {
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

afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  await stopServer();
  for (const c of registry.listClients()) await registry.unregister(c.name);
});

describe("validateConsumerId", () => {
  test("mints a key with a consumerId referencing a real consumer", async () => {
    await startApp();
    const consumer = createConsumer({ name: "acme", monthlyQuota: null, actor: null });
    const body = await mint({ label: "scoped", consumerId: consumer.id });
    expect(body.consumerId).toBe(consumer.id);
  });

  test("400 when consumerId is a non-integer number", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ label: "k", consumerId: 1.5 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toBe("consumerId must be an integer or null");
  });

  test("400 when consumerId is a truthy non-number (string)", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ label: "k", consumerId: "5" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("consumerId must be an integer or null");
  });

  test("400 when consumerId does not reference an existing consumer", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ label: "k", consumerId: 999999 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("consumerId does not reference an existing consumer");
  });

  test("PATCH accepts a valid consumerId and PATCH rejects an unknown one", async () => {
    await startApp();
    const consumer = createConsumer({ name: "acme2", monthlyQuota: null, actor: null });
    const { id } = await mint({ label: "target" });

    const ok = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ consumerId: consumer.id }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { consumerId: number }).consumerId).toBe(consumer.id);

    const bad = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ consumerId: 424242 }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { message: string } }).error.message).toBe(
      "consumerId does not reference an existing consumer",
    );

    // Explicit null clears it back out.
    const cleared = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ consumerId: null }),
    });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { consumerId: number | null }).consumerId).toBeNull();
  });
});

describe("validateExpiresAt", () => {
  test("mints a key with a valid future expiresAt", async () => {
    await startApp();
    const future = Date.now() + 100_000;
    const body = await mint({ label: "expiring", expiresAt: future });
    expect(body.expiresAt).toBe(future);
  });

  test("400 for a non-number expiresAt (truthy string)", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ label: "k", expiresAt: "123" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      "expiresAt must be a positive epoch-ms number or null",
    );
  });

  test("400 for a non-finite expiresAt (Infinity)", async () => {
    await startApp();
    // JSON.stringify({expiresAt: Infinity}) itself collapses to `null` before
    // it ever leaves this process (JS numbers, not JSON, carry the concept of
    // Infinity) — so this needs a hand-written JSON body. "1e400" IS valid
    // JSON number syntax; standard float parsing overflows it to Infinity,
    // which is exactly what the server's own JSON.parse does too.
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
      method: "POST",
      headers: bearer(),
      body: '{"label":"k","expiresAt":1e400}',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      "expiresAt must be a positive epoch-ms number or null",
    );
  });

  test("boundary: expiresAt of exactly 0 is rejected, 1 is accepted", async () => {
    await startApp();
    const zero = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ label: "k0", expiresAt: 0 }),
    });
    expect(zero.status).toBe(400);

    const one = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ label: "k1", expiresAt: 1 }),
    });
    expect(one.status).toBe(201);
    expect(((await one.json()) as { expiresAt: number }).expiresAt).toBe(1);
  });

  test("PATCH updates expiresAt, and rejects an invalid one", async () => {
    await startApp();
    const { id } = await mint({ label: "target" });
    const future = Date.now() + 50_000;
    const ok = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ expiresAt: future }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { expiresAt: number }).expiresAt).toBe(future);

    const bad = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ expiresAt: -5 }),
    });
    expect(bad.status).toBe(400);

    // Explicit null clears it back out (distinct code path from "field absent").
    const cleared = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ expiresAt: null }),
    });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { expiresAt: number | null }).expiresAt).toBeNull();
  });
});

describe("validateScopes", () => {
  test("mints a key with both clients and tools scopes preserved distinctly", async () => {
    await startApp();
    const body = await mint({ label: "both-scopes", scopes: { clients: ["svc-a"], tools: ["svc-b__run"] } });
    expect(body.scopes).toEqual({ clients: ["svc-a"], tools: ["svc-b__run"] });
  });

  test("400 when scopes is an array (not a plain object)", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ label: "k", scopes: [] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      "scopes must be an object or null",
    );
  });

  test("400 when scopes is a non-object primitive", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ label: "k", scopes: "nope" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      "scopes must be an object or null",
    );
  });

  test("400 for a malformed tools array (non-string element)", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ label: "k", scopes: { tools: [123] } }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      "scopes.tools must be an array of non-empty strings",
    );
  });

  test("400 for an empty-string element (boundary: length must be > 0)", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ label: "k", scopes: { clients: [""] } }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      "scopes.clients must be an array of non-empty strings",
    );
  });

  test("400 for a mixed valid/invalid array (proves the check is 'every element valid', not 'some element valid')", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ label: "k", scopes: { clients: ["good", 123] } }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      "scopes.clients must be an array of non-empty strings",
    );
  });

  test("400 for a non-string element that itself has a truthy length (an array), proving the string-type check is real, not redundant with the length check", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ label: "k", scopes: { clients: [["nested"]] } }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      "scopes.clients must be an array of non-empty strings",
    );
  });

  test("PATCH updates scopes, and can clear them back to null", async () => {
    await startApp();
    const { id } = await mint({ label: "target", scopes: { clients: ["a"] } });
    const patched = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ scopes: { tools: ["b__c"] } }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { scopes: unknown }).scopes).toEqual({ tools: ["b__c"] });

    const cleared = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ scopes: null }),
    });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { scopes: unknown }).scopes).toBeNull();

    const badType = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ scopes: "bad" }),
    });
    expect(badType.status).toBe(400);
  });
});

describe("validateLabel boundaries", () => {
  test("400 for a non-string truthy label", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ label: 123 }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      "label is required and must be 1-128 characters",
    );
  });

  test("400 for a whitespace-only label", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ label: "    " }),
    });
    expect(res.status).toBe(400);
  });

  test("boundary: a 128-char label is accepted, 129 is rejected", async () => {
    await startApp();
    const ok = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ label: "a".repeat(128) }),
    });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { label: string }).label.length).toBe(128);

    const bad = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ label: "a".repeat(129) }),
    });
    expect(bad.status).toBe(400);
  });

  test("trims surrounding whitespace on create", async () => {
    await startApp();
    const body = await mint({ label: "  padded  " });
    expect(body.label).toBe("padded");
  });

  test("the 128-char max is checked against the TRIMMED length, not the raw length", async () => {
    await startApp();
    // Raw length 132 (with padding), trimmed length exactly 128 — must be accepted.
    const label = `  ${"a".repeat(128)}  `;
    const body = await mint({ label });
    expect((body.label as string).length).toBe(128);
  });

  test("PATCH rejects an invalid label", async () => {
    await startApp();
    const { id } = await mint({ label: "target" });
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ label: "   " }),
    });
    expect(res.status).toBe(400);
  });
});

describe("PATCH enabled type guard", () => {
  test("400 for a non-boolean enabled value", async () => {
    await startApp();
    const { id } = await mint({ label: "target" });
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ enabled: "false" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe("enabled must be a boolean");
  });
});

describe("elevated grant gating", () => {
  test("POST: the env Bearer (super-admin) can mint a key with elevated true", async () => {
    await startApp();
    const body = await mint({ label: "elevated-bot", elevated: true });
    expect(body.elevated).toBe(true);
    const rec = getMcpKey(body.id as number);
    expect(rec?.elevated).toBe(true);
  });

  test("POST: a team-scoped admin session cannot set elevated true (403)", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
      method: "POST",
      headers: teamAdminSessionHeaders("team-admin-elev").headers,
      body: JSON.stringify({ label: "escalate", elevated: true }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toBe("Setting elevated requires a super-admin (admin role, no team)");
  });

  test("POST: a truthy-but-non-boolean elevated value is treated as false (=== true, not type coercion)", async () => {
    await startApp();
    // Use a super-admin (env Bearer) who *could* set elevated with a real boolean:
    // the string "true" still yielding elevated:false proves the check is a strict
    // `=== true`, not a truthy coercion. (A team-scoped admin can't reach this path
    // at all now — an unscoped mint is rejected by scope confinement first.)
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ label: "sneaky", elevated: "true" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: number; elevated: boolean };
    expect(body.elevated).toBe(false);
    expect(getMcpKey(body.id)?.elevated).toBe(false);
  });

  test("PATCH: 400 for a non-boolean elevated value", async () => {
    await startApp();
    const { id } = await mint({ label: "target" });
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ elevated: "yes" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe("elevated must be a boolean");
  });

  test("PATCH: a team-scoped admin cannot set elevated true on a key it owns (403), but a super-admin can", async () => {
    await startApp();
    await reg("svc-mcpkeys-elev3");
    const { headers, teamId } = teamAdminSessionHeaders("team-admin-elev3");
    setClientTeam("svc-mcpkeys-elev3", teamId);
    // The key must be visible to (owned by) the team admin, so this test
    // exercises the elevated-escalation gate itself, not the ownership check.
    const { id } = await mint({ label: "target", scopes: { clients: ["svc-mcpkeys-elev3"] } }, headers);

    const forbiddenRes = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ elevated: true }),
    });
    expect(forbiddenRes.status).toBe(403);
    const forbiddenBody = (await forbiddenRes.json()) as { error: { code: string; message: string } };
    expect(forbiddenBody.error.code).toBe("FORBIDDEN");
    expect(forbiddenBody.error.message).toBe("Setting elevated requires a super-admin (admin role, no team)");

    const okRes = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ elevated: true }),
    });
    expect(okRes.status).toBe(200);
    expect(((await okRes.json()) as { elevated: boolean }).elevated).toBe(true);
  });

  test("PATCH: a team-scoped admin CAN set elevated false on a key it owns (the super-admin gate only guards the truthy branch)", async () => {
    await startApp();
    await reg("svc-mcpkeys-elev4");
    const { headers, teamId } = teamAdminSessionHeaders("team-admin-elev4");
    setClientTeam("svc-mcpkeys-elev4", teamId);
    // Only a super-admin can mint with elevated: true, but scoping it to the
    // team's own client means the team admin still owns (and can see) it.
    const { id } = await mint({ label: "target", elevated: true, scopes: { clients: ["svc-mcpkeys-elev4"] } });
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ elevated: false }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { elevated: boolean }).elevated).toBe(false);
  });
});

describe("adminRole — explicit null is not gated (only a non-null grant is)", () => {
  test("PATCH: a team-scoped admin can explicitly clear adminRole to null on a key it owns", async () => {
    await startApp();
    await reg("svc-mcpkeys-role-null");
    const { headers, teamId } = teamAdminSessionHeaders("team-admin-role-null");
    setClientTeam("svc-mcpkeys-role-null", teamId);
    // adminRole already null; the key must be visible to (owned by) the team
    // admin so this exercises the null-clear path, not the ownership check.
    const { id } = await mint({ label: "target", scopes: { clients: ["svc-mcpkeys-role-null"] } }, headers);
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ adminRole: null }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { adminRole: string | null }).adminRole).toBeNull();
  });
});

describe("recordAudit — exact call args", () => {
  test("mcp_key.create records the full detail object", async () => {
    await startApp();
    const consumer = createConsumer({ name: "audit-consumer", monthlyQuota: null, actor: null });
    const spy = spyOn(auditMod, "recordAudit");
    try {
      const res = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          label: "audited",
          scopes: { clients: ["svc"] },
          consumerId: consumer.id,
          adminRole: "operator",
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: number };
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith("bearer:admin-api-key", "mcp_key.create", String(body.id), {
        label: "audited",
        scopes: { clients: ["svc"] },
        consumerId: consumer.id,
        adminRole: "operator",
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("mcp_key.create with no optional fields omits them from the detail object", async () => {
    await startApp();
    const spy = spyOn(auditMod, "recordAudit");
    try {
      const res = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ label: "bare" }),
      });
      const body = (await res.json()) as { id: number };
      expect(spy).toHaveBeenCalledWith("bearer:admin-api-key", "mcp_key.create", String(body.id), {
        label: "bare",
        scopes: undefined,
        consumerId: undefined,
        adminRole: undefined,
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("mcp_key.update records exactly the fields that were changed, in call order", async () => {
    await startApp();
    const { id } = await mint({ label: "target" });
    const spy = spyOn(auditMod, "recordAudit");
    try {
      const res = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ label: "renamed", enabled: false, expiresAt: null }),
      });
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledWith("bearer:admin-api-key", "mcp_key.update", String(id), {
        fields: ["label", "enabled", "expiresAt"],
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("mcp_key.revoke is recorded with no detail argument at all", async () => {
    await startApp();
    const { id } = await mint({ label: "target" });
    const spy = spyOn(auditMod, "recordAudit");
    try {
      const res = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}/revoke`, { method: "POST", headers: bearer() });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "revoked", id });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.length).toBe(3);
      expect(spy).toHaveBeenCalledWith("bearer:admin-api-key", "mcp_key.revoke", String(id));
    } finally {
      spy.mockRestore();
    }
  });

  test("mcp_key.delete is recorded with no detail argument at all", async () => {
    await startApp();
    const { id } = await mint({ label: "target" });
    const spy = spyOn(auditMod, "recordAudit");
    try {
      const res = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, { method: "DELETE", headers: bearer() });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "deleted", id });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.length).toBe(3);
      expect(spy).toHaveBeenCalledWith("bearer:admin-api-key", "mcp_key.delete", String(id));
    } finally {
      spy.mockRestore();
    }
  });
});

describe("GET single key — the happy path (a real record must actually be returned, not always 404)", () => {
  test("GET a valid id returns 200 with the full record", async () => {
    await startApp();
    const minted = await mint({ label: "target" });
    const id = minted.id as number;
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, { headers: bearer() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number; label: string };
    expect(body.id).toBe(id);
    expect(body.label).toBe("target");
  });
});

describe("PATCH partial updates leave untouched fields alone", () => {
  test("patching only label does not clobber a pre-existing expiresAt", async () => {
    await startApp();
    const future = Date.now() + 60_000;
    const { id } = await mint({ label: "target", expiresAt: future });
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ label: "renamed-only" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { label: string; expiresAt: number | null };
    expect(body.label).toBe("renamed-only");
    expect(body.expiresAt).toBe(future);
  });
});

describe("404/409 exact error envelopes for every not-found call site", () => {
  test("GET unknown id: exact MCP_KEY_NOT_FOUND envelope", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys/424242`, { headers: bearer() });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("MCP_KEY_NOT_FOUND");
    expect(body.error.message).toBe("API key not found");
  });

  test("PATCH unknown id: 404 before any body validation runs", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys/424242`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ label: "whatever" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("MCP_KEY_NOT_FOUND");
    expect(body.error.message).toBe("API key not found");
  });

  test("revoke unknown id: exact 404 envelope", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys/424242/revoke`, { method: "POST", headers: bearer() });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("MCP_KEY_NOT_FOUND");
    expect(body.error.message).toBe("API key not found");
  });

  test("DELETE unknown id: exact 404 envelope", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys/424242`, { method: "DELETE", headers: bearer() });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("MCP_KEY_NOT_FOUND");
    expect(body.error.message).toBe("API key not found");
  });

  test("revoke twice: exact 409 ALREADY_REVOKED envelope", async () => {
    await startApp();
    const { id } = await mint({ label: "target" });
    await fetch(`${baseUrl}/admin-api/mcp-keys/${id}/revoke`, { method: "POST", headers: bearer() });
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}/revoke`, { method: "POST", headers: bearer() });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("ALREADY_REVOKED");
    expect(body.error.message).toBe("API key is already revoked");
  });
});

describe("adminRole forbidden envelopes (exact message, both call sites)", () => {
  test("POST: exact FORBIDDEN envelope when a team-scoped admin sets adminRole", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
      method: "POST",
      headers: teamAdminSessionHeaders("team-admin-role-post").headers,
      body: JSON.stringify({ label: "escalate", adminRole: "admin" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toBe("Setting adminRole requires a super-admin (admin role, no team)");
  });

  test("PATCH: exact FORBIDDEN envelope when a team-scoped admin sets adminRole on a key it owns", async () => {
    await startApp();
    await reg("svc-mcpkeys-role-patch");
    const { headers, teamId } = teamAdminSessionHeaders("team-admin-role-patch");
    setClientTeam("svc-mcpkeys-role-patch", teamId);
    // The key must be visible to (owned by) the team admin, so this test
    // exercises the adminRole-escalation gate itself, not the ownership check.
    const { id } = await mint({ label: "target", scopes: { clients: ["svc-mcpkeys-role-patch"] } }, headers);
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ adminRole: "admin" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toBe("Setting adminRole requires a super-admin (admin role, no team)");
  });

  test("400 for an invalid adminRole value carries the exact message", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ label: "k", adminRole: "superuser" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("adminRole must be one of admin, operator, auditor, viewer, or null");
  });

  test("PATCH: 400 for an invalid adminRole value carries the exact message", async () => {
    await startApp();
    const { id } = await mint({ label: "target" });
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ adminRole: "superuser" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("adminRole must be one of admin, operator, auditor, viewer, or null");
  });
});

// Regression coverage for the cross-tenant blind-mutate finding: PATCH/revoke/
// DELETE must apply the same `keyVisibleToCaller` visibility GET already uses
// before mutating anything, mirroring schedules.ts/approvals.ts's
// ensureClientAccess pattern. Before the fix, a team-scoped admin could act on
// any key by id (an unscoped key, or one owned by a different team) even
// though GET correctly 404s it — including stripping adminRole/elevated,
// revoking (DoS), deleting, or re-pointing scopes toward its own clients.
describe("tenancy — PATCH/revoke/DELETE can't blind-mutate a key the caller can't see", () => {
  test("PATCH on an unscoped key: a team-scoped admin gets 404, not 200, and the key is untouched", async () => {
    await startApp();
    const { id } = await mint({ label: "target" }); // unscoped — bearer-minted, hidden from every team
    const { headers } = teamAdminSessionHeaders("team-admin-tenancy-patch");
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ label: "renamed" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("MCP_KEY_NOT_FOUND");
    expect(body.error.message).toBe("API key not found");
    expect(getMcpKey(id as number)?.label).toBe("target");
  });

  test("PATCH {adminRole: null} on another team's key: 404, not a silent 200 (the exact reported exploit)", async () => {
    await startApp();
    await reg("svc-mcpkeys-tenancy-role-a");
    const teamA = teamAdminSessionHeaders("team-admin-tenancy-role-a");
    setClientTeam("svc-mcpkeys-tenancy-role-a", teamA.teamId);
    // Team A's own key, carrying a system-role grant (minted by a super-admin, scoped to team A).
    const { id } = await mint({
      label: "team-a-system-key",
      scopes: { clients: ["svc-mcpkeys-tenancy-role-a"] },
      adminRole: "operator",
    });
    const teamB = teamAdminSessionHeaders("team-admin-tenancy-role-b");
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, {
      method: "PATCH",
      headers: teamB.headers,
      body: JSON.stringify({ adminRole: null }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("MCP_KEY_NOT_FOUND");
    expect(getMcpKey(id as number)?.adminRole).toBe("operator"); // untouched
  });

  test("PATCH {elevated: false} on another team's key: 404, not a silent 200 (the exact reported exploit)", async () => {
    await startApp();
    await reg("svc-mcpkeys-tenancy-elev-a");
    const teamA = teamAdminSessionHeaders("team-admin-tenancy-elev-a");
    setClientTeam("svc-mcpkeys-tenancy-elev-a", teamA.teamId);
    const { id } = await mint({
      label: "team-a-elevated-key",
      scopes: { clients: ["svc-mcpkeys-tenancy-elev-a"] },
      elevated: true,
    });
    const teamB = teamAdminSessionHeaders("team-admin-tenancy-elev-b");
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, {
      method: "PATCH",
      headers: teamB.headers,
      body: JSON.stringify({ elevated: false }),
    });
    expect(res.status).toBe(404);
    expect(getMcpKey(id as number)?.elevated).toBe(true); // untouched
  });

  test("PATCH {scopes} can't re-point another team's key toward the caller's own clients", async () => {
    await startApp();
    await reg("svc-mcpkeys-tenancy-repoint-a");
    await reg("svc-mcpkeys-tenancy-repoint-b");
    const teamA = teamAdminSessionHeaders("team-admin-tenancy-repoint-a");
    setClientTeam("svc-mcpkeys-tenancy-repoint-a", teamA.teamId);
    const { id } = await mint({ label: "team-a-key", scopes: { clients: ["svc-mcpkeys-tenancy-repoint-a"] } });
    const teamB = teamAdminSessionHeaders("team-admin-tenancy-repoint-b");
    setClientTeam("svc-mcpkeys-tenancy-repoint-b", teamB.teamId);
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, {
      method: "PATCH",
      headers: teamB.headers,
      body: JSON.stringify({ scopes: { clients: ["svc-mcpkeys-tenancy-repoint-b"] } }),
    });
    expect(res.status).toBe(404);
    expect(getMcpKey(id as number)?.scopes).toEqual({ clients: ["svc-mcpkeys-tenancy-repoint-a"] }); // untouched
  });

  test("revoke: a team-scoped admin can't revoke (DoS) a key it can't see", async () => {
    await startApp();
    const { id } = await mint({ label: "target" }); // unscoped
    const { headers } = teamAdminSessionHeaders("team-admin-tenancy-revoke");
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}/revoke`, { method: "POST", headers });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("MCP_KEY_NOT_FOUND");
    expect(getMcpKey(id as number)?.revokedAt).toBeNull();
  });

  test("DELETE: a team-scoped admin can't permanently delete another team's key", async () => {
    await startApp();
    await reg("svc-mcpkeys-tenancy-delete-a");
    const teamA = teamAdminSessionHeaders("team-admin-tenancy-delete-a");
    setClientTeam("svc-mcpkeys-tenancy-delete-a", teamA.teamId);
    const { id } = await mint({ label: "team-a-key", scopes: { clients: ["svc-mcpkeys-tenancy-delete-a"] } });
    const teamB = teamAdminSessionHeaders("team-admin-tenancy-delete-b");
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, { method: "DELETE", headers: teamB.headers });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("MCP_KEY_NOT_FOUND");
    expect(getMcpKey(id as number)).not.toBeNull(); // still exists
  });

  test("PATCH/revoke/DELETE still work normally for a super-admin (bearer) on any key", async () => {
    await startApp();
    const { id } = await mint({ label: "target" });
    const patched = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ label: "renamed" }),
    });
    expect(patched.status).toBe(200);
    const revoked = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}/revoke`, { method: "POST", headers: bearer() });
    expect(revoked.status).toBe(200);
    const deleted = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, { method: "DELETE", headers: bearer() });
    expect(deleted.status).toBe(200);
    expect(getMcpKey(id as number)).toBeNull();
  });
});

describe("keyVisibleToCaller — GET /admin-api/mcp-keys team-scoping (commit 5f32ffb)", () => {
  // Regression coverage: a team-scoped admin session must only see keys whose
  // scopes.clients resolve entirely to their own team, and never a key
  // carrying adminRole — while a super-admin/bearer session still sees
  // everything unfiltered. Keys are created directly via createMcpKey
  // (bypassing the route's own scope-confinement validation) so the test
  // isolates keyVisibleToCaller's filtering logic specifically.
  test("a team-scoped caller sees only their own scoped key, never a foreign-scoped or adminRole key", async () => {
    await startApp();
    await reg("svc-mcpkeys-own");
    await reg("svc-mcpkeys-foreign");
    const caller = createTeamAdminSession("mcpkeys-list-caller");
    setClientTeam("svc-mcpkeys-own", caller.teamId);
    const otherTeam = createTeam("team-mcpkeys-list-other", "test");
    if (typeof otherTeam === "string") throw new Error("createTeam failed");
    setClientTeam("svc-mcpkeys-foreign", otherTeam.id);

    const { record: ownKey } = createMcpKey("own-key", { clients: ["svc-mcpkeys-own"] }, null, "test");
    const { record: foreignKey } = createMcpKey("foreign-key", { clients: ["svc-mcpkeys-foreign"] }, null, "test");
    const { record: adminKey } = createMcpKey(
      "admin-key",
      { clients: ["svc-mcpkeys-own"] },
      null,
      "test",
      null,
      false,
      "viewer",
    );

    const res = await fetch(`${baseUrl}/admin-api/mcp-keys`, { headers: caller.headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: number }[] };
    const ids = body.items.map((i) => i.id);
    expect(ids).toContain(ownKey.id);
    expect(ids).not.toContain(foreignKey.id);
    expect(ids).not.toContain(adminKey.id);

    // A super-admin/bearer caller still sees every key, unfiltered.
    const allRes = await fetch(`${baseUrl}/admin-api/mcp-keys`, { headers: bearer() });
    const allBody = (await allRes.json()) as { items: { id: number }[] };
    const allIds = allBody.items.map((i) => i.id);
    expect(allIds).toEqual(expect.arrayContaining([ownKey.id, foreignKey.id, adminKey.id]));
  });
});

describe("keyVisibleToCaller — GET /admin-api/mcp-keys/:id team-scoping (commit 5f32ffb)", () => {
  test("a team-scoped caller gets 200 for their own key and the exact MCP_KEY_NOT_FOUND 404 for another team's key", async () => {
    await startApp();
    await reg("svc-mcpkeys-single-own");
    await reg("svc-mcpkeys-single-foreign");
    const caller = createTeamAdminSession("mcpkeys-single-caller");
    setClientTeam("svc-mcpkeys-single-own", caller.teamId);
    const otherTeam = createTeam("team-mcpkeys-single-other", "test");
    if (typeof otherTeam === "string") throw new Error("createTeam failed");
    setClientTeam("svc-mcpkeys-single-foreign", otherTeam.id);

    const { record: ownKey } = createMcpKey("single-own-key", { clients: ["svc-mcpkeys-single-own"] }, null, "test");
    const { record: foreignKey } = createMcpKey(
      "single-foreign-key",
      { clients: ["svc-mcpkeys-single-foreign"] },
      null,
      "test",
    );

    const ownRes = await fetch(`${baseUrl}/admin-api/mcp-keys/${ownKey.id}`, { headers: caller.headers });
    expect(ownRes.status).toBe(200);
    expect(((await ownRes.json()) as { id: number }).id).toBe(ownKey.id);

    const foreignRes = await fetch(`${baseUrl}/admin-api/mcp-keys/${foreignKey.id}`, { headers: caller.headers });
    expect(foreignRes.status).toBe(404);
    const body = (await foreignRes.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("MCP_KEY_NOT_FOUND");
    expect(body.error.message).toBe("API key not found");

    // A super-admin/bearer caller still sees the foreign key unfiltered.
    const bearerRes = await fetch(`${baseUrl}/admin-api/mcp-keys/${foreignKey.id}`, { headers: bearer() });
    expect(bearerRes.status).toBe(200);
  });
});
