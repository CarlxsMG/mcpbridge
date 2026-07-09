/**
 * Stryker mutation-testing backstop for src/routes/admin/oauth.ts —
 * domain 8. Baseline: 57 mutants, 0 killed / 57 survived — zero test
 * coverage of any kind existed before this. All line:col citations below
 * were read directly from reports/mutation/result.json.
 *
 * Structurally almost identical to admin/canary.ts (same session,
 * already closed): GET/PUT /clients/:name/oauth, ensureClientAccess
 * guard on each handler independently, a set-of-typeof-string-ternaries
 * parsing pattern, an oauth:null clear branch, and a
 * result.reason ?? result.error fallback. Reuses that file's established
 * techniques throughout.
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
import type { RestToolDefinition } from "../../mcp/types.js";

const ADMIN_KEY = "test-admin-key-oauth-mut";

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

function teamSessionHeaders(username: string): Record<string, string> {
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

const originalSecretKey = config.secretEncryptionKey;
function configureSecretsProvider(): void {
  (config as Record<string, unknown>).secretEncryptionKey = Buffer.alloc(32, 7).toString("base64");
}
function unconfigureSecretsProvider(): void {
  (config as Record<string, unknown>).secretEncryptionKey = originalSecretKey;
}

async function withApp(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const { baseUrl, server } = await startApp();
  try {
    await fn(baseUrl);
  } finally {
    for (const c of registry.listClients()) await registry.unregister(c.name);
    unconfigureSecretsProvider();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("GET /admin-api/clients/:name/oauth", () => {
  // Kills 30:17-39 StringLiteral (route path emptied) and 30:92-33:2
  // BlockStatement (whole handler emptied) and 32:24-66 ObjectLiteral
  // (the { oauth } response wrapper emptied) and 31:7-53
  // ConditionalExpression 'true' (access guard always denies).
  test("a Bearer caller on a known client gets the exact { oauth: null } shape", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-oauth-get");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-oauth-get/oauth`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ oauth: null });
    });
  });

  test("an unrelated path is not served by oauthRoutes' GET", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/totally-unrelated-path`, { headers: bearer() });
      expect(res.status).toBe(404);
    });
  });

  // Kills 31:7-53 ConditionalExpression 'false' / BooleanLiteral
  // (negation removed) -- the access guard never denies, even for a
  // genuinely cross-team-denied caller.
  test("a session caller from a different team gets the exact CLIENT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-oauth-other-team");
      const otherTeam = createTeam("other-team-for-oauth-get", "test");
      if (typeof otherTeam === "string") throw new Error("createTeam failed");
      setClientTeam("svc-oauth-other-team", otherTeam.id);
      const headers = teamSessionHeaders("oauth-get-denied-user");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-oauth-other-team/oauth`, { headers });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
    });
  });
});

describe("PUT /admin-api/clients/:name/oauth — access guard (independent copy)", () => {
  // Kills 35:17-39 StringLiteral (route path emptied).
  test("PUT to an unrelated path is not served by oauthRoutes", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/totally-unrelated-path`, { method: "PUT", headers: bearer() });
      expect(res.status).toBe(404);
    });
  });

  // Kills 37:7-42 ConditionalExpression 'true' / BooleanLiteral (the PUT
  // handler's OWN independent copy of the access guard -- coverage of
  // GET's copy does not imply coverage here).
  test("a Bearer caller can reach the PUT handler for a known client", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-oauth-put-allowed");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-oauth-put-allowed/oauth`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ oauth: null }),
      });
      expect(res.status).toBe(200);
    });
  });

  // Kills 37:7-42 ConditionalExpression 'false' (the access guard never
  // denies, even for a genuinely cross-team-denied caller).
  test("a session caller from a different team gets the exact CLIENT_NOT_FOUND 404 on PUT", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-oauth-put-denied");
      const otherTeam = createTeam("other-team-for-oauth-put", "test");
      if (typeof otherTeam === "string") throw new Error("createTeam failed");
      setClientTeam("svc-oauth-put-denied", otherTeam.id);
      const headers = teamSessionHeaders("oauth-put-denied-user");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-oauth-put-denied/oauth`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ oauth: null }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
    });
  });
});

describe("PUT /admin-api/clients/:name/oauth — body parsing + clear branch", () => {
  // Kills 38:16-59 LogicalOperator (?? -> &&, which would leave `body`
  // undefined instead of falling back to {} when no JSON body is sent).
  test("a request with no JSON body returns a clean 400, not a crash", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-oauth-nobody");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-oauth-nobody/oauth`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe(
        "tokenUrl, clientId, and clientSecret are required (or send { oauth: null } to clear)",
      );
    });
  });

  // Kills 40:7-26 ConditionalExpression 'false' / EqualityOperator (the
  // body.oauth===null check never recognized) and 42:28-51:4
  // BlockStatement (the whole "set" branch emptied, leaving `input`
  // unassigned) and the audit action StringLiterals at 62:46-64.
  test("{ oauth: null } clears the config with the exact clear audit action", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-oauth-clear");
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/clients/svc-oauth-clear/oauth`, {
          method: "PUT",
          headers: bearer(),
          body: JSON.stringify({ oauth: null }),
        });
        expect(res.status).toBe(200);
        expect(spy).toHaveBeenCalledWith(expect.any(String), "client.oauth.clear", "svc-oauth-clear");
        const after = await (
          await fetch(`${baseUrl}/admin-api/clients/svc-oauth-clear/oauth`, { headers: bearer() })
        ).json();
        expect(after).toEqual({ oauth: null });
      } finally {
        spy.mockRestore();
      }
    });
  });

  // Kills 40:7-26 ConditionalExpression 'true' (always treats the
  // request as a clear, even when real oauth fields were sent).
  test("a real oauth config is not incorrectly treated as a clear request", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-oauth-notclear");
      configureSecretsProvider();
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-oauth-notclear/oauth`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ tokenUrl: "http://5.6.7.8", clientId: "cid", clientSecret: "csecret" }),
      });
      expect(res.status).toBe(200);
      const get = (await (
        await fetch(`${baseUrl}/admin-api/clients/svc-oauth-notclear/oauth`, { headers: bearer() })
      ).json()) as { oauth: { tokenUrl: string } | null };
      expect(get.oauth?.tokenUrl).toBe("http://5.6.7.8");
    });
  });
});

describe("PUT /admin-api/clients/:name/oauth — required-fields clause isolation", () => {
  const full = { tokenUrl: "http://5.6.7.8", clientId: "cid", clientSecret: "csecret" };

  // Kills 46:9-18 BooleanLiteral 'tokenUrl' (negation removed) and the
  // outer LogicalOperator/ConditionalExpression cluster on the whole
  // `!tokenUrl || !clientId || !clientSecret` condition -- missing ONLY
  // tokenUrl isolates its clause.
  test("missing only tokenUrl returns the exact required-fields 400", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-oauth-notoken");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-oauth-notoken/oauth`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ clientId: full.clientId, clientSecret: full.clientSecret }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe(
        "tokenUrl, clientId, and clientSecret are required (or send { oauth: null } to clear)",
      );
    });
  });

  // Kills 46:22-31 BooleanLiteral 'clientId' (negation removed).
  test("missing only clientId returns the exact required-fields 400", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-oauth-noclientid");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-oauth-noclientid/oauth`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ tokenUrl: full.tokenUrl, clientSecret: full.clientSecret }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe(
        "tokenUrl, clientId, and clientSecret are required (or send { oauth: null } to clear)",
      );
    });
  });

  // Kills 46:35-48 BooleanLiteral 'clientSecret' (negation removed).
  test("missing only clientSecret returns the exact required-fields 400", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-oauth-nosecret");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-oauth-nosecret/oauth`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ tokenUrl: full.tokenUrl, clientId: full.clientId }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe(
        "tokenUrl, clientId, and clientSecret are required (or send { oauth: null } to clear)",
      );
    });
  });

  // Kills the "all three present" positive direction for the whole OR
  // cluster (both LogicalOperator flips and the whole-condition
  // ConditionalExpression forced-true, which would incorrectly reject
  // even complete input).
  test("all three fields present is accepted, not rejected", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-oauth-allpresent");
      configureSecretsProvider();
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-oauth-allpresent/oauth`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify(full),
      });
      expect(res.status).toBe(200);
    });
  });
});

describe("PUT /admin-api/clients/:name/oauth — tokenUrl/clientId/scope ternaries", () => {
  // Kills 43:22-55 ConditionalExpression 'false' / EqualityOperator /
  // StringLiteral '""' ("string" emptied -- tokenUrl always defaults to
  // "" even for a valid string) via the "all three fields present"
  // success test above (which already sends a genuine tokenUrl and
  // verifies success). Kills 43:22-55 ConditionalExpression 'true' /
  // StringLiteral '"Stryker was here!"' (the fallback "" replaced with a
  // truthy placeholder, letting a non-string tokenUrl slip past the
  // required-check) via a dedicated non-string fixture.
  test("a non-string tokenUrl is rejected with the exact required-fields message", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-oauth-nonstring-token");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-oauth-nonstring-token/oauth`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ tokenUrl: 12345, clientId: "cid", clientSecret: "csecret" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe(
        "tokenUrl, clientId, and clientSecret are required (or send { oauth: null } to clear)",
      );
    });
  });

  // Kills 44:22-55's identical 4-mutant cluster for clientId.
  test("a non-string clientId is rejected with the exact required-fields message", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-oauth-nonstring-clientid");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-oauth-nonstring-clientid/oauth`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ tokenUrl: "http://5.6.7.8", clientId: 12345, clientSecret: "csecret" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe(
        "tokenUrl, clientId, and clientSecret are required (or send { oauth: null } to clear)",
      );
    });
  });

  // Kills 45:26-63's identical 4-mutant cluster for clientSecret.
  test("a non-string clientSecret is rejected with the exact required-fields message", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-oauth-nonstring-secret");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-oauth-nonstring-secret/oauth`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ tokenUrl: "http://5.6.7.8", clientId: "cid", clientSecret: 12345 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe(
        "tokenUrl, clientId, and clientSecret are required (or send { oauth: null } to clear)",
      );
    });
  });

  // Kills 50:56-86 ConditionalExpression 'true'/'false' / EqualityOperator
  // / StringLiteral '""' ("string" emptied) -- the scope ternary. A real
  // scope value must persist; an omitted scope must stay undefined/null,
  // not accidentally become "" or leak the field name.
  test("an explicit scope is persisted, not dropped", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-oauth-scope");
      configureSecretsProvider();
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-oauth-scope/oauth`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({
          tokenUrl: "http://5.6.7.8",
          clientId: "cid",
          clientSecret: "csecret",
          scope: "read write",
        }),
      });
      expect(res.status).toBe(200);
      const get = (await (
        await fetch(`${baseUrl}/admin-api/clients/svc-oauth-scope/oauth`, { headers: bearer() })
      ).json()) as { oauth: { scope: string | null } | null };
      expect(get.oauth?.scope).toBe("read write");
    });
  });

  // Kills 50:56-86 ConditionalExpression 'true' (the scope typeof-check
  // forced always-true, using body.scope as-is even when it's not a
  // string). A number scope must NOT be stored raw -- SQLite's STRICT
  // TEXT-column coercion would silently accept it (verified empirically:
  // binding a JS number to a STRICT TEXT column converts it to its text
  // representation rather than throwing), so real code's `undefined`
  // fallback (stored as NULL) is the only thing that distinguishes this
  // from the mutant's raw "12345" being persisted.
  test("a non-string scope is dropped (stored as null), not coerced to text", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-oauth-nonstring-scope");
      configureSecretsProvider();
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-oauth-nonstring-scope/oauth`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ tokenUrl: "http://5.6.7.8", clientId: "cid", clientSecret: "csecret", scope: 12345 }),
      });
      expect(res.status).toBe(200);
      const get = (await (
        await fetch(`${baseUrl}/admin-api/clients/svc-oauth-nonstring-scope/oauth`, { headers: bearer() })
      ).json()) as { oauth: { scope: string | null } | null };
      expect(get.oauth?.scope).toBeNull();
    });
  });
});

describe("PUT /admin-api/clients/:name/oauth — setCanary result handling", () => {
  // Kills 21:56-26:2 ObjectLiteral (the whole OAUTH_ERROR_STATUS map
  // emptied to {} -- every status lookup would return undefined),
  // 53:7-17 ConditionalExpression 'false' / BooleanLiteral (the
  // !result.ok guard never firing for a genuine failure), 53:19-61:4
  // BlockStatement (the error-handling block emptied), and 58:7-36
  // LogicalOperator (result.reason ?? result.error -> &&, which would
  // produce `undefined` as the message for an error with no reason,
  // like CLIENT_NOT_FOUND).
  test("an unknown client returns the exact CLIENT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/clients/no-such-client/oauth`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ tokenUrl: "http://5.6.7.8", clientId: "cid", clientSecret: "csecret" }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
      expect(body.error.message).toBe("CLIENT_NOT_FOUND");
    });
  });

  // Kills 53:7-17 ConditionalExpression 'true' (always treats a genuine
  // success as an error).
  test("a genuine success is not incorrectly treated as an error", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-oauth-success-not-error");
      configureSecretsProvider();
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-oauth-success-not-error/oauth`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ tokenUrl: "http://5.6.7.8", clientId: "cid", clientSecret: "csecret" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ status: "updated", name: "svc-oauth-success-not-error" });
    });
  });

  // Kills 58:7-36's OTHER direction: when result.reason IS present
  // (INVALID_URL always carries one), `??` must use the reason text,
  // not `&&`'s wrongly-selected result.error code. Also kills
  // 62:24-51 ObjectLiteral / 62:34-43 StringLiteral (the { status,
  // name } response wrapper / "updated" literal emptied) via the
  // success test above, and 62:46-64 StringLiteral ("client.oauth.set"
  // emptied) via the audit spy below.
  test("a malformed tokenUrl returns the exact underlying reason as the message", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-oauth-badurl");
      configureSecretsProvider();
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-oauth-badurl/oauth`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ tokenUrl: "not a valid url", clientId: "cid", clientSecret: "csecret" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("INVALID_URL");
      expect(body.error.message).toBe("Invalid URL");
    });
  });

  test("records the exact client.oauth.set audit action", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-oauth-audit");
      configureSecretsProvider();
      const spy = spyOn(auditMod, "recordAudit");
      try {
        await fetch(`${baseUrl}/admin-api/clients/svc-oauth-audit/oauth`, {
          method: "PUT",
          headers: bearer(),
          body: JSON.stringify({ tokenUrl: "http://5.6.7.8", clientId: "cid", clientSecret: "csecret" }),
        });
        expect(spy).toHaveBeenCalledWith(expect.any(String), "client.oauth.set", "svc-oauth-audit");
      } finally {
        spy.mockRestore();
      }
    });
  });
});
