/**
 * Stryker mutation-testing backstop for src/routes/tags.ts — domain 8.
 * Baseline: 41 mutants, 27 killed / 14 survived — the existing
 * routes-tags.test.ts covers the happy path, an invalid-tag-content 400,
 * an unknown-tool 404, and auth, but only asserts response STATUS codes
 * (never exact body shape/message), and never exercises the
 * `!Array.isArray(body.tags)` guard or a mixed-type tags array. All
 * line:col citations below were read directly from
 * reports/mutation/result.json.
 */
import { describe, test, expect, spyOn } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { requestIdMiddleware } from "../../middleware/request-id.js";
import * as auditMod from "../../admin/audit/audit.js";
import type { RestToolDefinition } from "../../mcp/types.js";

const ADMIN_KEY = "test-admin-key-tags-mut";

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
  const { tagRoutes } = await import("../../routes/tags.js");
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  tagRoutes(app);
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

describe("PUT /admin-api/clients/:name/tools/:tool/tags — tags-must-be-an-array-of-strings validation", () => {
  // Kills 25:11-86 ConditionalExpression 'false' (the whole guard
  // disabled), 25:11-86 LogicalOperator (|| -> &&, which -- since the
  // second operand is `!body.tags.every(...)` and `.every` doesn't exist
  // on a string -- would throw a TypeError instead of short-circuiting),
  // and 25:88-28:8 BlockStatement (the not-an-array branch emptied,
  // falling through to `.map()` on a string, which also throws). All
  // three degrade a real 400 into an uncaught-exception 500.
  test("a non-array tags value returns the exact 400, not a 500 crash", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc/tools/t/tags`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ tags: "billing" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("tags must be an array of strings");
    });
  });

  // Kills 25:41-86 MethodExpression (.every -> .some, which only requires
  // ONE element to be a string) and 25:64-85 ConditionalExpression 'true'
  // (typeof t === "string" forced always-true). A MIXED array (one real
  // string, one number) distinguishes both: real code (.every, correct
  // typeof check) rejects it with 400; either mutant would let it
  // through to normalizeTag(123), which calls `.trim()` on a number and
  // throws, producing something other than a clean 400.
  test("a mixed-type tags array (one string, one number) returns the exact 400", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc/tools/t/tags`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ tags: ["billing", 123] }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("tags must be an array of strings");
    });
  });
});

describe("PUT /admin-api/clients/:name/tools/:tool/tags — invalid-tag-format message", () => {
  // Kills 32:30-107 StringLiteral (the template-literal invalid-tag
  // message emptied) -- the existing test only asserts status 400, never
  // the message content.
  test("an invalid tag returns the exact reason in the error message", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc/tools/t/tags`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ tags: ["has space"] }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe('invalid tag: "has space" (lowercase alphanumeric, - and _, up to 32 chars)');
    });
  });
});

describe("PUT /admin-api/clients/:name/tools/:tool/tags — unknown-tool 404", () => {
  // Kills 37:23-39 / 37:41-67 StringLiteral (the "TOOL_NOT_FOUND"/
  // "Client or tool not found" literals emptied) -- the existing test
  // only asserts status 404, never the body.
  test("an unknown tool returns the exact TOOL_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc/tools/nope/tags`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ tags: ["x"] }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("TOOL_NOT_FOUND");
      expect(body.error.message).toBe("Client or tool not found");
    });
  });
});

describe("PUT /admin-api/clients/:name/tools/:tool/tags — success shape + audit", () => {
  // Kills 41:28-79 ObjectLiteral (the whole response body emptied) and
  // 41:38-47 StringLiteral (the "updated" status literal emptied).
  test("returns the exact { status, name, tool, tags } response shape", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc/tools/t/tags`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ tags: ["Billing", " Read "] }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ status: "updated", name: "svc", tool: "t", tags: ["billing", "read"] });
    });
  });

  // Kills 40:42-57 StringLiteral ("tool.tags.set" emptied), 40:59-96
  // StringLiteral (the `${name}${TOOL_KEY_SEPARATOR}${tool}` target
  // template emptied), and 40:98-118 ObjectLiteral (the { tags:
  // normalized } audit detail emptied).
  test("records an audit entry with the exact action/target/detail", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc");
      const spy = spyOn(auditMod, "recordAudit");
      try {
        await fetch(`${baseUrl}/admin-api/clients/svc/tools/t/tags`, {
          method: "PUT",
          headers: bearer(),
          body: JSON.stringify({ tags: ["billing"] }),
        });
        expect(spy).toHaveBeenCalledWith(expect.any(String), "tool.tags.set", "svc__t", { tags: ["billing"] });
      } finally {
        spy.mockRestore();
      }
    });
  });
});
