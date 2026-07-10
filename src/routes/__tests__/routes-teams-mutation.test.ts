/**
 * Stryker mutation-testing backstop for src/routes/teams.ts — domain 8.
 * Baseline: 97 mutants, 0 killed / 97 survived — zero test coverage of any
 * kind existed before this. All line:col citations below were read directly
 * from reports/mutation/result.json.
 */
import { describe, test, expect, spyOn } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { requestIdMiddleware } from "../../middleware/request-id.js";
import { createTeam } from "../../admin/entities/teams.js";
import { createUser } from "../../security/user-store.js";
import * as auditMod from "../../admin/audit/audit.js";

const ADMIN_KEY = "test-admin-key-teams-mut";

async function startApp(): Promise<{ baseUrl: string; server: Server }> {
  __resetDbForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  const { teamRoutes } = await import("../../routes/teams.js");
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  teamRoutes(app);
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

function seedTeam(name: string) {
  const result = createTeam(name, "seed");
  if (typeof result === "string") throw new Error(`seedTeam failed: ${result}`);
  return result;
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

describe("GET /admin-api/teams", () => {
  // Kills 0 (whole teamRoutes body emptied), 1 (route path emptied), 2
  // (handler body emptied), and 3 (the { items } wrapper emptied).
  test("lists every recorded team", async () => {
    await withApp(async (baseUrl) => {
      seedTeam("svc-teams-list");
      const res = await fetch(`${baseUrl}/admin-api/teams`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[] };
      expect(body.items.length).toBeGreaterThan(0);
    });
  });
});

describe("POST /admin-api/teams", () => {
  // Kills 6 LogicalOperator (?? -> &&): with no Content-Type/body at all,
  // req.body is undefined; `??` falls back to {} and validation fails
  // gracefully, while `&&` would leave body undefined and crash on
  // `body.name`.
  test("no request body at all is a graceful validation error, not a crash", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/teams`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // Kills 13/14/15 (the `!name` negation/conditional cluster's "always
  // invalid" directions), 16 (the validation-error branch emptied), and 17
  // (the exact message emptied).
  test("a missing name fails validation with the exact message", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/teams`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("name is required");
    });
  });

  // Kills 7/9/10 (the typeof-string ternary's forced-true/equality/string
  // directions -- forced-true would call `.trim()` on a non-string,
  // throwing instead of gracefully validating) and 12 (the fallback ""
  // literal replaced with a truthy placeholder, which would wrongly pass
  // validation).
  test("a non-string name fails validation (coerced to empty, not passed through)", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/teams`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: 123 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("name is required");
    });
  });

  // Kills 11 MethodExpression (the `.trim()` call dropped): a name with
  // leading/trailing whitespace must still validate and create, since the
  // untrimmed raw string (leading space) fails ADMIN_ENTITY_NAME_RE's
  // "must start with alphanumeric" rule.
  test("a name with leading/trailing whitespace is trimmed before validation", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/teams`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "  Trim Team  " }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { name: string };
      expect(body.name).toBe("Trim Team");
    });
  });

  // Kills 18/19/20 (the INVALID_NAME conditional/equality cluster's
  // "never invalid" directions) and 21/23/24 (the exact code/message
  // literals emptied) via a name that passes `!name` but fails the
  // entity-name pattern (must start with alphanumeric).
  test("a name failing the entity-name pattern returns the exact INVALID_NAME 400", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/teams`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "@invalid" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("INVALID_NAME");
      expect(body.error.message).toBe("Team name must be 1-63 chars: letters, digits, space, - or _");
    });
  });

  // Kills 25/26/27 (the ALREADY_EXISTS conditional/equality cluster's
  // "never triggers" directions) and 28/30/31 (the exact code/message
  // literals emptied).
  test("creating a duplicate team name returns the exact ALREADY_EXISTS 409", async () => {
    await withApp(async (baseUrl) => {
      seedTeam("svc-teams-dup");
      const res = await fetch(`${baseUrl}/admin-api/teams`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "svc-teams-dup" }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("ALREADY_EXISTS");
      expect(body.error.message).toBe("A team with that name already exists");
    });
  });

  // Kills 4/5 (route path/handler body emptied), the complements of
  // 8/18/19/20/25/26/27 (a fully valid request must succeed, not be wrongly
  // rejected), and 32/33/34 (the recordAudit action/target/detail literals
  // emptied).
  test("a fully valid team name is created, audited, and returned", async () => {
    await withApp(async (baseUrl) => {
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/teams`, {
          method: "POST",
          headers: bearer(),
          body: JSON.stringify({ name: "svc-teams-create-ok" }),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { id: number; name: string };
        expect(body.name).toBe("svc-teams-create-ok");
        expect(spy).toHaveBeenCalledWith(expect.any(String), "team.create", `team:${body.id}`, {
          name: "svc-teams-create-ok",
        });
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("DELETE /admin-api/teams/:id", () => {
  // Kills 35/36 (route path/handler body emptied), 37/38/39 (the !ok
  // guard's negation-removed/forced true/false directions), 40 (the
  // not-found branch body emptied), and 41/42 (the exact code/message
  // emptied).
  test("an unknown team id returns the exact TEAM_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/teams/999999`, { method: "DELETE", headers: bearer() });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("TEAM_NOT_FOUND");
      expect(body.error.message).toBe("Team not found");
    });
  });

  // Kills the success-path complement of 37/38/39, 43/44 (the audit
  // action/target literals emptied), and 45/46 (the response object and
  // "deleted" literal emptied) -- verified both via the response body and
  // a follow-up GET proving the team was genuinely removed.
  test("a known team id is deleted, audited, and absent from a follow-up GET", async () => {
    await withApp(async (baseUrl) => {
      const t = seedTeam("svc-teams-delete-ok");
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/teams/${t.id}`, { method: "DELETE", headers: bearer() });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; id: number };
        expect(body).toEqual({ status: "deleted", id: t.id });
        expect(spy).toHaveBeenCalledWith(expect.any(String), "team.delete", `team:${t.id}`);
        const get = (await (await fetch(`${baseUrl}/admin-api/teams`, { headers: bearer() })).json()) as {
          items: { id: number }[];
        };
        expect(get.items.some((i) => i.id === t.id)).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("PUT /admin-api/clients/:name/team", () => {
  // Kills 51 (the `body.teamId === null` conditional forced-false, which
  // would wrongly treat a genuine null as invalid) and 57/58/59 (the
  // `teamId === undefined` cluster's "always invalid" direction).
  test("teamId=null clears a client's team assignment", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-teams-client-clear");
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/clients/svc-teams-client-clear/team`, {
          method: "PUT",
          headers: bearer(),
          body: JSON.stringify({ teamId: null }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; name: string; teamId: number | null };
        expect(body).toEqual({ status: "updated", name: "svc-teams-client-clear", teamId: null });
        expect(spy).toHaveBeenCalledWith(expect.any(String), "client.team.set", "svc-teams-client-clear", {
          teamId: null,
        });
      } finally {
        spy.mockRestore();
      }
    });
  });

  // Kills 50 (the `body.teamId === null` conditional forced-true, which
  // would wrongly null out a genuine numeric assignment), 53/54/55/56 (the
  // inner typeof-number cluster's "always undefined" directions).
  test("teamId=<number> assigns a client to that team", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-teams-client-assign");
      const t = seedTeam("svc-teams-client-assign-team");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-teams-client-assign/team`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ teamId: t.id }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { teamId: number | null };
      expect(body.teamId).toBe(t.id);
    });
  });

  // Kills 53 (forced-true on the inner typeof check, which would let a
  // non-number teamId pass through unvalidated) and 60/61 (the
  // validation-error branch body/message).
  test("a non-number, non-null teamId fails validation with the exact message", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-teams-client-badtype");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-teams-client-badtype/team`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ teamId: "not-a-number" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("teamId must be a number or null");
    });
  });

  // Kills 62/63/64 (the !ok guard's negation-removed/forced directions),
  // 65 (the not-found branch body emptied), and 66/67 (the exact
  // code/message emptied).
  test("an unknown client returns the exact NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-teams-never-registered/team`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ teamId: 999999 }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("NOT_FOUND");
      expect(body.error.message).toBe("Client or team not found");
    });
  });
});

