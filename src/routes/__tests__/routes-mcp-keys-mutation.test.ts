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
import { createUser } from "../../security/user-store.js";
import { createSession } from "../../security/session-store.js";
import { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } from "../../security/cookies.js";
import { createTeam, setUserTeam } from "../../admin/entities/teams.js";
import { createConsumer } from "../../admin/entities/consumers.js";
import { getMcpKey } from "../../security/mcp-key-store.js";
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
function teamAdminSessionHeaders(username: string): Record<string, string> {
  const team = createTeam(`team-${username}`, "test");
  if (typeof team === "string") throw new Error(`createTeam failed: ${team}`);
  const user = createUser(username, "irrelevant-hash", "admin", null);
  setUserTeam(user.username, team.id);
  const session = createSession(user.id, "127.0.0.1", "test-agent");
  return {
    "Content-Type": "application/json",
    Cookie: `${SESSION_COOKIE_NAME}=${session.token}; ${CSRF_COOKIE_NAME}=${session.csrfToken}`,
    "X-CSRF-Token": session.csrfToken,
  };
}

async function mint(body: Record<string, unknown> = { label: "k" }): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
    method: "POST",
    headers: bearer(),
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
}

afterEach(async () => {
  await stopServer();
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
      headers: teamAdminSessionHeaders("team-admin-elev"),
      body: JSON.stringify({ label: "escalate", elevated: true }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toBe("Setting elevated requires a super-admin (admin role, no team)");
  });

  test("POST: a truthy-but-non-boolean elevated value is treated as false (=== true, not type coercion) and bypasses the super-admin gate", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
      method: "POST",
      headers: teamAdminSessionHeaders("team-admin-elev2"),
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

  test("PATCH: a team-scoped admin cannot set elevated true (403), but a super-admin can", async () => {
    await startApp();
    const { id } = await mint({ label: "target" });

    const forbiddenRes = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, {
      method: "PATCH",
      headers: teamAdminSessionHeaders("team-admin-elev3"),
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

  test("PATCH: a team-scoped admin CAN set elevated false (the super-admin gate only guards the truthy branch)", async () => {
    await startApp();
    // Mint with elevated already true (as a super-admin) so setting it false is a real change.
    const { id } = await mint({ label: "target", elevated: true });
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, {
      method: "PATCH",
      headers: teamAdminSessionHeaders("team-admin-elev4"),
      body: JSON.stringify({ elevated: false }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { elevated: boolean }).elevated).toBe(false);
  });
});

describe("adminRole — explicit null is not gated (only a non-null grant is)", () => {
  test("PATCH: a team-scoped admin can explicitly clear adminRole to null", async () => {
    await startApp();
    const { id } = await mint({ label: "target" }); // adminRole already null
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, {
      method: "PATCH",
      headers: teamAdminSessionHeaders("team-admin-role-null"),
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
      headers: teamAdminSessionHeaders("team-admin-role-post"),
      body: JSON.stringify({ label: "escalate", adminRole: "admin" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toBe("Setting adminRole requires a super-admin (admin role, no team)");
  });

  test("PATCH: exact FORBIDDEN envelope when a team-scoped admin sets adminRole", async () => {
    await startApp();
    const { id } = await mint({ label: "target" });
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, {
      method: "PATCH",
      headers: teamAdminSessionHeaders("team-admin-role-patch"),
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
