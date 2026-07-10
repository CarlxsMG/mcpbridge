/**
 * Stryker mutation-testing backstop for src/routes/upstream-auth.ts —
 * domain 8. Baseline: 159 mutants, 52 killed / 107 survived — the existing
 * `routes-upstream-auth.test.ts` (left untouched here) covers only the
 * bearer-auth happy path, the invalid-type/forbidden-header/no-secret-box/
 * unknown-client(GET)/no-auth/viewer-forbidden branches at a status-code-
 * only level. It never exercises the basic-auth branch AT ALL, never
 * exercises bearer's own empty-token validation, never exercises header
 * auth's own happy path or its headerName-regex/empty-value branches,
 * never asserts exact error codes/messages/audit details anywhere, and
 * never tests an unknown client on PUT/DELETE (only GET). All line:col
 * citations below were read directly from reports/mutation/result.json.
 *
 * Mutant 16 (ConditionalExpression, the `input === null` half of
 * `typeof input !== "object" || input === null`) is an accepted
 * EQUIVALENT, not chased: production mounts `express.json({strict:
 * true})` (src/server.ts), which rejects every bare-scalar top-level JSON
 * body (a raw string, `null`, a number) with body-parser's own
 * SyntaxError BEFORE the route ever runs — confirmed empirically with a
 * standalone script hitting a real express app. There is no way to reach
 * this handler with `req.body === null` through the real HTTP boundary;
 * the `typeof input !== "object"` half alone reaches everything
 * genuinely reachable (an absent body leaves `req.body` `undefined`).
 */
import { describe, test, expect, spyOn, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { getUpstreamAuthHeaders } from "../../backend-auth/upstream-auth.js";
import { registry } from "../../mcp/registry.js";
import { requestIdMiddleware } from "../../middleware/request-id.js";
import * as auditMod from "../../admin/audit/audit.js";

const ADMIN_KEY = "test-admin-key-upstream-auth-mut";
const originalSecretEncryptionKey = config.secretEncryptionKey;

afterEach(() => {
  (config as Record<string, unknown>).secretEncryptionKey = originalSecretEncryptionKey;
});

async function startApp(): Promise<{ baseUrl: string; server: Server }> {
  __resetDbForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  (config as Record<string, unknown>).secretEncryptionKey = Buffer.alloc(32, 7).toString("base64");
  const { upstreamAuthRoutes } = await import("../../routes/upstream-auth.js");
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  upstreamAuthRoutes(app);
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

async function withApp(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const { baseUrl, server } = await startApp();
  try {
    await fn(baseUrl);
  } finally {
    for (const c of registry.listClients()) await registry.unregister(c.name);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("validateBody — request shape", () => {
  // Kills 11/12/13/18/19/20 (the `typeof input !== "object" || ...`
  // cluster and its exact message). Production's `express.json({strict:
  // true})` (src/server.ts) rejects any bare-scalar JSON body (a raw
  // string, `null`, a number) BEFORE the route ever runs -- confirmed
  // empirically, both return body-parser's own SyntaxError, never
  // reaching this handler. The only way `req.body` becomes non-object
  // through the real HTTP boundary is when no JSON body is sent at all
  // (`req.body` stays `undefined`), which this test uses instead.
  test("no request body at all fails validation with the exact message", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-ua-nonobject");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-ua-nonobject/upstream-auth`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("body must be an object");
    });
  });

  // Kills 114/116 (the default-case message emptied) -- the existing
  // "400 for an invalid type" test never checked the exact message.
  test("an unrecognized type returns the exact message", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-ua-badtype");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-ua-badtype/upstream-auth`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ type: "oauth5" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("type must be one of: bearer, basic, header");
    });
  });
});

describe("validateBody — bearer", () => {
  // Kills 24/25/26/29/31/32/33 (the bearer token-required cluster and
  // its exact message) -- the existing bearer test never sends an empty
  // or missing token.
  test("a missing token fails validation with the exact message", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-ua-bearer-missing");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-ua-bearer-missing/upstream-auth`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ type: "bearer" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("token is required for bearer auth");
    });
  });

  test("an empty-string token fails validation with the exact message", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-ua-bearer-empty");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-ua-bearer-empty/upstream-auth`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ type: "bearer", token: "" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("token is required for bearer auth");
    });
  });
});

