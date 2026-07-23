/**
 * Stryker mutation-testing backstop for src/routes/register.ts — domain 8.
 * Baseline: 58 mutants, 29 killed / 29 survived — the existing
 * routes-register.test.ts is thorough for the REST/MCP/GraphQL dispatch
 * branches but: never isolates the individual clauses of the Change-A/
 * dispatch OR-conditions (its one non-object-body test happens to be an
 * array, which satisfies BOTH the `typeof !== "object"` clause being
 * FALSE and `Array.isArray` being true, so it can't distinguish a forced
 * mutant on the other clauses), never checks exact error messages/
 * request_id, tests the Change-B tools[] cap only with a count clearly
 * OVER the limit (never AT the boundary, so `>` vs `>=` can't be told
 * apart), and never touches GET /register/schema at all. All line:col
 * citations below were read directly from reports/mutation/result.json.
 *
 * Two survivors are accepted, not chased with dedicated tests:
 * - 31:20-45 OptionalChaining (`req.socket?.remoteAddress` ->
 *   `req.socket.remoteAddress`). `req.socket` is Node's own
 *   `http.IncomingMessage.socket`, which is populated for every real
 *   incoming HTTP request Express ever receives (there is no code path
 *   where a live request has no underlying socket) — the `?.` is
 *   defensive but the property it guards is never actually absent, so
 *   removing it produces no observable difference for any request
 *   reachable over real HTTP.
 * - The GET /register/schema "schema unavailable" 503 branch's own
 *   internal mutants (49:9-36 ConditionalExpression 'false', the whole
 *   50:28-108 ObjectLiteral + its StringLiterals, 49:38-52 BlockStatement).
 *   `resolvedRegistrationSchema` is a module-level constant resolved
 *   ONCE at import time from the repo's own checked-in OpenAPI spec
 *   (verified empirically: `bun -e` importing registration.ts shows it
 *   resolves non-null in this environment) with no `mock.module`
 *   precedent anywhere in this codebase to force a load failure — the
 *   503 path is unreachable in any realistic test run here.
 */
import { describe, test, expect, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { requestIdMiddleware } from "../../middleware/request-id.js";
import { _internalsForTesting } from "../../middleware/rate-limiter.js";
import { registry } from "../../mcp/registry.js";
import { resolvedRegistrationSchema } from "../../mcp/registration.js";

const ADMIN_KEY = "test-admin-key-register-mut";

async function startApp(): Promise<{ baseUrl: string; server: Server }> {
  __resetDbForTesting();
  for (const c of registry.listClients()) await registry.unregister(c.name);
  _internalsForTesting.registerBuckets.clear();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  // Every fixture here registers a backend at a loopback health_url, which the
  // SSRF validator rejects unless this is on. Pin it rather than inheriting it:
  // the value otherwise comes from a contributor's gitignored .env, or from
  // whatever an earlier test file happened to leave behind.
  (config as Record<string, unknown>).allowPrivateIps = true;
  const { registerRoutes } = await import("../../routes/register.js");
  const app = express();
  app.use(express.json({ limit: "64kb", strict: false }));
  app.use(requestIdMiddleware);
  registerRoutes(app);
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

afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
});

