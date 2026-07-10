/**
 * Stryker mutation-testing backstop for src/routes/admin/tools.ts — domain 8.
 * No existing test file covered this route file before (confirmed via a
 * directory listing of src/routes/__tests__ before writing this).
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
import * as proxyMod from "../../proxy/proxy.js";
import { cacheKey, cacheGet, cacheSet } from "../../tool-policies/response-cache.js";
import { listExamples } from "../../tool-meta/tool-examples.js";

const ADMIN_KEY = "test-admin-key-tools-mut";

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

async function reg(name: string, toolNames: string[] = ["t"]): Promise<void> {
  await registry.register(
    name,
    toolNames.map((n) => ({
      name: n,
      method: "GET" as const,
      endpoint: `/${n}`,
      description: "d",
      inputSchema: { type: "object", properties: {} },
    })),
    "http://example.com/health",
    "1.2.3.4",
    "http://example.com",
    "1.2.3.4",
  );
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

/** Registers a client, then denies access to it from a session in a different team. */
function denyHeaders(clientName: string, userSuffix: string): Record<string, string> {
  const otherTeam = createTeam(`other-team-${userSuffix}`, "test");
  if (typeof otherTeam === "string") throw new Error("createTeam failed");
  setClientTeam(clientName, otherTeam.id);
  return teamSessionHeaders(`user-${userSuffix}`);
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

describe("PATCH /admin-api/clients/:name/tools/:tool", () => {
  // Kills the ensureClientAccess guard's forced/negation-removed directions
  // (this route's OWN independent copy of the call site).
  test("a session caller from a different team gets the exact CLIENT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-patch-denied");
      const headers = denyHeaders("svc-patch-denied", "patch-denied");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-patch-denied/tools/t`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
    });
  });

  // Kills the `?? {}` body fallback flipped to `&&`: with no body/Content-Type
  // at all, req.body is genuinely undefined; `??` falls back to {} (an empty,
  // valid object with no mutation keys defined) so dispatchToolMutations does
  // nothing and the route responds 200 "updated" even for an unknown
  // client/tool (it never checks existence itself for an empty patch) --
  // `&&` would leave body undefined and crash on the typeof/Array.isArray
  // checks below it (which read `body`, not `req.body`).
  test("no request body at all is a graceful 200, not a crash", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-patch-nobody/tools/t`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; name: string; tool: string };
      expect(body).toEqual({ status: "updated", name: "svc-patch-nobody", tool: "t" });
    });
  });

  // Kills the `Array.isArray(body)` clause (a JSON array top-level body) and
  // the exact validation message.
  test("an array request body fails validation with the exact message", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-patch-arraybody");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-patch-arraybody/tools/t`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify([1, 2, 3]),
      });
      expect(res.status).toBe(400);
      const bodyJson = (await res.json()) as { error: { code: string; message: string } };
      expect(bodyJson.error.code).toBe("VALIDATION_ERROR");
      expect(bodyJson.error.message).toBe("request body must be a JSON object");
    });
  });

  // Kills the `outcome !== null` guard's forced-false direction (dispatcher
  // already wrote a 400; the route must NOT also write its own 200) via a
  // genuine validation failure from a real mutation key.
  test("an invalid mutation value returns the dispatcher's own validation error, not a 200", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-patch-invalidkey");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-patch-invalidkey/tools/t`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ enabled: "not-a-boolean" }),
      });
      expect(res.status).toBe(400);
      const bodyJson = (await res.json()) as { error: { code: string; message: string } };
      expect(bodyJson.error.code).toBe("VALIDATION_ERROR");
      expect(bodyJson.error.message).toBe("enabled must be a boolean");
    });
  });

  // Kills the `outcome !== null` guard's forced-false direction via the
  // dispatcher's OTHER failure kind (tool_not_found), on a real client but an
  // unknown tool name.
  test("an unknown tool returns the exact TOOL_NOT_FOUND 404, not a 200", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-patch-unknowntool");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-patch-unknowntool/tools/does-not-exist`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(404);
      const bodyJson = (await res.json()) as { error: { code: string; message: string } };
      expect(bodyJson.error.code).toBe("TOOL_NOT_FOUND");
      expect(bodyJson.error.message).toBe("Client or tool not found");
    });
  });

  // Kills the `outcome !== null` guard's forced-true direction (a genuine
  // success must actually reach the 200 response) and the response object's
  // literal fields, verified against a real persisted side effect.
  test("a valid mutation succeeds, persists, and returns the exact response shape", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-patch-ok");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-patch-ok/tools/t`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(200);
      const bodyJson = (await res.json()) as { status: string; name: string; tool: string };
      expect(bodyJson).toEqual({ status: "updated", name: "svc-patch-ok", tool: "t" });
      const tool = registry.getClientTools("svc-patch-ok")?.find((t) => t.name === "t");
      expect(tool?.enabled).toBe(false);
    });
  });
});