describe("validateBody — basic", () => {
  // Kills 39/40 (the `case "basic":` label/ConditionalExpression) and the
  // whole 4-clause OR validation cluster's "never fails" directions
  // (41-57) via each field independently missing/empty, plus 58/60/61
  // (the validation-error branch body and exact message).
  test("a missing username fails validation with the exact message", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-ua-basic-nouser");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-ua-basic-nouser/upstream-auth`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ type: "basic", password: "correct-horse-battery-staple" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("username and password are required for basic auth");
    });
  });

  test("an empty-string username fails validation", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-ua-basic-emptyuser");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-ua-basic-emptyuser/upstream-auth`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ type: "basic", username: "", password: "correct-horse-battery-staple" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("username and password are required for basic auth");
    });
  });

  test("a missing password fails validation", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-ua-basic-nopass");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-ua-basic-nopass/upstream-auth`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ type: "basic", username: "svc-user" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("username and password are required for basic auth");
    });
  });

  test("an empty-string password fails validation", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-ua-basic-emptypass");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-ua-basic-emptypass/upstream-auth`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ type: "basic", username: "svc-user", password: "" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("username and password are required for basic auth");
    });
  });

  // Kills 42/43/62/63/64/65/66 (complement -- must NOT fail when both
  // fields are genuinely present) -- basic auth's entire success path was
  // completely untested at baseline.
  test("a fully valid basic auth is stored and reported correctly", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-ua-basic-ok");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-ua-basic-ok/upstream-auth`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ type: "basic", username: "svc-user", password: "correct-horse-battery-staple" }),
      });
      expect(res.status).toBe(200);
      const get = await fetch(`${baseUrl}/admin-api/clients/svc-ua-basic-ok/upstream-auth`, { headers: bearer() });
      const info = (await get.json()) as { configured: boolean; type: string };
      expect(info.configured).toBe(true);
      expect(info.type).toBe("basic");
      expect(JSON.stringify(info)).not.toContain("correct-horse-battery-staple");
      // getUpstreamAuthInfo never exposes the secret, so the only way to
      // prove the REAL username/password (not an emptied {}) were stored
      // is to resolve the actual outbound header the proxy would send.
      expect(getUpstreamAuthHeaders("svc-ua-basic-ok")).toEqual({
        Authorization: `Basic ${Buffer.from("svc-user:correct-horse-battery-staple").toString("base64")}`,
      });
    });
  });
});

