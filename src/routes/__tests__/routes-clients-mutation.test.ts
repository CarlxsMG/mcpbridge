/**
 * Stryker mutation-testing backstop for src/routes/admin/clients.ts —
 * domain 8. Baseline: 128 mutants, 59 killed / 69 survived — the existing
 * `routes-admin.test.ts` (left untouched here) covers the list/detail/PATCH/
 * bulk-PATCH happy paths and a handful of 404s at a basic level, but never
 * exercises the status/enabled/cursor/teamId query-filter ternaries with a
 * non-string (repeated-key) fixture, never exercises team-scoped cross-team
 * denial on GET/PATCH/DELETE (each an independent `ensureClientAccess` call
 * site), never exercises the disable (enabled=false) branch's own audit
 * action, never exercises the guards-update sub-mutation's failure/not-found
 * branches, never exercises bulk-PATCH's validation-failure branches or its
 * per-name conditional audit, and never asserts exact codes/messages/audit
 * details anywhere. All line:col citations below were read directly from
 * reports/mutation/result.json.
 *
 * One survivor is an accepted EQUIVALENT, not chased with a dedicated
 * test: the `teamId` ternary's (`typeof teamId === "number" ? teamId :
 * undefined`) forced-true direction. `registry.listClientsSummary`'s own
 * query-building code re-validates `typeof opts.teamId === "number"`
 * before ever using it as a SQL filter param (confirmed by reading
 * `src/mcp/registry.ts` directly) — so whatever non-number value this
 * route passes through (raw `null`/`undefined` from `callerTeamId`, or
 * anything else under the mutant) is treated identically by the
 * downstream consumer. There is no reachable caller/value combination
 * where the route's own type-narrowing changes the final query.
 */
import { describe, test, expect, spyOn } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { createUser } from "../../security/user-store.js";
import { createSession } from "../../security/session-store.js";
import { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } from "../../security/cookies.js";
import { createTeam, setUserTeam, setClientTeam } from "../../admin/entities/teams.js";
import * as auditMod from "../../admin/audit/audit.js";

const ADMIN_KEY = "test-admin-key-clients-mut";

async function startApp(): Promise<{ baseUrl: string; server: Server }> {
  __resetDbForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  const { adminRoutes } = await import("../../routes/admin.js");
  const app = express();
  app.use(express.json());
  adminRoutes(app);
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      resolve({ baseUrl: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, server: srv });
    });
    srv.on("error", reject);
  });
}

function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" };
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

