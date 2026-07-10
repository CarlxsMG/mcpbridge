/**
 * Stryker mutation-testing backstop for src/routes/discovery.ts — domain 8.
 * Gap-fills the existing routes-discovery.test.ts (left completely
 * untouched), which covers each branch's happy path + a few 400s but never:
 * isolates stringArray()'s own Array.isArray/filter/length-boundary clauses
 * (include_tags/exclude_operations are accepted but never asserted to
 * actually change the discovered tool set), touches the manual `tools[]`
 * branch AT ALL (curl/postman are covered, the plain literal-array source
 * is not), asserts recordAudit's exact actor/action/target/detail for any
 * of the 3 audit call sites, isolates hasPostman/hasTools's individual
 * boolean-chain clauses at their falsy-but-not-absent boundaries (empty
 * string / null / 0), exercises requireAdminRole's non-admin-session 403,
 * or proves the GraphQL route's `pathname || "/graphql"` fallback and
 * `include_mutations !== false` default actually reflect the real values
 * (vs. a hardcoded literal). All line:col citations were read directly from
 * reports/mutation/result.json.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach, spyOn } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { requestIdMiddleware } from "../../middleware/request-id.js";
import { createUser } from "../../security/user-store.js";
import { createSession } from "../../security/session-store.js";
import { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } from "../../security/cookies.js";
import * as auditMod from "../../admin/audit/audit.js";
import { _internalsForTesting } from "../../middleware/rate-limiter.js";

const ADMIN_KEY = "test-admin-key-discovery-mut";

let adminBase = "";
let adminServer: Server | null = null;
let upstream: Server | null = null;
let upstreamPort = 0;

/** A 3-operation spec: one tagged "alpha", one tagged "beta", one untagged (for exclude_operations). */
function taggedSpec() {
  return {
    openapi: "3.0.0",
    info: { title: "tagged", version: "1.0.0" },
    paths: {
      "/keep": {
        get: {
          operationId: "keepOp",
          summary: "Keep operation",
          tags: ["alpha"],
          responses: { "200": { description: "ok" } },
        },
      },
      "/drop": {
        get: {
          operationId: "dropOp",
          summary: "Drop operation",
          tags: ["beta"],
          responses: { "200": { description: "ok" } },
        },
      },
      "/excludable": {
        get: {
          operationId: "excludeMe",
          summary: "Excludable operation",
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };
}

function typeRef(kind: string, name: string | null = null, ofType: unknown = null) {
  return { kind, name, ofType };
}

/** A schema with BOTH a query field and a mutation field, for include_mutations testing. */
function graphqlSchemaWithMutation() {
  return {
    data: {
      __schema: {
        queryType: { name: "Query" },
        mutationType: { name: "Mutation" },
        types: [
          {
            kind: "OBJECT",
            name: "Query",
            fields: [{ name: "ping", description: "Ping", args: [], type: typeRef("SCALAR", "String") }],
            inputFields: null,
            enumValues: null,
          },
          {
            kind: "OBJECT",
            name: "Mutation",
            fields: [
              { name: "createThing", description: "Create a thing", args: [], type: typeRef("SCALAR", "String") },
            ],
            inputFields: null,
            enumValues: null,
          },
          { kind: "SCALAR", name: "String", fields: null, inputFields: null, enumValues: null },
        ],
      },
    },
  };
}

beforeAll(async () => {
  const up = express();
  up.use(express.json());
  up.get("/tagged.json", (_req, res) => res.json(taggedSpec()));
  up.post("/api/gql", (_req, res) => res.json(graphqlSchemaWithMutation()));
  await new Promise<void>((resolve) => {
    const srv = up.listen(0, "127.0.0.1", () => {
      upstreamPort = (srv.address() as AddressInfo).port;
      upstream = srv;
      resolve();
    });
  });
});

afterAll(() => {
  upstream?.close();
});

async function startApp(): Promise<void> {
  __resetDbForTesting();
  _internalsForTesting.registerBuckets.clear();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  (config as Record<string, unknown>).allowPrivateIps = true;

  const { discoveryRoutes } = await import("../../routes/discovery.js");
  const app = express();
  app.use(express.json({ limit: "64kb", strict: true }));
  app.use(requestIdMiddleware);
  discoveryRoutes(app);

  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      adminBase = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
      adminServer = srv;
      resolve();
    });
    srv.on("error", reject);
  });
}