describe("validateBody — header", () => {
  // Kills 67/68/69 (the `case "header":` label/block) and 70-80 (the
  // headerName-required cluster + exact message).
  test("a missing headerName fails validation with the exact message", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-ua-header-noname");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-ua-header-noname/upstream-auth`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ type: "header", value: "x" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("headerName is required for header auth");
    });
  });

  // Kills 76 (the `b.headerName.length === 0` sub-check forced-false):
  // an empty STRING headerName passes the `typeof !== "string"` half
  // (it genuinely is a string) but must still be caught by the length
  // check -- the missing-headerName test above never exercises this
  // since `undefined` is caught by the OTHER half entirely.
  test("an empty-string headerName fails validation with the exact message", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-ua-header-emptyname");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-ua-header-emptyname/upstream-auth`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ type: "header", headerName: "", value: "x" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("headerName is required for header auth");
    });
  });

  // Kills the Regex mutants' leading-anchor-dropped direction: without
  // `^`, `.test()` would still match the valid SUFFIX of an otherwise-
  // invalid string.
  test("a headerName with an invalid leading character fails the token pattern", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-ua-header-badlead");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-ua-header-badlead/upstream-auth`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ type: "header", headerName: "!XCustom", value: "x" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("headerName must be a valid header token");
    });
  });

  // Kills the Regex mutants' trailing-anchor-dropped direction: without
  // `$`, `.test()` would still match the valid PREFIX.
  test("a headerName with an invalid trailing character fails the token pattern", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-ua-header-badtrail");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-ua-header-badtrail/upstream-auth`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ type: "header", headerName: "XCustom!", value: "x" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("headerName must be a valid header token");
    });
  });

  // Kills 91/94/96 (the forbidden-header ConditionalExpression's
  // "always true" direction and the exact template-literal message) via
  // both an ADDITIONAL forbidden name (content-length/content-type,
  // never tried before -- kills 7/8 too) and an exact-message assertion.
  test("content-length and content-type are also forbidden header names", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-ua-header-forbidden2");
      const res1 = await fetch(`${baseUrl}/admin-api/clients/svc-ua-header-forbidden2/upstream-auth`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ type: "header", headerName: "Content-Length", value: "x" }),
      });
      expect(res1.status).toBe(400);
      const body1 = (await res1.json()) as { error: { message: string } };
      expect(body1.error.message).toBe("headerName 'Content-Length' is not allowed");

      const res2 = await fetch(`${baseUrl}/admin-api/clients/svc-ua-header-forbidden2/upstream-auth`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ type: "header", headerName: "Content-Type", value: "x" }),
      });
      expect(res2.status).toBe(400);
      const body2 = (await res2.json()) as { error: { message: string } };
      expect(body2.error.message).toBe("headerName 'Content-Type' is not allowed");
    });
  });

  // Kills 97-107 (the value-required cluster + exact message).
  test("a missing value fails validation with the exact message", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-ua-header-novalue");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-ua-header-novalue/upstream-auth`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ type: "header", headerName: "X-Custom-Auth" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("value is required for header auth");
    });
  });

  // Kills 103 (the `b.value.length === 0` sub-check forced-false): an
  // empty STRING value passes `typeof !== "string"` but must still be
  // caught by the length check -- same "missing vs. empty" distinction
  // as headerName above.
  test("an empty-string value fails validation with the exact message", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-ua-header-emptyvalue");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-ua-header-emptyvalue/upstream-auth`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ type: "header", headerName: "X-Custom-Auth", value: "" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("value is required for header auth");
    });
  });

  // Kills 81/82/83/84/85/86/87 (the whole regex-validity cluster's
  // "always reject" directions, including the quantifier-removed and
  // negated-class mutants, both of which reject a normal multi-char valid
  // name) and 108/109/110/111/112 (the success object/headerName field
  // emptied) -- header auth's entire success path was completely
  // untested at baseline.
  test("a fully valid header auth is stored and reported correctly", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-ua-header-ok");
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/clients/svc-ua-header-ok/upstream-auth`, {
          method: "PUT",
          headers: bearer(),
          body: JSON.stringify({ type: "header", headerName: "X-Custom-Auth", value: "sekret-value" }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { type: string; headerName: string };
        expect(body.type).toBe("header");
        expect(body.headerName).toBe("X-Custom-Auth");
        expect(JSON.stringify(body)).not.toContain("sekret-value");
        expect(spy).toHaveBeenCalledWith(expect.any(String), "client.upstream_auth.set", "svc-ua-header-ok", {
          type: "header",
        });
        // getUpstreamAuthInfo never exposes the secret, so the only way
        // to prove the REAL value (not an emptied {}) was stored is to
        // resolve the actual outbound header the proxy would send.
        expect(getUpstreamAuthHeaders("svc-ua-header-ok")).toEqual({ "X-Custom-Auth": "sekret-value" });
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("GET /admin-api/clients/:name/upstream-auth", () => {
  // Kills 124/125 (the CLIENT_NOT_FOUND code/message emptied) -- the
  // existing "404 for an unknown client" test only checks the status.
  test("an unknown client returns the exact CLIENT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-ua-never-registered/upstream-auth`, {
        headers: bearer(),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
      expect(body.error.message).toBe("Client not found");
    });
  });
});

