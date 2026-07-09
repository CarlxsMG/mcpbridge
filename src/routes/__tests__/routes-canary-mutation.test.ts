/**
 * Stryker mutation-testing backstop for src/routes/admin/canary.ts —
 * domain 8. Baseline: 56 mutants, 0 killed / 56 survived — zero test
 * coverage of any kind existed before this. All line:col citations below
 * were read directly from reports/mutation/result.json.
 *
 * One survivor is an accepted EQUIVALENT mutant, not chased with a
 * dedicated test: 33:20-51 ConditionalExpression 'true' (the weight
 * parser's `typeof body.weight === "number"` guard forced to always take
 * the "use body.weight as-is" branch). Verified empirically
 * (`Number.isInteger("42")`, `Number.isInteger(true)`,
 * `Number.isInteger(null)` all `false`, and a JSON body's numeric field
 * always deserializes to a genuine JS `number` via `JSON.parse`): for
 * ANY reachable non-number `body.weight` value, real code defaults to 0
 * (which fails the downstream `1 <= weight <= 100` check ->
 * INVALID_WEIGHT), while the "always true" mutant instead passes the raw
 * non-number value straight to `Number.isInteger(...)`, which is ALSO
 * always false for a genuine non-number -> ALSO INVALID_WEIGHT. Both
 * produce the identical 400 response for every input reachable over
 * real HTTP; only a genuine number diverges, and both branches already
 * agree on genuine numbers.
 */
import { describe, test, expect, spyOn } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { requestIdMiddleware } from "../../middleware/request-id.js";
import { createUser } from "../../security/user-store.js";
import { createSession } from "../../security/session-store.js";
import { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } from "../../security/cookies.js";
import { createTeam, setUserTeam } from "../../admin/entities/teams.js";
import { setClientTeam } from "../../admin/entities/teams.js";
import * as auditMod from "../../admin/audit/audit.js";
import type { RestToolDefinition } from "../../mcp/types.js";

const ADMIN_KEY = "test-admin-key-canary-mut";

function makeTool(name: string): RestToolDefinition {
  return {
    name,
    method: "GET",
    endpoint: `/${name}`,
    description: "d",
    inputSchema: { type: "object", properties: {} },
  };
}