function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" };
}

/** A non-admin session (role "viewer") with a valid CSRF header — used to prove requireAdminRole's own 403. */
function nonAdminSessionHeaders(username: string): Record<string, string> {
  const user = createUser(username, "irrelevant-hash", "viewer", null);
  const session = createSession(user.id, "127.0.0.1", "test-agent");
  return {
    "Content-Type": "application/json",
    Cookie: `${SESSION_COOKIE_NAME}=${session.token}; ${CSRF_COOKIE_NAME}=${session.csrfToken}`,
    "X-CSRF-Token": session.csrfToken,
  };
}

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (adminServer)
      adminServer.close(() => {
        adminServer = null;
        resolve();
      });
    else resolve();
  });
  // The "register" rate-limit tier is a module-level singleton SHARED with
  // every other route mounted behind rateLimitRegister (register.ts and, via
  // this file, discovery.ts), keyed only by caller IP — not by admin key or
  // test file. Clearing on the way OUT (not just in startApp on the way in)
  // ensures this file never leaves a residual token count for whichever
  // OTHER __tests__ file happens to run next in the same `bun test` process
  // (routes-discovery.test.ts itself never clears this bucket).
  _internalsForTesting.registerBuckets.clear();
});

describe("POST /admin-api/discovery/preview — requireAdminRole", () => {
  test("a non-admin session role is rejected with 403, for both operations", async () => {
    await startApp();
    const headers = nonAdminSessionHeaders("discovery-preview-viewer");
    const res = await fetch(`${adminBase}/admin-api/discovery/preview`, {
      method: "POST",
      headers,
      body: JSON.stringify({ openapi_url: `http://127.0.0.1:${upstreamPort}/tagged.json` }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });
});

describe("POST /admin-api/discovery/preview-graphql — requireAdminRole", () => {
  test("a non-admin session role is rejected with 403", async () => {
    await startApp();
    const headers = nonAdminSessionHeaders("discovery-preview-graphql-viewer");
    const res = await fetch(`${adminBase}/admin-api/discovery/preview-graphql`, {
      method: "POST",
      headers,
      body: JSON.stringify({ graphql_url: `http://127.0.0.1:${upstreamPort}/api/gql` }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });
});

describe("POST /admin-api/discovery/preview — include_tags / exclude_operations (stringArray)", () => {
  test("with no include_tags/exclude_operations, all 3 operations are discovered", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/discovery/preview`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ openapi_url: `http://127.0.0.1:${upstreamPort}/tagged.json` }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number };
    expect(body.count).toBe(3);
  });

  test("include_tags filters to only the matching-tag operation", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/discovery/preview`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({
        openapi_url: `http://127.0.0.1:${upstreamPort}/tagged.json`,
        include_tags: ["alpha"],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; tools: { name: string }[] };
    expect(body.count).toBe(1);
    expect(body.tools[0].name).toBe("keep_op");
  });

  // Kills stringArray's `!Array.isArray(input)` negation-removed mutant: a
  // NON-array truthy value must be treated as "not provided" (no filtering,
  // all 3 tools returned, 200) rather than reaching `.filter()` on a string
  // (which has no such method and would throw, surfacing as a 500 instead).
  test("a non-array include_tags is ignored (no filtering, still 200)", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/discovery/preview`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({
        openapi_url: `http://127.0.0.1:${upstreamPort}/tagged.json`,
        include_tags: "alpha",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number };
    expect(body.count).toBe(3);
  });

  // Kills stringArray's filter-direction mutant (`=== "string"` -> `!==
  // "string"`): a mixed array must keep only the STRING element, not the
  // number — filtering to keepOp specifically (not to zero results).
  test("a mixed-type include_tags array keeps only the string element", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/discovery/preview`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({
        openapi_url: `http://127.0.0.1:${upstreamPort}/tagged.json`,
        include_tags: ["alpha", 123],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; tools: { name: string }[] };
    expect(body.count).toBe(1);
    expect(body.tools[0].name).toBe("keep_op");
  });

  // Kills stringArray's `.filter()`-removed (MethodExpression) and
  // predicate-forced-true mutants: when EVERY element is non-string, real
  // filtering empties the array (falling back to `undefined`, i.e. "no
  // filter"), so all 3 ops must come back. Under either mutant, the
  // unfiltered `[123, 456]` survives as a non-empty includeTags array,
  // which wrongly excludes every operation (none of their string tags
  // ever equal a number) — 0 tools instead of 3.
  test("an include_tags array of ALL non-string elements is treated as no filter (not zero results)", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/discovery/preview`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({
        openapi_url: `http://127.0.0.1:${upstreamPort}/tagged.json`,
        include_tags: [123, 456],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number };
    expect(body.count).toBe(3);
  });

  test("exclude_operations removes exactly the matching operationId, keeping the rest", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/discovery/preview`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({
        openapi_url: `http://127.0.0.1:${upstreamPort}/tagged.json`,
        exclude_operations: ["excludeMe"],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; tools: { name: string }[] };
    expect(body.count).toBe(2);
    const names = body.tools.map((t) => t.name).sort();
    expect(names).toEqual(["drop_op", "keep_op"]);
  });
});