describe("PATCH /admin-api/clients/:name/tools (bulk enable/disable)", () => {
  // This endpoint has NO ensureClientAccess call (confirmed by reading the
  // source) -- no team-scoping test is applicable here.

  // Kills the `!Array.isArray(toolNames)` clause with a TRUTHY non-array
  // value (a string), distinguishing a forced-true mutant from a merely
  // absent value.
  test("a non-array tool_names fails validation with the exact message", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-bulk-badtype/tools`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ tool_names: "not-an-array", enabled: true }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("tool_names (string[]) and enabled (boolean) are required");
    });
  });

  // Kills the `.some((n) => typeof n !== "string")` clause: a mixed array
  // (one real string + one non-string) must fail, while an all-string array
  // (tested below, in the success case) must pass -- an all-empty or
  // single-item fixture couldn't distinguish "some" from "every"/"none".
  test("a tool_names array with a non-string element fails validation", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-bulk-mixedarray/tools`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ tool_names: ["a", 123], enabled: true }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("tool_names (string[]) and enabled (boolean) are required");
    });
  });

  // Kills the `typeof enabled !== "boolean"` clause with a TRUTHY non-boolean
  // value (a string), distinguishing a forced-true mutant from an absent one.
  test("a non-boolean enabled fails validation with the exact message", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-bulk-badenabled/tools`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ tool_names: ["a"], enabled: "true" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("tool_names (string[]) and enabled (boolean) are required");
    });
  });

  // Kills the `if (results[toolName])` guard (forced true/false) and the
  // `enabled ? "tool.enable" : "tool.disable"` ternary, plus the `{ bulk:
  // true }` audit-detail literal -- via TWO distinct tool names, one that
  // really exists on the client (audited) and one that doesn't (silently
  // skipped, not audited), so the per-item result truly reflects
  // setToolEnabled's own per-tool outcome rather than a blanket true/false.
  test("enabling two distinct tools audits only the one that actually exists", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-bulk-ok", ["real-tool"]);
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/clients/svc-bulk-ok/tools`, {
          method: "PATCH",
          headers: bearer(),
          body: JSON.stringify({ tool_names: ["real-tool", "ghost-tool"], enabled: true }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { results: Record<string, boolean> };
        expect(body.results).toEqual({ "real-tool": true, "ghost-tool": false });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith(expect.any(String), "tool.enable", "svc-bulk-ok__real-tool", { bulk: true });
        const tool = registry.getClientTools("svc-bulk-ok")?.find((t) => t.name === "real-tool");
        expect(tool?.enabled).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  });

  // Kills the ternary's OTHER branch (enabled: false -> "tool.disable").
  test("disabling a real tool audits with the exact tool.disable action", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-bulk-disable", ["real-tool"]);
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/clients/svc-bulk-disable/tools`, {
          method: "PATCH",
          headers: bearer(),
          body: JSON.stringify({ tool_names: ["real-tool"], enabled: false }),
        });
        expect(res.status).toBe(200);
        expect(spy).toHaveBeenCalledWith(expect.any(String), "tool.disable", "svc-bulk-disable__real-tool", {
          bulk: true,
        });
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("POST /admin-api/clients/:name/tools/:tool/test", () => {
  // Kills this route's OWN independent copy of the ensureClientAccess guard.
  test("a session caller from a different team gets the exact CLIENT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-testcall-denied");
      const headers = denyHeaders("svc-testcall-denied", "testcall-denied");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-testcall-denied/tools/t/test`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
    });
  });

  // Kills the `!registry.resolveTool(...)` guard and the exact 404 code/message.
  test("an unknown tool returns the exact TOOL_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-testcall-unknown");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-testcall-unknown/tools/nope/test`, {
        method: "POST",
        headers: bearer(),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("TOOL_NOT_FOUND");
      expect(body.error.message).toBe("Client or tool not found");
    });
  });

  // Kills the `?? {}` body fallback flipped to `&&`: no body/Content-Type at
  // all means req.body is genuinely undefined; the real code falls back to
  // {} (proxyToolCall is called with an empty object), while `&&` would
  // pass `undefined` through instead.
  test("no request body at all calls proxyToolCall with an empty args object", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-testcall-nobody");
      const proxySpy = spyOn(proxyMod, "proxyToolCall").mockResolvedValue({ content: [] });
      try {
        const res = await fetch(`${baseUrl}/admin-api/clients/svc-testcall-nobody/tools/t/test`, {
          method: "POST",
          headers: { Authorization: `Bearer ${ADMIN_KEY}` },
        });
        expect(res.status).toBe(200);
        expect(proxySpy).toHaveBeenCalledWith("svc-testcall-nobody__t", {});
      } finally {
        proxySpy.mockRestore();
      }
    });
  });

  // Kills the exact args pass-through, the recordAudit call's exact 3
  // arguments (no detail), and the `res.json(result)` fidelity.
  test("a real body's args are forwarded verbatim, audited, and the result returned as-is", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-testcall-ok");
      const fakeResult = { content: [{ type: "text", text: "hi" }] };
      const proxySpy = spyOn(proxyMod, "proxyToolCall").mockResolvedValue(fakeResult);
      const auditSpy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/clients/svc-testcall-ok/tools/t/test`, {
          method: "POST",
          headers: bearer(),
          body: JSON.stringify({ q: "hello" }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual(fakeResult);
        expect(proxySpy).toHaveBeenCalledWith("svc-testcall-ok__t", { q: "hello" });
        expect(auditSpy).toHaveBeenCalledWith(expect.any(String), "tool.test", "svc-testcall-ok__t");
      } finally {
        proxySpy.mockRestore();
        auditSpy.mockRestore();
      }
    });
  });
});

describe("GET /admin-api/clients/:name/tools/:tool/examples", () => {
  // Kills this route's OWN independent copy of the ensureClientAccess guard.
  test("a session caller from a different team gets the exact CLIENT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-examples-get-denied");
      const headers = denyHeaders("svc-examples-get-denied", "examples-get-denied");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-examples-get-denied/tools/t/examples`, { headers });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
    });
  });

  // Kills the `{ items: ... }` response wrapper emptied, via a real saved
  // example created directly through the underlying entity module.
  test("returns the exact items shape for a tool with a saved example", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-examples-get-ok");
      await fetch(`${baseUrl}/admin-api/clients/svc-examples-get-ok/tools/t/examples`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ label: "my-example", args: { a: 1 } }),
      });
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-examples-get-ok/tools/t/examples`, {
        headers: bearer(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: Array<{ label: string; args: unknown }> };
      expect(body.items).toHaveLength(1);
      expect(body.items[0].label).toBe("my-example");
      expect(body.items[0].args).toEqual({ a: 1 });
    });
  });
});

describe("POST /admin-api/clients/:name/tools/:tool/examples", () => {
  // Kills this route's OWN independent copy of the ensureClientAccess guard.
  test("a session caller from a different team gets the exact CLIENT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-examples-post-denied");
      const headers = denyHeaders("svc-examples-post-denied", "examples-post-denied");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-examples-post-denied/tools/t/examples`, {
        method: "POST",
        headers,
        body: JSON.stringify({ label: "x" }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
    });
  });

  // Kills the `?? {}` body fallback flipped to `&&`: no body/Content-Type at
  // all means req.body is undefined; `??` falls back to {} so `body.label`
  // reads undefined (not a crash) and fails the label check gracefully.
  test("no request body at all is a graceful validation error, not a crash", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-examples-post-nobody");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-examples-post-nobody/tools/t/examples`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("label is required (<= 100 chars)");
    });
  });

  // Kills the `typeof body.label === "string"` ternary with a TRUTHY
  // non-string value (a number), which must fall back to "" and fail
  // validation exactly like an absent label -- distinguishing a forced-true
  // mutant that would otherwise let a non-string label slip through.
  test("a non-string label fails validation with the exact message", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-examples-post-badlabeltype");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-examples-post-badlabeltype/tools/t/examples`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ label: 12345 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("label is required (<= 100 chars)");
    });
  });

  // Kills the `label.length > 100` boundary: exactly 100 chars must be
  // accepted (kills an off-by-one `>= 100` mutant) and 101 must be rejected
  // (kills a `> 100` -> always-false mutant).
  test("a label at exactly the 100-char boundary succeeds; 101 chars fails", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-examples-post-boundary");
      const label100 = "x".repeat(100);
      const okRes = await fetch(`${baseUrl}/admin-api/clients/svc-examples-post-boundary/tools/t/examples`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ label: label100 }),
      });
      expect(okRes.status).toBe(201);

      const label101 = "x".repeat(101);
      const badRes = await fetch(`${baseUrl}/admin-api/clients/svc-examples-post-boundary/tools/t/examples`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ label: label101 }),
      });
      expect(badRes.status).toBe(400);
      const body = (await badRes.json()) as { error: { code: string; message: string } };
      expect(body.error.message).toBe("label is required (<= 100 chars)");
    });
  });

  // Kills the `.trim()` call removed: a label padded with whitespace must be
  // stored trimmed.
  test("a whitespace-padded label is stored trimmed", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-examples-post-trim");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-examples-post-trim/tools/t/examples`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ label: "  padded  " }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { label: string };
      expect(body.label).toBe("padded");
    });
  });

  // Kills the `result === "TOOL_NOT_FOUND"` branch, via an unregistered tool
  // on a real client.
  test("an unknown tool returns the exact TOOL_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-examples-post-unknowntool");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-examples-post-unknowntool/tools/nope/examples`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ label: "x" }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("TOOL_NOT_FOUND");
      expect(body.error.message).toBe("Client or tool not found");
    });
  });

  // Kills the `result === "INVALID_ARGS"` branch, via a non-object args
  // value (an array).
  test("array args fails validation with the exact INVALID_ARGS message", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-examples-post-badargs");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-examples-post-badargs/tools/t/examples`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ label: "x", args: [1, 2] }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("args must be an object (<= 16KB)");
    });
  });

  // Kills the `body.args ?? {}` fallback flipped to `&&`: an omitted args
  // field must default to {} (a valid, successful creation), not crash or
  // fail validation.
  test("an omitted args field defaults to an empty object", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-examples-post-noargs");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-examples-post-noargs/tools/t/examples`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ label: "no-args-example" }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { args: unknown };
      expect(body.args).toEqual({});
    });
  });

  // Kills the recordAudit exact-args assertion (action/target/detail) and
  // the 201 status literal.
  test("a fully valid example is created, audited, and returned with a 201", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-examples-post-ok");
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/clients/svc-examples-post-ok/tools/t/examples`, {
          method: "POST",
          headers: bearer(),
          body: JSON.stringify({ label: "greeting", args: { name: "world" } }),
        });
        expect(res.status).toBe(201);
        expect(spy).toHaveBeenCalledWith(expect.any(String), "tool.example.create", "svc-examples-post-ok__t", {
          label: "greeting",
        });
        const items = listExamples("svc-examples-post-ok", "t");
        expect(items).toHaveLength(1);
        expect(items[0].args).toEqual({ name: "world" });
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("DELETE /admin-api/clients/:name/tools/:tool/examples/:id", () => {
  async function createExampleViaApi(baseUrl: string, clientName: string, toolName: string): Promise<number> {
    const res = await fetch(`${baseUrl}/admin-api/clients/${clientName}/tools/${toolName}/examples`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ label: "to-delete" }),
    });
    const body = (await res.json()) as { id: number };
    return body.id;
  }

  // Kills this route's OWN independent copy of the ensureClientAccess guard.
  test("a session caller from a different team gets the exact CLIENT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-examples-delete-denied");
      const id = await createExampleViaApi(baseUrl, "svc-examples-delete-denied", "t");
      const headers = denyHeaders("svc-examples-delete-denied", "examples-delete-denied");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-examples-delete-denied/tools/t/examples/${id}`, {
        method: "DELETE",
        headers,
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
    });
  });

  // Kills the `!ok` guard and the exact 404 code/message, via an id that was
  // never created.
  test("an unknown example id returns the exact EXAMPLE_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-examples-delete-unknown");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-examples-delete-unknown/tools/t/examples/999999`, {
        method: "DELETE",
        headers: bearer(),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("EXAMPLE_NOT_FOUND");
      expect(body.error.message).toBe("Example not found");
    });
  });

  // Kills the recordAudit exact-args assertion (including the `{ id }`
  // detail object literal) and the response object's exact fields, verified
  // against a genuine follow-up removal.
  test("a successful delete is audited with the exact detail and removes the example", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-examples-delete-ok");
      const id = await createExampleViaApi(baseUrl, "svc-examples-delete-ok", "t");
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/clients/svc-examples-delete-ok/tools/t/examples/${id}`, {
          method: "DELETE",
          headers: bearer(),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; id: number };
        expect(body).toEqual({ status: "deleted", id });
        expect(spy).toHaveBeenCalledWith(expect.any(String), "tool.example.delete", "svc-examples-delete-ok__t", {
          id,
        });
        expect(listExamples("svc-examples-delete-ok", "t")).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("POST /admin-api/clients/:name/circuit-breaker/reset", () => {
  // Kills this route's OWN independent copy of the ensureClientAccess guard.
  test("a session caller from a different team gets the exact CLIENT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-cb-denied");
      const headers = denyHeaders("svc-cb-denied", "cb-denied");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-cb-denied/circuit-breaker/reset`, {
        method: "POST",
        headers,
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
    });
  });

  // Kills the `!ok` guard and the exact 404 code/message, via a client that
  // was never registered (so it isn't currently "live").
  test("an unregistered client returns the exact CLIENT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-cb-never-registered/circuit-breaker/reset`, {
        method: "POST",
        headers: bearer(),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
      expect(body.error.message).toBe("Client is not currently live");
    });
  });

  // Kills the recordAudit exact 2-argument call (no detail) and the
  // response object's exact fields.
  test("a successful reset on a live client is audited and returns the exact response", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-cb-ok");
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/clients/svc-cb-ok/circuit-breaker/reset`, {
          method: "POST",
          headers: bearer(),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; name: string };
        expect(body).toEqual({ status: "reset", name: "svc-cb-ok" });
        expect(spy).toHaveBeenCalledWith(expect.any(String), "client.circuit_breaker.reset", "svc-cb-ok");
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("POST /admin-api/clients/:name/tools/:tool/cache/purge", () => {
  // Kills this route's OWN independent copy of the ensureClientAccess guard.
  test("a session caller from a different team gets the exact CLIENT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-purge-denied");
      const headers = denyHeaders("svc-purge-denied", "purge-denied");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-purge-denied/tools/t/cache/purge`, {
        method: "POST",
        headers,
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
    });
  });

  // Kills the `!registry.resolveTool(...)` guard and the exact 404 code/message.
  test("an unknown tool returns the exact TOOL_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-purge-unknowntool");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-purge-unknowntool/tools/nope/cache/purge`, {
        method: "POST",
        headers: bearer(),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("TOOL_NOT_FOUND");
      expect(body.error.message).toBe("Client or tool not found");
    });
  });

  // Kills the `purgeToolCache` call being skipped/emptied, the recordAudit
  // exact 2-argument call, and the response object's exact fields --
  // verified against a genuine cache entry that existed before the purge.
  test("a successful purge is audited, genuinely empties the cache, and returns the exact response", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-purge-ok");
      const key = cacheKey("svc-purge-ok", "t", "http://example.com", {});
      cacheSet(key, { content: [{ type: "text", text: "cached" }] }, 60);
      expect(cacheGet(key)).not.toBeNull();

      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/clients/svc-purge-ok/tools/t/cache/purge`, {
          method: "POST",
          headers: bearer(),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; name: string; tool: string };
        expect(body).toEqual({ status: "purged", name: "svc-purge-ok", tool: "t" });
        expect(spy).toHaveBeenCalledWith(expect.any(String), "tool.cache.purge", "svc-purge-ok__t");
        expect(cacheGet(key)).toBeNull();
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("POST /admin-api/clients/:name/tools/:tool/quarantine/clear", () => {
  // Kills this route's OWN independent copy of the ensureClientAccess guard.
  test("a session caller from a different team gets the exact CLIENT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-quarantine-denied");
      const headers = denyHeaders("svc-quarantine-denied", "quarantine-denied");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-quarantine-denied/tools/t/quarantine/clear`, {
        method: "POST",
        headers,
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
    });
  });

  // Kills the `!ok` guard and the exact 404 code/message, via an unknown tool
  // (clearQuarantine itself returns false for an unknown client/tool).
  test("an unknown tool returns the exact TOOL_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-quarantine-unknowntool");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-quarantine-unknowntool/tools/nope/quarantine/clear`, {
        method: "POST",
        headers: bearer(),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("TOOL_NOT_FOUND");
      expect(body.error.message).toBe("Client or tool not found");
    });
  });

  // Kills the recordAudit exact 2-argument call and the response object's
  // exact fields.
  test("a successful clear on a real tool is audited and returns the exact response", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-quarantine-ok");
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/clients/svc-quarantine-ok/tools/t/quarantine/clear`, {
          method: "POST",
          headers: bearer(),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; name: string; tool: string };
        expect(body).toEqual({ status: "cleared", name: "svc-quarantine-ok", tool: "t" });
        expect(spy).toHaveBeenCalledWith(expect.any(String), "tool.quarantine.clear", "svc-quarantine-ok__t");
      } finally {
        spy.mockRestore();
      }
    });
  });
});