async function startApp(): Promise<{ baseUrl: string; server: Server }> {
  __resetDbForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  const { adminRoutes } = await import("../../routes/admin.js");
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
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

/** Creates an admin-role session scoped to a real team -- for cross-team-denial tests. */
function teamSessionHeaders(username: string): { headers: Record<string, string>; teamId: number } {
  const team = createTeam(`team-${username}`, "test");
  if (typeof team === "string") throw new Error(`createTeam failed: ${team}`);
  const user = createUser(username, "irrelevant-hash", "admin", null);
  setUserTeam(user.username, team.id);
  const session = createSession(user.id, "127.0.0.1", "test-agent");
  return {
    headers: {
      "Content-Type": "application/json",
      Cookie: `${SESSION_COOKIE_NAME}=${session.token}; ${CSRF_COOKIE_NAME}=${session.csrfToken}`,
      "X-CSRF-Token": session.csrfToken,
    },
    teamId: team.id,
  };
}

async function reg(name: string): Promise<void> {
  await registry.register(
    name,
    [makeTool("t")],
    "http://example.com/health",
    "1.2.3.4",
    "http://example.com",
    "1.2.3.4",
  );
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

describe("GET /admin-api/clients/:name/canary", () => {
  // Kills 18:18-41 StringLiteral (route path emptied) and 18:94-21:2
  // BlockStatement (whole handler emptied).
  test("an unrelated path is not served by canaryRoutes' GET", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/totally-unrelated-path`, { headers: bearer() });
      expect(res.status).toBe(404);
    });
  });

  // Kills 19:7-53 ConditionalExpression 'true' (forces the access guard
  // to always deny) and 20:24-62 ObjectLiteral (the { canary } response
  // wrapper emptied).
  test("a Bearer caller on a known client gets the exact { canary: null } shape", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-canary-get");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-canary-get/canary`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ canary: null });
    });
  });

  // Kills 19:7-53 ConditionalExpression 'false' (forces the access guard
  // to never deny, even for a genuinely cross-team-denied caller).
  test("a session caller from a different team gets the exact CLIENT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-canary-other-team");
      const otherTeam = createTeam("other-team-for-canary-client", "test");
      if (typeof otherTeam === "string") throw new Error("createTeam failed");
      setClientTeam("svc-canary-other-team", otherTeam.id);
      const { headers } = teamSessionHeaders("canary-get-denied-user");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-canary-other-team/canary`, { headers });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
    });
  });
});

describe("PUT /admin-api/clients/:name/tools/:tool/tags — unrelated path", () => {
  // Kills 23:18-41 StringLiteral (route path emptied).
  test("PUT to an unrelated path is not served by canaryRoutes", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/totally-unrelated-path`, { method: "PUT", headers: bearer() });
      expect(res.status).toBe(404);
    });
  });

  // Kills 25:7-42 ConditionalExpression 'false' (forces the PUT access
  // guard to never deny, even for a genuinely cross-team-denied caller)
  // -- the GET describe block above only exercised this for the GET
  // handler's OWN copy of the same guard; the PUT handler has an
  // independent instance of it that needs its own coverage.
  test("a session caller from a different team gets the exact CLIENT_NOT_FOUND 404 on PUT", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-canary-put-other-team");
      const otherTeam = createTeam("other-team-for-canary-put", "test");
      if (typeof otherTeam === "string") throw new Error("createTeam failed");
      setClientTeam("svc-canary-put-other-team", otherTeam.id);
      const { headers } = teamSessionHeaders("canary-put-denied-user");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-canary-put-other-team/canary`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ secondaryBaseUrl: "http://5.6.7.8" }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
    });
  });
});

describe("PUT /admin-api/clients/:name/canary — setting a full config", () => {
  // Kills 23:117-54:2 BlockStatement (whole handler emptied), 25:7-42
  // ConditionalExpression 'true' (access guard always denies), 28:7-27
  // ConditionalExpression 'true' (always treats the request as a clear),
  // 30:10-40:4 BlockStatement (the whole "set" branch emptied, leaving
  // `input` unassigned -> crash), 31:30-71 ConditionalExpression 'false'
  // / StringLiteral '""' ("string" emptied -- secondaryBaseUrl always
  // defaults to "" even for a valid string), 32:18-42 ConditionalExpression
  // 'false' / EqualityOperator / StringLiteral '""' (mode's "failover"
  // check-value or true-branch value broken -- would wrongly become
  // "canary" or ""), 33:20-51 ConditionalExpression 'false' /
  // EqualityOperator / StringLiteral '""' (weight always defaults to 0
  // even for a valid number), 34:21-43 ConditionalExpression 'true' /
  // EqualityOperator / BooleanLiteral 'true' (enabled forced wrong for an
  // explicit false), 35:9-26 ConditionalExpression 'true' / BooleanLiteral
  // (the !secondaryBaseUrl guard wrongly fires for a valid URL),
  // 39:13-56 ObjectLiteral (the input object emptied -> INVALID_MODE
  // instead of success), 43:7-17 ConditionalExpression 'true' /
  // BooleanLiteral (the !result.ok guard wrongly fires for a genuine
  // success), 51:13-79 ObjectLiteral (the audit detail emptied), 53:24-51
  // ObjectLiteral / 53:34-43 StringLiteral (the response body emptied /
  // "updated" literal emptied), and 49:13-32 StringLiteral
  // ("client.canary.set" emptied).
  test("returns 200 with the exact response shape and records the exact audit detail", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-canary-set");
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/clients/svc-canary-set/canary`, {
          method: "PUT",
          headers: bearer(),
          body: JSON.stringify({ secondaryBaseUrl: "http://5.6.7.8", mode: "failover", weight: 42 }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ status: "updated", name: "svc-canary-set" });
        expect(spy).toHaveBeenCalledWith(expect.any(String), "client.canary.set", "svc-canary-set", {
          mode: "failover",
          weight: 42,
          enabled: true,
        });
      } finally {
        spy.mockRestore();
      }
    });
  });

  // Kills 34:21-43 ConditionalExpression 'false' / EqualityOperator /
  // BooleanLiteral 'true' (enabled forced wrong for an explicit false)
  // -- the previous test only exercises the omitted-enabled default.
  test("an explicit enabled: false is honored, not defaulted to true", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-canary-disabled");
      const spy = spyOn(auditMod, "recordAudit");
      try {
        await fetch(`${baseUrl}/admin-api/clients/svc-canary-disabled/canary`, {
          method: "PUT",
          headers: bearer(),
          body: JSON.stringify({ secondaryBaseUrl: "http://5.6.7.8", weight: 10, enabled: false }),
        });
        expect(spy).toHaveBeenCalledWith(expect.any(String), "client.canary.set", "svc-canary-disabled", {
          mode: "canary",
          weight: 10,
          enabled: false,
        });
      } finally {
        spy.mockRestore();
      }
    });
  });

  // Kills 32:18-42 ConditionalExpression 'true' / StringLiteral '""'
  // (32:58-66, "canary" false-branch value emptied) -- an omitted mode
  // must default to "canary", not "failover" or "".
  test("an omitted mode defaults to canary", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-canary-default-mode");
      const spy = spyOn(auditMod, "recordAudit");
      try {
        await fetch(`${baseUrl}/admin-api/clients/svc-canary-default-mode/canary`, {
          method: "PUT",
          headers: bearer(),
          body: JSON.stringify({ secondaryBaseUrl: "http://5.6.7.8", weight: 5 }),
        });
        expect(spy).toHaveBeenCalledWith(expect.any(String), "client.canary.set", "svc-canary-default-mode", {
          mode: "canary",
          weight: 5,
          enabled: true,
        });
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("PUT /admin-api/clients/:name/canary — clearing", () => {
  // Kills 28:7-27 ConditionalExpression 'false' / EqualityOperator
  // (body.canary===null never recognized) and 28:29-30:4 BlockStatement
  // ("input = null" emptied -> input stays unassigned -> crash).
  test("{ canary: null } clears the config with the exact clear audit action", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-canary-clear");
      await fetch(`${baseUrl}/admin-api/clients/svc-canary-clear/canary`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ secondaryBaseUrl: "http://5.6.7.8" }),
      });
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/clients/svc-canary-clear/canary`, {
          method: "PUT",
          headers: bearer(),
          body: JSON.stringify({ canary: null }),
        });
        expect(res.status).toBe(200);
        expect(spy).toHaveBeenCalledWith(expect.any(String), "client.canary.clear", "svc-canary-clear", undefined);
        const after = await (
          await fetch(`${baseUrl}/admin-api/clients/svc-canary-clear/canary`, { headers: bearer() })
        ).json();
        expect(after).toEqual({ canary: null });
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("PUT /admin-api/clients/:name/canary — validation errors", () => {
  // Kills 26:16-59 LogicalOperator (?? -> &&, which would leave `body`
  // undefined instead of falling back to {} when no JSON body is sent,
  // crashing on `body.canary` access instead of a clean 400).
  test("a request with no JSON body returns a clean 400, not a crash", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-canary-nobody");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-canary-nobody/canary`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("secondaryBaseUrl is required (or send { canary: null } to clear)");
    });
  });

  // Kills 31:30-71 ConditionalExpression 'true' / EqualityOperator /
  // StringLiteral '"Stryker was here!"' (the fallback "" replaced with a
  // truthy placeholder, which would let a non-string secondaryBaseUrl
  // slip past the required-check instead of being rejected) and
  // 35:9-26 ConditionalExpression 'false' / BlockStatement (the
  // required-check never firing) and 36:28-94 StringLiteral (the exact
  // message emptied).
  test("a non-string secondaryBaseUrl returns the exact required-field 400", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-canary-nonstring-url");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-canary-nonstring-url/canary`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ secondaryBaseUrl: 12345 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("secondaryBaseUrl is required (or send { canary: null } to clear)");
    });
  });

  // Kills 43:7-17 ConditionalExpression 'false' / BooleanLiteral
  // (the !result.ok error-handling guard never firing for a genuine
  // CLIENT_NOT_FOUND failure), 43:19-46:4 BlockStatement (the
  // error-handling block emptied), 44:20-55 ConditionalExpression
  // 'false' / EqualityOperator / StringLiteral (the 404-vs-400 status
  // mapping broken), and 44:83-112 LogicalOperator (result.reason ??
  // result.error -> &&, which would produce `undefined` as the message
  // for an error with no reason field, like CLIENT_NOT_FOUND).
  test("an unknown client returns the exact CLIENT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/clients/no-such-client/canary`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ secondaryBaseUrl: "http://5.6.7.8" }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
      expect(body.error.message).toBe("CLIENT_NOT_FOUND");
    });
  });

  // Kills 44:20-55 ConditionalExpression 'true' (the 404-vs-400 mapping
  // wrongly forced to 404 for a non-CLIENT_NOT_FOUND error).
  test("an out-of-range weight returns the exact INVALID_WEIGHT 400 (not 404)", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-canary-badweight");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-canary-badweight/canary`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ secondaryBaseUrl: "http://5.6.7.8", weight: 999 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("INVALID_WEIGHT");
      expect(body.error.message).toBe("INVALID_WEIGHT");
    });
  });

  // Kills 44:83-112 LogicalOperator's OTHER direction: when result.reason
  // IS present (INVALID_URL always carries one), `??` must use the
  // reason text, not `&&`'s wrongly-selected result.error code.
  test("a malformed secondaryBaseUrl returns the exact underlying reason as the message", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-canary-badurl");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-canary-badurl/canary`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ secondaryBaseUrl: "not a valid url", weight: 50 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("INVALID_URL");
      expect(body.error.message).toBe("Invalid URL");
    });
  });
});