async function withApp(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const { baseUrl, server } = await startApp();
  try {
    await fn(baseUrl);
  } finally {
    for (const c of registry.listClients()) await registry.unregister(c.name);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("GET /admin-api/clients — query filters", () => {
  // Kills 3 (the `q` ternary's forced-true direction): a repeated query
  // key becomes an array (non-string), which must be ignored rather than
  // passed through raw to the registry query.
  test("a non-string ?q value (repeated query key) is ignored, not crashing the request", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-clients-q-a");
      const res = await fetch(`${baseUrl}/admin-api/clients?q=a&q=b`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[] };
      expect(body.items.length).toBeGreaterThan(0);
    });
  });

  // Kills 7/8/9/10 (the `status` ternary's forced/equality/string
  // directions) via a genuine narrowing assertion -- registry's
  // `listClientsSummary` post-filters in-memory on `opts.status`
  // (`items.filter(i => i.status === opts.status)`), so a "doesn't crash"
  // check alone can't distinguish real filtering from the forced-false/
  // emptied-string directions, which silently drop the filter entirely.
  test("?status=<value> narrows the listing to that status only", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-clients-status-healthy");
      await reg("svc-clients-status-degraded");
      registry.markClientStatus("svc-clients-status-degraded", "degraded");
      const res = await fetch(`${baseUrl}/admin-api/clients?status=degraded`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: { name: string }[] };
      const names = body.items.map((i) => i.name);
      expect(names).toContain("svc-clients-status-degraded");
      expect(names).not.toContain("svc-clients-status-healthy");
    });
  });

  test("a non-string ?status value (repeated query key) is ignored, not crashing the request", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-clients-status-b");
      const res = await fetch(`${baseUrl}/admin-api/clients?status=a&status=b`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[] };
      expect(body.items.length).toBeGreaterThan(0);
    });
  });

  // Kills 11/12/13/14/15/17/19/20 (the 3-way `enabled` ternary's forced/
  // equality/string directions) via both real values and an unrecognized
  // one that must fall through to "no filter."
  test("?enabled=true narrows to enabled clients only", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-clients-enabled-true");
      await reg("svc-clients-enabled-false");
      await registry.setClientEnabled("svc-clients-enabled-false", false);
      const res = await fetch(`${baseUrl}/admin-api/clients?enabled=true`, { headers: bearer() });
      const body = (await res.json()) as { items: { name: string }[] };
      expect(body.items.map((i) => i.name)).toContain("svc-clients-enabled-true");
      expect(body.items.map((i) => i.name)).not.toContain("svc-clients-enabled-false");
    });
  });

  test("?enabled=false narrows to disabled clients only", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-clients-enabled-true2");
      await reg("svc-clients-enabled-false2");
      await registry.setClientEnabled("svc-clients-enabled-false2", false);
      const res = await fetch(`${baseUrl}/admin-api/clients?enabled=false`, { headers: bearer() });
      const body = (await res.json()) as { items: { name: string }[] };
      expect(body.items.map((i) => i.name)).toContain("svc-clients-enabled-false2");
      expect(body.items.map((i) => i.name)).not.toContain("svc-clients-enabled-true2");
    });
  });

  test("an unrecognized ?enabled value is ignored, not treated as a real filter", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-clients-enabled-bogus");
      const res = await fetch(`${baseUrl}/admin-api/clients?enabled=bogus`, { headers: bearer() });
      const body = (await res.json()) as { items: unknown[] };
      expect(body.items.length).toBeGreaterThan(0);
    });
  });

  // Kills 21/22/23/24 (the `cursor` ternary's forced/equality/string
  // directions) via genuine pagination across two pages -- a "doesn't
  // crash" check on a non-string cursor can't distinguish real cursor
  // handling from the forced-false/emptied-string directions, which
  // silently ignore any cursor (real or not).
  test("?cursor=<nextCursor> paginates to a genuinely different second page", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-clients-cursor-1");
      await reg("svc-clients-cursor-2");
      const page1 = (await (await fetch(`${baseUrl}/admin-api/clients?limit=1`, { headers: bearer() })).json()) as {
        items: { name: string }[];
        nextCursor?: string;
      };
      expect(page1.items).toHaveLength(1);
      expect(page1.nextCursor).toBeDefined();
      const page2 = (await (
        await fetch(`${baseUrl}/admin-api/clients?limit=1&cursor=${page1.nextCursor}`, { headers: bearer() })
      ).json()) as { items: { name: string }[] };
      expect(page2.items).toHaveLength(1);
      expect(page2.items[0].name).not.toBe(page1.items[0].name);
    });
  });

  test("a non-string ?cursor value (repeated query key) is ignored, not crashing the request", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-clients-cursor-a");
      const res = await fetch(`${baseUrl}/admin-api/clients?cursor=a&cursor=b`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[] };
      expect(body.items.length).toBeGreaterThan(0);
    });
  });

  // Regression test: `Number("abc")` is NaN, and `NaN ?? 50` is still NaN
  // (`??` only falls back on null/undefined) — without a Number.isFinite
  // guard in registry-read-models.ts's inline limit-clamp, this NaN would
  // reach bun:sqlite as a `LIMIT ?` param and throw a raw 'datatype mismatch'
  // 500 instead of clamping to the default.
  test("a malformed ?limit= value (NaN) is clamped to the default instead of crashing the request", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-clients-limit-nan");
      const res = await fetch(`${baseUrl}/admin-api/clients?limit=abc`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[] };
      expect(body.items.length).toBeGreaterThan(0);
    });
  });

  // Kills 29/30/31/32 (the `teamId` ternary's forced/equality/string
  // directions): a team-scoped session must only see its own team's
  // clients, while a bearer/super-admin caller sees everything.
  test("a team-scoped session only sees its own team's clients", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-clients-team-mine");
      await reg("svc-clients-team-other");
      const { headers, teamId } = teamSessionHeaders("clients-team-user");
      setClientTeam("svc-clients-team-mine", teamId);
      const res = await fetch(`${baseUrl}/admin-api/clients`, { headers });
      const body = (await res.json()) as { items: { name: string }[] };
      const names = body.items.map((i) => i.name);
      expect(names).toContain("svc-clients-team-mine");
      expect(names).not.toContain("svc-clients-team-other");
    });
  });

  test("a bearer caller sees clients across all teams", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-clients-team-a");
      await reg("svc-clients-team-b");
      const otherTeam = createTeam("team-clients-bearer-scope", "test");
      if (typeof otherTeam === "string") throw new Error("createTeam failed");
      setClientTeam("svc-clients-team-b", otherTeam.id);
      const res = await fetch(`${baseUrl}/admin-api/clients`, { headers: bearer() });
      const body = (await res.json()) as { items: { name: string }[] };
      const names = body.items.map((i) => i.name);
      expect(names).toContain("svc-clients-team-a");
      expect(names).toContain("svc-clients-team-b");
    });
  });
});