async function withApp(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const { baseUrl, server } = await startApp();
  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("POST /register — request_id propagation", () => {
  // Kills 16:23-63 LogicalOperator (?? -> &&, which would return the
  // RIGHT operand `null` whenever res.locals.requestId is truthy, since
  // requestIdMiddleware always sets a real one). Register.ts's OWN Change
  // A/B guards call validationError(res, message) directly -- they never
  // read the local `requestId` variable at all, so a null/non-object-body
  // test can't reach this mutant. The local `requestId` is only consumed
  // where it's threaded into performMcpRegistration/
  // performGraphqlRegistration/performRestRegistration as their 3rd
  // argument, so an error returned FROM one of those functions is needed.
  test("a registration-function validation error carries the real request_id, not null", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/register`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ kind: "mcp", name: "request-id-check" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { request_id: string | null } };
      expect(body.error.request_id).not.toBeNull();
      expect(typeof body.error.request_id).toBe("string");
    });
  });
});

describe("POST /register — Change A guard clauses", () => {
  // Kills 19:9-26 ConditionalExpression 'false' (the `req.body === null`
  // clause) -- the existing array-body test can't reach this clause
  // since an array is never === null.
  test("a literal JSON null body returns the exact 400 message", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/register`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify(null),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("Request body must be a JSON object");
    });
  });

  // Kills 19:30-58 ConditionalExpression 'false' (the `typeof req.body
  // !== "object"` clause) -- a bare JSON string is neither null nor an
  // array, isolating this clause specifically.
  test("a bare JSON string body returns the exact 400 message", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/register`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify("just a string"),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("Request body must be a JSON object");
    });
  });

  // Kills 19:9-85 LogicalOperator mutants (both the outer `||` -> `&&`
  // and the inner `(A||B) -> (A&&B)` flips) and 20:35-71 StringLiteral
  // (the message text emptied) -- the null-body test above already
  // exercises A true / B,C false; combined with the existing array-body
  // test (C true / A,B false), all three clauses have been independently
  // toggled true at least once.
});

describe("POST /register — Change B tools[] cap boundary", () => {
  // Kills 26:7-99 EqualityOperator ('>' -> '>=') -- the existing
  // over-the-limit test (2 tools, cap 1) can't distinguish `>` from
  // `>=` since 2 satisfies both. AT the exact boundary (tools.length
  // === cap), real code (`>`) must allow it; `>=` would incorrectly
  // reject it.
  test("tools[] exactly at the configured maximum is allowed, not rejected", async () => {
    await withApp(async (baseUrl) => {
      const original = config.maxToolsPerClient;
      (config as Record<string, unknown>).maxToolsPerClient = 2;
      try {
        const res = await fetch(`${baseUrl}/register`, {
          method: "POST",
          headers: bearer(),
          body: JSON.stringify({
            name: "at-boundary",
            health_url: "http://127.0.0.1:1/health",
            tools: [
              {
                name: "a",
                method: "GET",
                endpoint: "/a",
                description: "a",
                inputSchema: { type: "object", properties: {} },
              },
              {
                name: "b",
                method: "GET",
                endpoint: "/b",
                description: "b",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          }),
        });
        expect(res.status).toBe(200);
      } finally {
        (config as Record<string, unknown>).maxToolsPerClient = original;
      }
    });
  });

  // Kills 28:35-91 StringLiteral (the template-literal cap message
  // emptied) -- the existing over-the-limit test only asserts status,
  // never the message content.
  test("exceeding the cap returns the exact message with the configured limit", async () => {
    await withApp(async (baseUrl) => {
      const original = config.maxToolsPerClient;
      (config as Record<string, unknown>).maxToolsPerClient = 1;
      try {
        const res = await fetch(`${baseUrl}/register`, {
          method: "POST",
          headers: bearer(),
          body: JSON.stringify({
            name: "over-boundary",
            health_url: "http://127.0.0.1:1/health",
            tools: [
              {
                name: "a",
                method: "GET",
                endpoint: "/a",
                description: "a",
                inputSchema: { type: "object", properties: {} },
              },
              {
                name: "b",
                method: "GET",
                endpoint: "/b",
                description: "b",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          }),
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { message: string } };
        expect(body.error.message).toBe("tools[] exceeds maximum of 1");
      } finally {
        (config as Record<string, unknown>).maxToolsPerClient = original;
      }
    });
  });
});

describe("POST /register — dispatch clause isolation", () => {
  // Kills 37:9-25 ConditionalExpression 'false' / StringLiteral '""'
  // ("mcp" emptied) -- the existing "explicit kind: mcp" test always
  // ALSO sends a real mcp_url, so both dispatch clauses agree and can't
  // isolate `b.kind === "mcp"` on its own. Omitting mcp_url entirely
  // proves dispatch still reaches the MCP branch via the exact
  // MCP-specific validation message.
  test("kind: mcp alone (no mcp_url) still dispatches to the MCP branch", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/register`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ kind: "mcp", name: "mcp-clause-isolation" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("mcp_url must start with http:// or https://");
    });
  });

  // Kills 39:16-36 ConditionalExpression 'false' / StringLiteral '""'
  // ("graphql" emptied) -- same clause-isolation technique for the
  // GraphQL dispatch condition.
  test("kind: graphql alone (no graphql_url) still dispatches to the GraphQL branch", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/register`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ kind: "graphql", name: "graphql-clause-isolation" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("graphql_url must start with http:// or https://");
    });
  });
});

describe("GET /register/schema", () => {
  // Kills 48:11-29 StringLiteral (route path emptied), 48:76-55:4
  // BlockStatement (whole handler emptied), 49:9-36 ConditionalExpression
  // 'true' / BooleanLiteral (negation removed -- both would incorrectly
  // 503 even though the schema is genuinely available), and 53:19-33 /
  // 53:35-60 StringLiteral (the Content-Type header name/value emptied).
  test("returns the exact resolved schema with the schema+json content type", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/register/schema`, { headers: bearer() });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/schema+json");
      const body = await res.json();
      expect(body).toEqual(resolvedRegistrationSchema);
    });
  });

  test("an unrelated path is not served by the schema route", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/register/totally-unrelated`, { headers: bearer() });
      expect(res.status).toBe(404);
    });
  });
});
