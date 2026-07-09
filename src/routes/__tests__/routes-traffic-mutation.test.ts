/**
 * Stryker mutation-testing backstop for src/routes/admin/traffic.ts —
 * domain 8. Baseline: 47 mutants, 0 killed / 47 survived — zero test
 * coverage of any kind existed before this. All line:col citations below
 * were read directly from reports/mutation/result.json.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting, getDb } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { requestIdMiddleware } from "../../middleware/request-id.js";
import { recordTraffic } from "../../observability/traffic.js";
import { createUser } from "../../security/user-store.js";
import { createSession } from "../../security/session-store.js";
import { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } from "../../security/cookies.js";
import { createTeam, setUserTeam, setClientTeam } from "../../admin/entities/teams.js";
import * as proxyMod from "../../proxy/proxy.js";
import * as auditMod from "../../admin/audit/audit.js";
import type { RestToolDefinition } from "../../mcp/types.js";

const ADMIN_KEY = "test-admin-key-traffic-mut";

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

function insertRawTraffic(argsJson: string): number {
  const { id } = getDb()
    .query(
      `INSERT INTO tool_traffic (mcp_tool_name, client_name, tool_name, key_id, args_json, preview, is_error, duration_ms, created_at)
       VALUES ('svc__t', 'svc', 't', NULL, ?, 'x', 0, 1, ?) RETURNING id`,
    )
    .get(argsJson, Date.now()) as { id: number };
  return id;
}

beforeEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
});

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

describe("GET /admin-api/traffic — list + filters", () => {
  // Kills 21:19-29 StringLiteral (route path emptied) and 21:64-28:2
  // BlockStatement (whole handler emptied) and 27:36-87 ObjectLiteral
  // (the filter object passed to listTraffic emptied).
  test("lists every recorded record with no filters", async () => {
    await withApp(async (baseUrl) => {
      recordTraffic({
        mcpToolName: "svc__a",
        clientName: "svc",
        toolName: "a",
        keyId: null,
        args: {},
        result: { content: [{ type: "text", text: "ok" }] },
        durationMs: 1,
      });
      const res = await fetch(`${baseUrl}/admin-api/traffic`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[] };
      expect(body.items).toHaveLength(1);
    });
  });

  // Kills 22:22-58 ConditionalExpression 'false' / StringLiteral '""'
  // ("string" emptied -- client filter never applied even for a real
  // string) via a narrowing fixture (2 clients, filter picks one).
  test("?client=<name> narrows to that client's records alone", async () => {
    await withApp(async (baseUrl) => {
      recordTraffic({
        mcpToolName: "svc-x__a",
        clientName: "svc-x",
        toolName: "a",
        keyId: null,
        args: {},
        result: { content: [] },
        durationMs: 1,
      });
      recordTraffic({
        mcpToolName: "svc-y__a",
        clientName: "svc-y",
        toolName: "a",
        keyId: null,
        args: {},
        result: { content: [] },
        durationMs: 1,
      });
      const res = await fetch(`${baseUrl}/admin-api/traffic?client=svc-x`, { headers: bearer() });
      const body = (await res.json()) as { items: { clientName: string }[] };
      expect(body.items).toHaveLength(1);
      expect(body.items[0].clientName).toBe("svc-x");
    });
  });

  // Kills 22:22-58 ConditionalExpression 'true' / EqualityOperator
  // (forces the client filter to always apply, even to a non-string
  // array from a repeated query key) -- bun:sqlite throws when an array
  // is bound as a query parameter, turning into a 500; real code ignores
  // the non-string value and stays 200.
  test("a non-string ?client value (repeated query key) doesn't crash the request", async () => {
    await withApp(async (baseUrl) => {
      recordTraffic({
        mcpToolName: "svc__a",
        clientName: "svc",
        toolName: "a",
        keyId: null,
        args: {},
        result: { content: [] },
        durationMs: 1,
      });
      const res = await fetch(`${baseUrl}/admin-api/traffic?client=a&client=b`, { headers: bearer() });
      expect(res.status).toBe(200);
    });
  });

  // Kills 23:20-54's identical 4-mutant cluster for the tool filter,
  // using the same narrowing + non-string-array techniques.
  test("?tool=<name> narrows to that tool's records alone", async () => {
    await withApp(async (baseUrl) => {
      recordTraffic({
        mcpToolName: "svc__a",
        clientName: "svc",
        toolName: "a",
        keyId: null,
        args: {},
        result: { content: [] },
        durationMs: 1,
      });
      recordTraffic({
        mcpToolName: "svc__b",
        clientName: "svc",
        toolName: "b",
        keyId: null,
        args: {},
        result: { content: [] },
        durationMs: 1,
      });
      const res = await fetch(`${baseUrl}/admin-api/traffic?tool=a`, { headers: bearer() });
      const body = (await res.json()) as { items: { toolName: string }[] };
      expect(body.items).toHaveLength(1);
      expect(body.items[0].toolName).toBe("a");
    });
  });

  test("a non-string ?tool value (repeated query key) doesn't crash the request", async () => {
    await withApp(async (baseUrl) => {
      recordTraffic({
        mcpToolName: "svc__a",
        clientName: "svc",
        toolName: "a",
        keyId: null,
        args: {},
        result: { content: [] },
        durationMs: 1,
      });
      const res = await fetch(`${baseUrl}/admin-api/traffic?tool=a&tool=b`, { headers: bearer() });
      expect(res.status).toBe(200);
    });
  });

  // Kills 24:22-49 ConditionalExpression 'true'/'false' / EqualityOperator
  // / StringLiteral '""' ("true" emptied) -- the errors-only filter.
  test("?errors=true narrows to error records only", async () => {
    await withApp(async (baseUrl) => {
      recordTraffic({
        mcpToolName: "svc__a",
        clientName: "svc",
        toolName: "a",
        keyId: null,
        args: {},
        result: { content: [], isError: false },
        durationMs: 1,
      });
      recordTraffic({
        mcpToolName: "svc__b",
        clientName: "svc",
        toolName: "b",
        keyId: null,
        args: {},
        result: { content: [], isError: true },
        durationMs: 1,
      });
      const withoutFilter = await (await fetch(`${baseUrl}/admin-api/traffic`, { headers: bearer() })).json();
      expect((withoutFilter as { items: unknown[] }).items).toHaveLength(2);

      const res = await fetch(`${baseUrl}/admin-api/traffic?errors=true`, { headers: bearer() });
      const body = (await res.json()) as { items: { toolName: string }[] };
      expect(body.items).toHaveLength(1);
      expect(body.items[0].toolName).toBe("b");
    });
  });

  // Kills 25:18-54's identical 4-mutant cluster for the cursor filter,
  // verified via genuine pagination across two pages (real vs
  // silently-dropped cursor produce different second pages).
  test("?cursor=<nextCursor> paginates to a genuinely different second page", async () => {
    await withApp(async (baseUrl) => {
      recordTraffic({
        mcpToolName: "svc__a",
        clientName: "svc",
        toolName: "a",
        keyId: null,
        args: {},
        result: { content: [] },
        durationMs: 1,
      });
      recordTraffic({
        mcpToolName: "svc__b",
        clientName: "svc",
        toolName: "b",
        keyId: null,
        args: {},
        result: { content: [] },
        durationMs: 1,
      });
      const page1 = (await (await fetch(`${baseUrl}/admin-api/traffic?limit=1`, { headers: bearer() })).json()) as {
        items: Array<{ id: number }>;
        nextCursor?: string;
      };
      expect(page1.items).toHaveLength(1);
      expect(page1.nextCursor).toBeDefined();

      const page2 = (await (
        await fetch(`${baseUrl}/admin-api/traffic?limit=1&cursor=${page1.nextCursor}`, { headers: bearer() })
      ).json()) as { items: Array<{ id: number }> };
      expect(page2.items).toHaveLength(1);
      expect(page2.items[0].id).not.toBe(page1.items[0].id);
    });
  });

  // Unlike the client/tool cases above, a non-string cursor doesn't crash
  // even under the forced-true mutant: Number(nonStringValue) coerces to
  // a valid (if useless) NaN before binding, so bun:sqlite never throws.
  // Instead the forced-true mutant silently passes the array through as
  // the cursor, giving `Number(["a","b"])` -> NaN -> `id < NaN` (always
  // false in SQL) -> zero items, instead of real code's "cursor ignored,
  // return everything". Assert the item count, not just the status.
  test("a non-string ?cursor value (repeated query key) is ignored, not silently zeroing the results", async () => {
    await withApp(async (baseUrl) => {
      recordTraffic({
        mcpToolName: "svc__a",
        clientName: "svc",
        toolName: "a",
        keyId: null,
        args: {},
        result: { content: [] },
        durationMs: 1,
      });
      const res = await fetch(`${baseUrl}/admin-api/traffic?cursor=a&cursor=b`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[] };
      expect(body.items).toHaveLength(1);
    });
  });

  // Kills 26:17-52's identical cluster for the limit param -- verified
  // via actual narrowing (established technique from earlier domain-8
  // files).
  test("?limit=<n> caps the number of returned items", async () => {
    await withApp(async (baseUrl) => {
      for (const t of ["a", "b", "c"]) {
        recordTraffic({
          mcpToolName: `svc__${t}`,
          clientName: "svc",
          toolName: t,
          keyId: null,
          args: {},
          result: { content: [] },
          durationMs: 1,
        });
      }
      const res = await fetch(`${baseUrl}/admin-api/traffic?limit=1`, { headers: bearer() });
      const body = (await res.json()) as { items: unknown[] };
      expect(body.items).toHaveLength(1);
    });
  });
});

describe("GET /admin-api/traffic/:id", () => {
  // Kills 30:19-33 StringLiteral (route path emptied) and 30:84-37:2
  // BlockStatement (whole handler emptied).
  test("returns the exact record for a known id", async () => {
    await withApp(async (baseUrl) => {
      recordTraffic({
        mcpToolName: "svc__a",
        clientName: "svc",
        toolName: "a",
        keyId: null,
        args: { q: 1 },
        result: { content: [{ type: "text", text: "hi" }] },
        durationMs: 1,
      });
      const list = (await (await fetch(`${baseUrl}/admin-api/traffic`, { headers: bearer() })).json()) as {
        items: Array<{ id: number }>;
      };
      const id = list.items[0].id;
      const res = await fetch(`${baseUrl}/admin-api/traffic/${id}`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: number };
      expect(body.id).toBe(id);
    });
  });

  // Kills 32:7-11 BooleanLiteral/ConditionalExpression true/false (the
  // `!rec` guard) and 33:19-38 / 33:40-66 StringLiteral (the
  // TRAFFIC_NOT_FOUND code/message emptied).
  test("returns the exact TRAFFIC_NOT_FOUND 404 for an unknown id", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/traffic/999999`, { headers: bearer() });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("TRAFFIC_NOT_FOUND");
      expect(body.error.message).toBe("Traffic record not found");
    });
  });
});

describe("POST /admin-api/traffic/:id/replay", () => {
  // Kills 39:20-41 StringLiteral (route path emptied), 39:115-55:2
  // BlockStatement (whole handler emptied), 47:7-49:4 BlockStatement
  // (the JSON.parse try-block emptied -- args would stay unassigned
  // instead of the real recorded args), 53:38-54 / 53:73-87
  // StringLiteral/ObjectLiteral (the exact audit action/detail emptied).
  // Spies on proxyToolCall directly rather than mocking global fetch, so
  // the exact PARSED args (not just "some result") are asserted.
  test("replays with the exact recorded args and records the exact audit detail", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-replay");
      recordTraffic({
        mcpToolName: "svc-replay__t",
        clientName: "svc-replay",
        toolName: "t",
        keyId: null,
        args: { q: "hello" },
        result: { content: [{ type: "text", text: "original" }] },
        durationMs: 1,
      });
      const list = (await (await fetch(`${baseUrl}/admin-api/traffic`, { headers: bearer() })).json()) as {
        items: Array<{ id: number }>;
      };
      const id = list.items[0].id;

      const fakeResult = { content: [{ type: "text", text: "replayed" }] };
      const proxySpy = spyOn(proxyMod, "proxyToolCall").mockResolvedValue(fakeResult);
      const auditSpy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/traffic/${id}/replay`, { method: "POST", headers: bearer() });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual(fakeResult);
        expect(proxySpy).toHaveBeenCalledWith("svc-replay__t", { q: "hello" });
        expect(auditSpy).toHaveBeenCalledWith(expect.any(String), "traffic.replay", "svc-replay__t", { id });
      } finally {
        proxySpy.mockRestore();
        auditSpy.mockRestore();
      }
    });
  });

  // Kills 49:11-51:4 BlockStatement (the JSON.parse catch-block emptied
  // -- a malformed argsJson would leave `args` unassigned instead of
  // falling back to {}). A raw row with deliberately-invalid JSON
  // (bypassing recordTraffic's own safeJson, which never produces
  // invalid JSON) reaches this path.
  test("a record with malformed argsJson replays with an empty args fallback, not a crash", async () => {
    await withApp(async (baseUrl) => {
      const id = insertRawTraffic("not valid json{");
      const proxySpy = spyOn(proxyMod, "proxyToolCall").mockResolvedValue({ content: [] });
      try {
        const res = await fetch(`${baseUrl}/admin-api/traffic/${id}/replay`, { method: "POST", headers: bearer() });
        expect(res.status).toBe(200);
        expect(proxySpy).toHaveBeenCalledWith("svc__t", {});
      } finally {
        proxySpy.mockRestore();
      }
    });
  });

  // Kills 41:7-11 BooleanLiteral/ConditionalExpression true/false (the
  // `!rec` guard -- this handler has its OWN independent copy, separate
  // from the GET /traffic/:id handler's copy above) and 42:19-38 /
  // 42:40-66 StringLiteral (the TRAFFIC_NOT_FOUND code/message emptied).
  test("returns the exact TRAFFIC_NOT_FOUND 404 for an unknown id", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/traffic/999999/replay`, { method: "POST", headers: bearer() });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("TRAFFIC_NOT_FOUND");
      expect(body.error.message).toBe("Traffic record not found");
    });
  });

  // Kills 45:7-70 ConditionalExpression 'true' / LogicalOperator (&& ->
  // ||, which short-circuits to true whenever clientName is merely
  // present, regardless of access) / BooleanLiteral (negation removed) --
  // all three would incorrectly block (hang on a bare `return` with no
  // response) a request that should be ALLOWED. A Bearer caller (always
  // allowed) replaying a record that DOES have a clientName resolves
  // rather than hanging.
  test("a Bearer caller can replay a record that has a clientName", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-replay-allowed");
      recordTraffic({
        mcpToolName: "svc-replay-allowed__t",
        clientName: "svc-replay-allowed",
        toolName: "t",
        keyId: null,
        args: {},
        result: { content: [] },
        durationMs: 1,
      });
      const list = (await (await fetch(`${baseUrl}/admin-api/traffic`, { headers: bearer() })).json()) as {
        items: Array<{ id: number }>;
      };
      const id = list.items[0].id;
      const proxySpy = spyOn(proxyMod, "proxyToolCall").mockResolvedValue({ content: [] });
      try {
        const res = await fetch(`${baseUrl}/admin-api/traffic/${id}/replay`, { method: "POST", headers: bearer() });
        expect(res.status).toBe(200);
      } finally {
        proxySpy.mockRestore();
      }
    });
  });

  // Kills 45:7-70 ConditionalExpression 'false' (the access guard never
  // denies, even for a genuinely cross-team-denied caller).
  test("a session caller from a different team gets the exact CLIENT_NOT_FOUND 404 on replay", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-replay-denied");
      const otherTeam = createTeam("other-team-for-traffic-replay", "test");
      if (typeof otherTeam === "string") throw new Error("createTeam failed");
      setClientTeam("svc-replay-denied", otherTeam.id);
      recordTraffic({
        mcpToolName: "svc-replay-denied__t",
        clientName: "svc-replay-denied",
        toolName: "t",
        keyId: null,
        args: {},
        result: { content: [] },
        durationMs: 1,
      });
      const list = (await (await fetch(`${baseUrl}/admin-api/traffic`, { headers: bearer() })).json()) as {
        items: Array<{ id: number }>;
      };
      const id = list.items[0].id;
      const headers = teamSessionHeaders("traffic-replay-denied-user");
      const res = await fetch(`${baseUrl}/admin-api/traffic/${id}/replay`, { method: "POST", headers });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
    });
  });
});