describe("GET /admin-api/clients/:name", () => {
  // Kills 37 (the ensureClientAccess guard's forced-false direction) --
  // GET detail's OWN independent copy of the cross-team-denial check.
  test("a session caller from a different team gets the exact CLIENT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-clients-detail-denied");
      const otherTeam = createTeam("team-clients-detail-denied", "test");
      if (typeof otherTeam === "string") throw new Error("createTeam failed");
      setClientTeam("svc-clients-detail-denied", otherTeam.id);
      const { headers } = teamSessionHeaders("clients-detail-denied-user");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-clients-detail-denied`, { headers });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
    });
  });

  // Kills 42/43 (the CLIENT_NOT_FOUND code/message emptied) -- the
  // existing "404 for unknown client" test only checks the status.
  test("an unknown client returns the exact CLIENT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-clients-never-registered`, { headers: bearer() });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
      expect(body.error.message).toBe("Client not found");
    });
  });
});

describe("PATCH /admin-api/clients/:name — enabled", () => {
  // Kills 48 (PATCH's OWN independent copy of the ensureClientAccess
  // guard).
  test("a session caller from a different team gets the exact CLIENT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-clients-patch-denied");
      const otherTeam = createTeam("team-clients-patch-denied", "test");
      if (typeof otherTeam === "string") throw new Error("createTeam failed");
      setClientTeam("svc-clients-patch-denied", otherTeam.id);
      const { headers } = teamSessionHeaders("clients-patch-denied-user");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-clients-patch-denied`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
    });
  });

  // Kills 59 (the "enabled must be a boolean" message emptied).
  test("a non-boolean enabled value fails validation with the exact message", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-clients-patch-badtype");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-clients-patch-badtype`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ enabled: "true" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("enabled must be a boolean");
    });
  });

  // Kills 64/65 (the enabled-toggle's own CLIENT_NOT_FOUND code/message
  // emptied) via an unknown client name.
  test("toggling enabled on an unknown client returns the exact CLIENT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-clients-patch-never-registered`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
      expect(body.error.message).toBe("Client not found");
    });
  });

  // Kills 66 (the ternary's "client.disable" branch emptied) and,
  // combined with the enable test below, 84/85 (the final response
  // object/"updated" literal emptied).
  test("disabling a client is audited with the exact client.disable action", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-clients-patch-disable");
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/clients/svc-clients-patch-disable`, {
          method: "PATCH",
          headers: bearer(),
          body: JSON.stringify({ enabled: false }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; name: string };
        expect(body).toEqual({ status: "updated", name: "svc-clients-patch-disable" });
        expect(spy).toHaveBeenCalledWith(expect.any(String), "client.disable", "svc-clients-patch-disable");
      } finally {
        spy.mockRestore();
      }
    });
  });

  test("enabling a client is audited with the exact client.enable action", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-clients-patch-enable");
      await registry.setClientEnabled("svc-clients-patch-enable", false);
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/clients/svc-clients-patch-enable`, {
          method: "PATCH",
          headers: bearer(),
          body: JSON.stringify({ enabled: true }),
        });
        expect(res.status).toBe(200);
        expect(spy).toHaveBeenCalledWith(expect.any(String), "client.enable", "svc-clients-patch-enable");
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("PATCH /admin-api/clients/:name — guards", () => {
  // Kills 74/75 (the validateClientGuardInput failure branch's
  // conditional/body emptied) via a genuinely invalid guards shape,
  // asserting the validator's OWN message is passed through unchanged.
  test("invalid guards input fails validation with the validator's exact message", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-clients-guards-invalid");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-clients-guards-invalid`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ guards: { circuitBreaker: "not-an-object" } }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("guards.circuitBreaker must be an object");
    });
  });

  // Kills 78/79/80/81 (the guards-update's own CLIENT_NOT_FOUND
  // code/message emptied) via an unknown client name.
  test("updating guards on an unknown client returns the exact CLIENT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-clients-guards-never-registered`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ guards: { circuitBreaker: { failureThreshold: 5 } } }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
      expect(body.error.message).toBe("Client not found");
    });
  });

  // Kills 82/83 (the recordAudit action string and detail object
  // emptied) via a valid guards update.
  test("a valid guards update is audited with the exact action and detail", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-clients-guards-ok");
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/clients/svc-clients-guards-ok`, {
          method: "PATCH",
          headers: bearer(),
          body: JSON.stringify({ guards: { circuitBreaker: { failureThreshold: 5 } } }),
        });
        expect(res.status).toBe(200);
        expect(spy).toHaveBeenCalledWith(expect.any(String), "client.guards.update", "svc-clients-guards-ok", {
          guards: { circuitBreaker: { failureThreshold: 5 } },
        });
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("DELETE /admin-api/clients/:name", () => {
  // Kills 88/89/90 (DELETE's OWN independent copy of the
  // ensureClientAccess guard).
  test("a session caller from a different team gets the exact CLIENT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-clients-delete-denied");
      const otherTeam = createTeam("team-clients-delete-denied", "test");
      if (typeof otherTeam === "string") throw new Error("createTeam failed");
      setClientTeam("svc-clients-delete-denied", otherTeam.id);
      const { headers } = teamSessionHeaders("clients-delete-denied-user");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-clients-delete-denied`, {
        method: "DELETE",
        headers,
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
    });
  });

  // Kills 91/92/93/94/95/96 (the !removed guard's forced/block/exact
  // code+message).
  test("an unknown client returns the exact CLIENT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-clients-delete-never-registered`, {
        method: "DELETE",
        headers: bearer(),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
      expect(body.error.message).toBe("Client not found");
    });
  });

  // Kills 97/98/99 (the recordAudit action string and response
  // object/"deleted" literal emptied).
  test("a successful delete is audited and returns the exact response shape", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-clients-delete-ok");
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/clients/svc-clients-delete-ok`, {
          method: "DELETE",
          headers: bearer(),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; name: string };
        expect(body).toEqual({ status: "deleted", name: "svc-clients-delete-ok" });
        expect(spy).toHaveBeenCalledWith(expect.any(String), "client.delete", "svc-clients-delete-ok");
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("PATCH /admin-api/clients (bulk)", () => {
  // Kills 104-108's cluster via each clause independently.
  test("a non-array names fails validation with the exact message", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/clients`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ names: "not-an-array", enabled: true }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("names (string[]) and enabled (boolean) are required");
    });
  });

  // Kills 109 (`.some()` -> `.every()`) and 110/112 (the predicate
  // arrow/conditional emptied): an array with ONE non-string element
  // among otherwise-valid strings only fails under the real `.some()`
  // semantics -- `.every()` would require ALL elements to be non-string
  // to trigger, so a single bad element wouldn't be caught by the mutant.
  test("a names array containing one non-string element fails validation", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/clients`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ names: ["svc-a", 123, "svc-b"], enabled: true }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  test("a non-boolean enabled fails validation", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/clients`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ names: ["svc-a"], enabled: "true" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // Kills 121/122 (the per-name `results[name]` conditional's forced
  // directions): a mix of one real client and one unknown name proves
  // the audit call fires ONLY for the name that genuinely succeeded.
  test("bulk update audits only the names that actually succeeded", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-clients-bulk-real");
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/clients`, {
          method: "PATCH",
          headers: bearer(),
          body: JSON.stringify({ names: ["svc-clients-bulk-real", "svc-clients-bulk-ghost"], enabled: false }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { results: Record<string, boolean> };
        expect(body.results).toEqual({ "svc-clients-bulk-real": true, "svc-clients-bulk-ghost": false });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith(expect.any(String), "client.disable", "svc-clients-bulk-real", {
          bulk: true,
        });
      } finally {
        spy.mockRestore();
      }
    });
  });

  // Kills 123/124 (the ternary's "client.enable" branch, the opposite
  // direction from the disable test above) and 125/126 (the `{bulk:
  // true}` detail object/BooleanLiteral emptied).
  test("bulk enable is audited with the exact client.enable action and bulk detail", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-clients-bulk-enable");
      await registry.setClientEnabled("svc-clients-bulk-enable", false);
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/clients`, {
          method: "PATCH",
          headers: bearer(),
          body: JSON.stringify({ names: ["svc-clients-bulk-enable"], enabled: true }),
        });
        expect(res.status).toBe(200);
        expect(spy).toHaveBeenCalledWith(expect.any(String), "client.enable", "svc-clients-bulk-enable", {
          bulk: true,
        });
      } finally {
        spy.mockRestore();
      }
    });
  });
});