describe("PUT /admin-api/users/:username/team", () => {
  // Independent copy of the client-team guard -- same "same guard,
  // multiple call sites" reasoning as canary.ts/traffic.ts/audit-log.ts:
  // coverage on the client-team route does not imply coverage here.
  test("teamId=null clears a user's team assignment", async () => {
    await withApp(async (baseUrl) => {
      const user = createUser("teams-mut-user-clear", "irrelevant-hash", "admin", null);
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/users/${user.username}/team`, {
          method: "PUT",
          headers: bearer(),
          body: JSON.stringify({ teamId: null }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; username: string; teamId: number | null };
        expect(body).toEqual({ status: "updated", username: user.username, teamId: null });
        expect(spy).toHaveBeenCalledWith(expect.any(String), "user.team.set", user.username, { teamId: null });
      } finally {
        spy.mockRestore();
      }
    });
  });

  test("teamId=<number> assigns a user to that team", async () => {
    await withApp(async (baseUrl) => {
      const user = createUser("teams-mut-user-assign", "irrelevant-hash", "admin", null);
      const t = seedTeam("svc-teams-user-assign-team");
      const res = await fetch(`${baseUrl}/admin-api/users/${user.username}/team`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ teamId: t.id }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { teamId: number | null };
      expect(body.teamId).toBe(t.id);
    });
  });

  test("a non-number, non-null teamId fails validation with the exact message", async () => {
    await withApp(async (baseUrl) => {
      const user = createUser("teams-mut-user-badtype", "irrelevant-hash", "admin", null);
      const res = await fetch(`${baseUrl}/admin-api/users/${user.username}/team`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ teamId: true }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("teamId must be a number or null");
    });
  });

  test("an unknown user returns the exact NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/users/never-registered-user/team`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ teamId: 999999 }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("NOT_FOUND");
      expect(body.error.message).toBe("User or team not found");
    });
  });
});