describe("POST /admin-api/discovery/preview — openapi_url recordAudit + full field mapping", () => {
  test("records discovery.preview with the exact url target and count detail", async () => {
    await startApp();
    const spy = spyOn(auditMod, "recordAudit");
    try {
      const url = `http://127.0.0.1:${upstreamPort}/tagged.json`;
      const res = await fetch(`${adminBase}/admin-api/discovery/preview`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ openapi_url: url }),
      });
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toBe("bearer:admin-api-key");
      expect(spy.mock.calls[0][1]).toBe("discovery.preview");
      expect(spy.mock.calls[0][2]).toBe(url);
      expect(spy.mock.calls[0][3]).toEqual({ count: 3 });
    } finally {
      spy.mockRestore();
    }
  });

  test("the preview response includes every field, including description", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/discovery/preview`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({
        openapi_url: `http://127.0.0.1:${upstreamPort}/tagged.json`,
        include_tags: ["alpha"],
      }),
    });
    const body = (await res.json()) as {
      tools: { name: string; method: string; endpoint: string; description: string }[];
    };
    expect(body.tools[0]).toEqual({
      name: "keep_op",
      method: "GET",
      endpoint: "/keep",
      description: "Keep operation",
    });
  });
});

describe("POST /admin-api/discovery/preview — openapi_url absolute-URL guard (exact messages)", () => {
  // Kills the whole-condition-forced-false, block-emptied, and message-
  // StringLiteral-emptied mutants on this guard: the existing sibling test
  // only asserts the STATUS (400), never the message, so a mutant that
  // skips this branch and falls through to validateBackendUrl's OWN
  // "Invalid URL" 400 (still 400, but a DIFFERENT message) survives it.
  test("a relative openapi_url gets the exact 'must be absolute' message, not a fallthrough one", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/discovery/preview`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ openapi_url: "/relative/openapi.json" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("openapi_url must be an absolute http(s) URL");
  });

  // Kills the 5-mutant cluster on the `!startsWith("http://") &&
  // !startsWith("https://")` condition (whole-condition-false, either
  // string-literal argument emptied, the 2nd clause's negation removed, and
  // startsWith->endsWith): a URL that does NOT start with either prefix but
  // DOES literally END with the substring "https://" only correctly gets
  // rejected if BOTH clauses are evaluated as originally written — any of
  // those 5 mutants makes the whole condition wrongly evaluate to false,
  // letting it fall through to validateBackendUrl, which then rejects it
  // for an UNRELATED reason (bad protocol) with a different message.
  test("a URL ending in the literal substring 'https://' (but not starting with it) is still rejected as non-absolute", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/discovery/preview`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ openapi_url: "ftp://foo/bar-https://" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("openapi_url must be an absolute http(s) URL");
  });
});

describe("POST /admin-api/discovery/preview — openapi_url validateBackendUrl rejection (exact message)", () => {
  // Kills the `!validation.valid` guard's forced-false/block-emptied/
  // template-emptied cluster: with the check disabled, a blocked-private-IP
  // URL would instead reach discoverToolsFromOpenApi (with an undefined
  // pinned IP) and fail there with a DISCOVERY_ERROR — a different code AND
  // message than this guard's own VALIDATION_ERROR.
  test("a blocked-private-IP openapi_url gets the exact SSRF-guard message", async () => {
    await startApp();
    const original = config.allowPrivateIps;
    (config as Record<string, unknown>).allowPrivateIps = false;
    try {
      const res = await fetch(`${adminBase}/admin-api/discovery/preview`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ openapi_url: "http://127.0.0.1:1/openapi.json" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("Invalid openapi_url: IP is in a blocked private range: 127.0.0.1");
    } finally {
      (config as Record<string, unknown>).allowPrivateIps = original;
    }
  });
});

describe("POST /admin-api/discovery/preview-graphql — absolute-URL and validateBackendUrl guards (exact messages)", () => {
  // Kills the `typeof body.graphql_url === "string"` ternary's
  // forced-true mutant: a non-string (but truthy) graphql_url must fall
  // back to "" (still handled cleanly, exact same 400), not be used
  // AS-IS — which would call `.startsWith` on a non-string and crash.
  test("a non-string graphql_url still gets the exact 'must be absolute' 400 (not a crash)", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/discovery/preview-graphql`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ graphql_url: 12345 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("graphql_url must be an absolute http(s) URL");
  });

  // Same 5-mutant "ends with https:// but doesn't start with it" cluster as
  // the openapi_url guard above, mirrored for the graphql_url guard.
  test("a URL ending in the literal substring 'https://' (but not starting with it) is still rejected as non-absolute", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/discovery/preview-graphql`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ graphql_url: "ftp://foo/bar-https://" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("graphql_url must be an absolute http(s) URL");
  });

  // Same block-emptied/message-emptied gap as openapi_url's relative-URL
  // test above — the existing sibling test for this route only asserts
  // status 400, never the message.
  test("a relative graphql_url gets the exact 'must be absolute' message, not a fallthrough one", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/discovery/preview-graphql`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ graphql_url: "/relative" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("graphql_url must be an absolute http(s) URL");
  });

  // Mirrors the openapi_url SSRF-guard-message test above.
  test("a blocked-private-IP graphql_url gets the exact SSRF-guard message", async () => {
    await startApp();
    const original = config.allowPrivateIps;
    (config as Record<string, unknown>).allowPrivateIps = false;
    try {
      const res = await fetch(`${adminBase}/admin-api/discovery/preview-graphql`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ graphql_url: "http://127.0.0.1:1/graphql" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("Invalid graphql_url: IP is in a blocked private range: 127.0.0.1");
    } finally {
      (config as Record<string, unknown>).allowPrivateIps = original;
    }
  });
});