describe("PUT /admin-api/clients/:name/upstream-auth", () => {
  // Kills 130/131/132/133 (PUT's OWN independent copy of the !clientExists
  // guard) -- the existing suite only tests this guard via GET, never PUT.
  test("an unknown client returns the exact CLIENT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-ua-put-never-registered/upstream-auth`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ type: "bearer", token: "x" }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
      expect(body.error.message).toBe("Client not found");
    });
  });

  // Kills 138/139 (the SECRET_BOX_NOT_CONFIGURED code/message emptied) --
  // the existing 501 test only checks the status.
  test("no secret box configured returns the exact SECRET_BOX_NOT_CONFIGURED 501", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-ua-nosecretbox");
      (config as Record<string, unknown>).secretEncryptionKey = undefined;
      try {
        const res = await fetch(`${baseUrl}/admin-api/clients/svc-ua-nosecretbox/upstream-auth`, {
          method: "PUT",
          headers: bearer(),
          body: JSON.stringify({ type: "bearer", token: "x" }),
        });
        expect(res.status).toBe(501);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe("SECRET_BOX_NOT_CONFIGURED");
        expect(body.error.message).toBe("Set SECRET_ENCRYPTION_KEY to store upstream credentials");
      } finally {
        (config as Record<string, unknown>).secretEncryptionKey = Buffer.alloc(32, 7).toString("base64");
      }
    });
  });

  // Kills 38 (the bearer secret object `{ token: b.token }` emptied to
  // `{}`), 144/145/146/147 (the recordAudit action/detail literals and
  // the response object/"updated" literal emptied) -- the existing
  // happy-path test never checked the audit spy, the exact response
  // shape, or the ACTUAL stored secret (getUpstreamAuthInfo never
  // exposes it, so proving the real token was stored -- not an emptied
  // {} -- requires resolving the real outbound header).
  test("a successful set is audited and returns the exact response shape", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-ua-put-ok");
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/clients/svc-ua-put-ok/upstream-auth`, {
          method: "PUT",
          headers: bearer(),
          body: JSON.stringify({ type: "bearer", token: "sekret" }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; name: string; configured: boolean; type: string };
        expect(body.status).toBe("updated");
        expect(body.name).toBe("svc-ua-put-ok");
        expect(body.configured).toBe(true);
        expect(body.type).toBe("bearer");
        expect(spy).toHaveBeenCalledWith(expect.any(String), "client.upstream_auth.set", "svc-ua-put-ok", {
          type: "bearer",
        });
        expect(getUpstreamAuthHeaders("svc-ua-put-ok")).toEqual({ Authorization: "Bearer sekret" });
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("DELETE /admin-api/clients/:name/upstream-auth", () => {
  // Kills 154/155 (the NOT_CONFIGURED code/message emptied) -- the
  // existing delete-twice test only checks the status on the 2nd call.
  test("clearing when nothing is configured returns the exact NOT_CONFIGURED 404", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-ua-delete-noconf");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-ua-delete-noconf/upstream-auth`, {
        method: "DELETE",
        headers: bearer(),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("NOT_CONFIGURED");
      expect(body.error.message).toBe("No upstream auth configured for this client");
    });
  });

  // Kills 156/157/158 (the recordAudit action string and response
  // object/"cleared" literal emptied) -- the existing delete-success test
  // never checked the audit spy or the exact response shape.
  test("a successful clear is audited and returns the exact response shape", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-ua-delete-ok");
      await fetch(`${baseUrl}/admin-api/clients/svc-ua-delete-ok/upstream-auth`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ type: "bearer", token: "sekret" }),
      });
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/clients/svc-ua-delete-ok/upstream-auth`, {
          method: "DELETE",
          headers: bearer(),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; name: string };
        expect(body).toEqual({ status: "cleared", name: "svc-ua-delete-ok" });
        expect(spy).toHaveBeenCalledWith(expect.any(String), "client.upstream_auth.clear", "svc-ua-delete-ok");
      } finally {
        spy.mockRestore();
      }
    });
  });
});