describe("POST /admin-api/discovery/preview — manual tools[] branch (never covered by the existing test)", () => {
  test("a literal tools[] array is previewed, sourced as 'manual', with the exact recordAudit call", async () => {
    await startApp();
    const spy = spyOn(auditMod, "recordAudit");
    try {
      const res = await fetch(`${adminBase}/admin-api/discovery/preview`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          tools: [
            {
              name: "manual_tool",
              method: "GET",
              endpoint: "/manual",
              description: "A manually supplied tool",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        count: number;
        tools: { name: string; method: string; endpoint: string; description: string }[];
      };
      expect(body.count).toBe(1);
      expect(body.tools[0]).toEqual({
        name: "manual_tool",
        method: "GET",
        endpoint: "/manual",
        description: "A manually supplied tool",
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][1]).toBe("discovery.preview_manual");
      expect(spy.mock.calls[0][2]).toBe("manual");
      expect(spy.mock.calls[0][3]).toEqual({ count: 1 });
    } finally {
      spy.mockRestore();
    }
  });

  // hasTools = Array.isArray(manualTools) has NO length check (unlike
  // hasOpenapi/hasCurl/hasPostman, which all require non-empty content) —
  // an empty array is a genuinely valid, intentional "preview zero tools".
  test("an empty tools[] array is a valid preview of zero tools, not a 'no source' 400", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/discovery/preview`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ tools: [] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number };
    expect(body.count).toBe(0);
  });

  // Kills hasTools's `Array.isArray` forced-true mutant: a truthy NON-array
  // value must fall through to the "no discovery source" 400 with the exact
  // message, not be treated as if it were a tools[] array.
  test("a non-array truthy tools value is treated as no source provided", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/discovery/preview`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ tools: "not-an-array" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Provide one of 'openapi_url', 'tools', 'curl_input', or 'postman_collection'");
  });

  describe("tools[] cap boundary (toolsCountCapError)", () => {
    test("exactly at the configured maximum is allowed, not rejected", async () => {
      await startApp();
      const original = config.maxToolsPerClient;
      (config as Record<string, unknown>).maxToolsPerClient = 2;
      try {
        const res = await fetch(`${adminBase}/admin-api/discovery/preview`, {
          method: "POST",
          headers: bearer(),
          body: JSON.stringify({
            tools: [
              { name: "a", method: "GET", endpoint: "/a", description: "a", inputSchema: {} },
              { name: "b", method: "GET", endpoint: "/b", description: "b", inputSchema: {} },
            ],
          }),
        });
        expect(res.status).toBe(200);
      } finally {
        (config as Record<string, unknown>).maxToolsPerClient = original;
      }
    });

    test("exceeding the cap returns the exact message with the configured limit", async () => {
      await startApp();
      const original = config.maxToolsPerClient;
      (config as Record<string, unknown>).maxToolsPerClient = 1;
      try {
        const res = await fetch(`${adminBase}/admin-api/discovery/preview`, {
          method: "POST",
          headers: bearer(),
          body: JSON.stringify({
            tools: [
              { name: "a", method: "GET", endpoint: "/a", description: "a", inputSchema: {} },
              { name: "b", method: "GET", endpoint: "/b", description: "b", inputSchema: {} },
            ],
          }),
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe("VALIDATION_ERROR");
        expect(body.error.message).toBe("Parsed 2 tools, exceeds maximum of 1");
      } finally {
        (config as Record<string, unknown>).maxToolsPerClient = original;
      }
    });
  });

  test("a path-traversal endpoint is rejected via findToolEndpointError with the exact message", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/discovery/preview`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({
        tools: [{ name: "evil", method: "GET", endpoint: "/../../etc/passwd", description: "x", inputSchema: {} }],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe('Tool "evil": Endpoint contains invalid path segment: /../../etc/passwd');
  });
});

describe("POST /admin-api/discovery/preview — hasPostman falsy-but-not-absent boundaries", () => {
  // Kills the `postmanCollection !== ""` clause: an explicit empty string
  // must be treated as "not provided", falling to the shared "no source"
  // 400 (not attempting to parse "" as a collection).
  test("an empty-string postman_collection is treated as not provided", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/discovery/preview`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ postman_collection: "" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Provide one of 'openapi_url', 'tools', 'curl_input', or 'postman_collection'");
  });

  // Kills the `postmanCollection !== null` clause the same way.
  test("an explicit null postman_collection is treated as not provided", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/discovery/preview`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ postman_collection: null }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Provide one of 'openapi_url', 'tools', 'curl_input', or 'postman_collection'");
  });

  // A FALSY-but-not-undefined/null/"" value (0) must still count as
  // "provided" — proves the boundary is exactly those 3 values, not a bare
  // truthiness check. It's provided, attempted, and fails downstream in
  // parsePostmanCollection instead (a genuinely different code path/message
  // than the shared "no source" 400 above).
  test("a falsy-but-provided (0) postman_collection is still attempted, not treated as absent", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/discovery/preview`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ postman_collection: 0 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("Postman collection must be a JSON object");
  });
});

describe("POST /admin-api/discovery/preview — hasCurl boundary (curlInput.trim().length)", () => {
  // Kills the `.trim()`-removed MethodExpression mutant on hasCurl: a
  // whitespace-ONLY curl_input must be treated as "not provided" (falling
  // to the shared "no source" 400) — without `.trim()`, its raw non-empty
  // length would wrongly count as "provided", reaching parseCurlCommand
  // instead (which fails with a DIFFERENT message).
  test("a whitespace-only curl_input is treated as not provided", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/discovery/preview`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ curl_input: "   " }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Provide one of 'openapi_url', 'tools', 'curl_input', or 'postman_collection'");
  });
});

describe("POST /admin-api/discovery/preview — postman_collection as a JSON string", () => {
  // Kills the `typeof postmanCollection === "string"` ternary's
  // forced-false/StringLiteral-emptied mutants: a JSON-STRING collection
  // (not yet an object) must be JSON.parse'd before use. Previously
  // completely untested — the existing/sibling tests only ever send an
  // already-parsed object.
  test("a JSON-stringified postman_collection is parsed and previewed successfully", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/discovery/preview`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({
        postman_collection: JSON.stringify({
          item: [{ name: "Ping", request: { method: "GET", url: "https://api.example.com/ping" } }],
        }),
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; tools: { method: string; endpoint: string }[] };
    expect(body.count).toBe(1);
    expect(body.tools[0].method).toBe("GET");
    expect(body.tools[0].endpoint).toBe("/ping");
  });
});

describe("POST /admin-api/discovery/preview — curl/postman recordAudit", () => {
  test("records discovery.preview_manual with source 'curl' and the exact count detail", async () => {
    await startApp();
    const spy = spyOn(auditMod, "recordAudit");
    try {
      const res = await fetch(`${adminBase}/admin-api/discovery/preview`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ curl_input: `curl -X GET https://api.example.com/ping` }),
      });
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][1]).toBe("discovery.preview_manual");
      expect(spy.mock.calls[0][2]).toBe("curl");
      expect(spy.mock.calls[0][3]).toEqual({ count: 1 });
    } finally {
      spy.mockRestore();
    }
  });

  test("records discovery.preview_manual with source 'postman' and the exact count detail", async () => {
    await startApp();
    const spy = spyOn(auditMod, "recordAudit");
    try {
      const res = await fetch(`${adminBase}/admin-api/discovery/preview`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          postman_collection: {
            item: [{ name: "Ping", request: { method: "GET", url: "https://api.example.com/ping" } }],
          },
        }),
      });
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][1]).toBe("discovery.preview_manual");
      expect(spy.mock.calls[0][2]).toBe("postman");
      expect(spy.mock.calls[0][3]).toEqual({ count: 1 });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("POST /admin-api/discovery/preview-graphql — recordAudit + field mapping", () => {
  test("records discovery.preview_graphql with the exact url target and count detail", async () => {
    await startApp();
    const spy = spyOn(auditMod, "recordAudit");
    try {
      const url = `http://127.0.0.1:${upstreamPort}/api/gql`;
      const res = await fetch(`${adminBase}/admin-api/discovery/preview-graphql`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ graphql_url: url }),
      });
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][1]).toBe("discovery.preview_graphql");
      expect(spy.mock.calls[0][2]).toBe(url);
      expect(spy.mock.calls[0][3]).toEqual({ count: 2 });
    } finally {
      spy.mockRestore();
    }
  });

  // Kills the `pathname || "/graphql"` fallback's own StringLiteral/
  // LogicalOperator mutants: a real, non-default path must be reflected
  // exactly, never the hardcoded fallback (a WHATWG URL's pathname is never
  // actually falsy, so if a mutant swapped `||` for `&&` the endpoint would
  // wrongly ALWAYS become "/graphql" regardless of the true path).
  test("the endpoint field reflects the real graphql_url path, not the '/graphql' fallback", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/discovery/preview-graphql`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ graphql_url: `http://127.0.0.1:${upstreamPort}/api/gql` }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tools: { endpoint: string; method: string; description: string }[] };
    expect(body.tools.every((t) => t.endpoint === "/api/gql")).toBe(true);
    expect(body.tools.every((t) => t.method === "POST")).toBe(true);
  });

  describe("include_mutations default/boundary", () => {
    test("omitted include_mutations defaults to true (both query and mutation fields discovered)", async () => {
      await startApp();
      const res = await fetch(`${adminBase}/admin-api/discovery/preview-graphql`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ graphql_url: `http://127.0.0.1:${upstreamPort}/api/gql` }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { count: number; tools: { name: string }[] };
      expect(body.count).toBe(2);
      expect(body.tools.map((t) => t.name).sort()).toEqual(["create_thing", "ping"]);
    });

    test("include_mutations: false excludes the mutation field", async () => {
      await startApp();
      const res = await fetch(`${adminBase}/admin-api/discovery/preview-graphql`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ graphql_url: `http://127.0.0.1:${upstreamPort}/api/gql`, include_mutations: false }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { count: number; tools: { name: string }[] };
      expect(body.count).toBe(1);
      expect(body.tools[0].name).toBe("ping");
    });

    // Kills `!== false` -> `=== false`-shaped mutants: any falsy-but-NOT-
    // `false` value (here, 0) must still be treated as "include mutations"
    // (only the exact boolean `false` opts out).
    test("a falsy-but-not-false include_mutations (0) still includes mutations", async () => {
      await startApp();
      const res = await fetch(`${adminBase}/admin-api/discovery/preview-graphql`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ graphql_url: `http://127.0.0.1:${upstreamPort}/api/gql`, include_mutations: 0 }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { count: number };
      expect(body.count).toBe(2);
    });
  });
});
