/**
 * Stryker mutation-testing backstop for src/routes/composites.ts — domain 8.
 * No dedicated test file existed anywhere in STRYKER_TEST_SCOPE=
 * "src/routes/__tests__" before this (a hand-written integration test for
 * this same route DOES exist at
 * src/admin/tool-composition/__tests__/composites.test.ts, but that
 * directory is OUTSIDE this scope and is never run during a scoped Stryker
 * pass — so it counts as zero prior coverage for this run and this file
 * duplicates a few of its cases deliberately).
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

const ADMIN_KEY = "test-admin-key-composites-mut";
const OBJ_SCHEMA = { type: "object", properties: {} };

function makeTool(name: string): RestToolDefinition {
  return {
    name,
    method: "GET",
    endpoint: `/${name}`,
    description: "d",
    inputSchema: { type: "object", properties: {} },
  };
}

async function reg(clientName: string, toolNames: string[] = ["t"]): Promise<void> {
  await registry.register(
    clientName,
    toolNames.map(makeTool),
    "http://example.com/health",
    "1.2.3.4",
    "http://example.com",
    "1.2.3.4",
  );
}

async function startApp(): Promise<{ baseUrl: string; server: Server }> {
  __resetDbForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  const { compositeRoutes } = await import("../composites.js");
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  compositeRoutes(app);
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

async function withApp(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const { baseUrl, server } = await startApp();
  try {
    await fn(baseUrl);
  } finally {
    for (const c of registry.listClients()) await registry.unregister(c.name);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function step(targetClient: string, targetTool: string, argsTemplate: Record<string, unknown> = {}) {
  return { targetClient, targetTool, argsTemplate };
}

describe("GET /admin-api/composites", () => {
  test("an unrelated path is not served", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/totally-unrelated`, { headers: bearer() });
      expect(res.status).toBe(404);
    });
  });

  test("lists 2 distinct composites with the exact summary shape", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-list");
      await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          name: "flow-a",
          description: "first",
          inputSchema: OBJ_SCHEMA,
          steps: [step("svc-list", "t")],
        }),
      });
      await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          name: "flow-b",
          inputSchema: OBJ_SCHEMA,
          steps: [step("svc-list", "t"), step("svc-list", "t")],
        }),
      });
      const res = await fetch(`${baseUrl}/admin-api/composites`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: { name: string; description: string | null; enabled: boolean; stepsCount: number }[];
      };
      const byName = Object.fromEntries(body.items.map((i) => [i.name, i]));
      expect(byName["flow-a"]).toEqual({ name: "flow-a", description: "first", enabled: true, stepsCount: 1 });
      expect(byName["flow-b"]).toEqual({ name: "flow-b", description: null, enabled: true, stepsCount: 2 });
    });
  });
});

describe("GET /admin-api/composites/:name", () => {
  test("an unknown name returns the exact COMPOSITE_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/composites/no-such-composite`, { headers: bearer() });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("COMPOSITE_NOT_FOUND");
      expect(body.error.message).toBe("Composite not found");
    });
  });

  test("a known name returns 200 with the full detail", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-detail");
      await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          name: "flow-detail",
          description: "d",
          inputSchema: OBJ_SCHEMA,
          steps: [step("svc-detail", "t")],
        }),
      });
      const res = await fetch(`${baseUrl}/admin-api/composites/flow-detail`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { name: string; steps: unknown[] };
      expect(body.name).toBe("flow-detail");
      expect(body.steps).toEqual([{ targetClient: "svc-detail", targetTool: "t", argsTemplate: {} }]);
    });
  });
});

describe("POST /admin-api/composites — happy path + audit", () => {
  test("creates, returns 201 with the created detail, and records the exact audit detail", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-create");
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/composites`, {
          method: "POST",
          headers: bearer(),
          body: JSON.stringify({
            name: "flow-create",
            description: "desc",
            inputSchema: OBJ_SCHEMA,
            steps: [step("svc-create", "t"), step("svc-create", "t")],
          }),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { name: string; steps: unknown[] };
        expect(body.name).toBe("flow-create");
        expect(body.steps.length).toBe(2);
        expect(spy).toHaveBeenCalledWith(expect.any(String), "composite.create", "flow-create", { steps: 2 });
      } finally {
        spy.mockRestore();
      }
    });
  });

  test("a request with no JSON body at all returns a clean 400, not a crash", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("steps must be an array");
    });
  });
});

describe("POST /admin-api/composites — name/description/inputSchema coercion", () => {
  test("a non-string (truthy) name is treated as empty, not passed through raw", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-name");
      const res = await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: 123, inputSchema: OBJ_SCHEMA, steps: [step("svc-name", "t")] }),
      });
      // Real code: name becomes "" -> fails isValidCompositeName -> INVALID_NAME.
      // A forced-true ternary mutant would instead pass the raw number 123
      // through; TOOL_NAME_RE.test(123) coerces to "123" and MATCHES, so the
      // mutant would create the composite (201) instead of rejecting it.
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_NAME");
    });
  });

  test("a non-string (truthy) description falls back to undefined (stored as null)", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-desc");
      await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          name: "flow-desc",
          description: 42,
          inputSchema: OBJ_SCHEMA,
          steps: [step("svc-desc", "t")],
        }),
      });
      const detail = (await (
        await fetch(`${baseUrl}/admin-api/composites/flow-desc`, { headers: bearer() })
      ).json()) as { description: string | null };
      expect(detail.description).toBeNull();
    });
  });

  test("a valid string description is stored as-is", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-desc2");
      await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          name: "flow-desc2",
          description: "a real description",
          inputSchema: OBJ_SCHEMA,
          steps: [step("svc-desc2", "t")],
        }),
      });
      const detail = (await (
        await fetch(`${baseUrl}/admin-api/composites/flow-desc2`, { headers: bearer() })
      ).json()) as { description: string | null };
      expect(detail.description).toBe("a real description");
    });
  });

  test("a valid custom inputSchema is used as-is, not defaulted", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-schema");
      const custom = { type: "object", properties: { x: { type: "string" } } };
      await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "flow-schema", inputSchema: custom, steps: [step("svc-schema", "t")] }),
      });
      const detail = (await (
        await fetch(`${baseUrl}/admin-api/composites/flow-schema`, { headers: bearer() })
      ).json()) as { inputSchema: unknown };
      expect(detail.inputSchema).toEqual(custom);
    });
  });

  test("a non-object (truthy) inputSchema defaults to {type:object,properties:{}}", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-schema2");
      const res = await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "flow-schema2", inputSchema: "oops", steps: [step("svc-schema2", "t")] }),
      });
      expect(res.status).toBe(201);
      const detail = (await (
        await fetch(`${baseUrl}/admin-api/composites/flow-schema2`, { headers: bearer() })
      ).json()) as { inputSchema: unknown };
      expect(detail.inputSchema).toEqual({ type: "object", properties: {} });
    });
  });

  test("an explicit null inputSchema defaults to {type:object,properties:{}}", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-schema3");
      const res = await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "flow-schema3", inputSchema: null, steps: [step("svc-schema3", "t")] }),
      });
      expect(res.status).toBe(201);
      const detail = (await (
        await fetch(`${baseUrl}/admin-api/composites/flow-schema3`, { headers: bearer() })
      ).json()) as { inputSchema: unknown };
      expect(detail.inputSchema).toEqual({ type: "object", properties: {} });
    });
  });
});

describe("POST /admin-api/composites — validateSteps: array-ness and length", () => {
  test("a non-array steps value returns the exact message", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "flow-steps1", inputSchema: OBJ_SCHEMA, steps: "not-an-array" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("steps must be an array");
    });
  });

  test("zero steps returns the exact message", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "flow-steps2", inputSchema: OBJ_SCHEMA, steps: [] }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("a composite needs at least one step");
    });
  });

  test("exactly MAX_STEPS (10) steps is accepted", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-max");
      const steps = Array.from({ length: 10 }, () => step("svc-max", "t"));
      const res = await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "flow-max", inputSchema: OBJ_SCHEMA, steps }),
      });
      expect(res.status).toBe(201);
    });
  });

  test("11 steps (over MAX_STEPS) returns the exact message", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-over");
      const steps = Array.from({ length: 11 }, () => step("svc-over", "t"));
      const res = await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "flow-over", inputSchema: OBJ_SCHEMA, steps }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("steps exceeds maximum of 10");
    });
  });
});

describe("POST /admin-api/composites — validateSteps: per-step shape", () => {
  const shapeMsg = "each step must be {targetClient: string, targetTool: string, argsTemplate: object}";

  test("a non-object step item is rejected", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "flow-shape1", inputSchema: OBJ_SCHEMA, steps: ["oops"] }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe(shapeMsg);
    });
  });

  test("a null step item is rejected without crashing", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "flow-shape2", inputSchema: OBJ_SCHEMA, steps: [null] }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe(shapeMsg);
    });
  });

  test("a non-string targetClient is rejected", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          name: "flow-shape3",
          inputSchema: OBJ_SCHEMA,
          steps: [{ targetClient: 1, targetTool: "t", argsTemplate: {} }],
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe(shapeMsg);
    });
  });

  test("a non-string targetTool is rejected", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          name: "flow-shape4",
          inputSchema: OBJ_SCHEMA,
          steps: [{ targetClient: "svc", targetTool: 1, argsTemplate: {} }],
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe(shapeMsg);
    });
  });
});

describe("POST /admin-api/composites — validateSteps: argsTemplate", () => {
  test("an omitted argsTemplate defaults to {} and the step is created", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-argt");
      const res = await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          name: "flow-argt1",
          inputSchema: OBJ_SCHEMA,
          steps: [{ targetClient: "svc-argt", targetTool: "t" }],
        }),
      });
      expect(res.status).toBe(201);
      const detail = (await (
        await fetch(`${baseUrl}/admin-api/composites/flow-argt1`, { headers: bearer() })
      ).json()) as { steps: { argsTemplate: unknown }[] };
      expect(detail.steps[0].argsTemplate).toEqual({});
    });
  });

  test("an explicit null argsTemplate also defaults to {}", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-argt2");
      const res = await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          name: "flow-argt2",
          inputSchema: OBJ_SCHEMA,
          steps: [{ targetClient: "svc-argt2", targetTool: "t", argsTemplate: null }],
        }),
      });
      expect(res.status).toBe(201);
      const detail = (await (
        await fetch(`${baseUrl}/admin-api/composites/flow-argt2`, { headers: bearer() })
      ).json()) as { steps: { argsTemplate: unknown }[] };
      expect(detail.steps[0].argsTemplate).toEqual({});
    });
  });

  test("an array argsTemplate is rejected with the exact message", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          name: "flow-argt3",
          inputSchema: OBJ_SCHEMA,
          steps: [{ targetClient: "svc", targetTool: "t", argsTemplate: [1, 2] }],
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("each step's argsTemplate must be an object");
    });
  });

  test("a string argsTemplate is rejected with the exact message", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          name: "flow-argt4",
          inputSchema: OBJ_SCHEMA,
          steps: [{ targetClient: "svc", targetTool: "t", argsTemplate: "oops" }],
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("each step's argsTemplate must be an object");
    });
  });

  test("an argsTemplate over 10KB is rejected with the exact message", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-big");
      const big = { pad: "a".repeat(11000) };
      const res = await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          name: "flow-big",
          inputSchema: OBJ_SCHEMA,
          steps: [{ targetClient: "svc-big", targetTool: "t", argsTemplate: big }],
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("argsTemplate exceeds 10KB");
    });
  });

  test("a well-under-10KB argsTemplate is accepted", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-small");
      const small = { pad: "a".repeat(100) };
      const res = await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          name: "flow-small",
          inputSchema: OBJ_SCHEMA,
          steps: [{ targetClient: "svc-small", targetTool: "t", argsTemplate: small }],
        }),
      });
      expect(res.status).toBe(201);
    });
  });

  // Kills the `>` -> `>=` boundary mutant on the 10KB check: an
  // argsTemplate whose JSON.stringify length is EXACTLY 10240 must be
  // accepted (real `>`) -- the mutant's `>=` would wrongly reject it.
  test("an argsTemplate at exactly 10240 bytes is accepted", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-exact");
      const exact = { pad: "a".repeat(10230) };
      expect(JSON.stringify(exact).length).toBe(10240);
      const res = await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          name: "flow-exact",
          inputSchema: OBJ_SCHEMA,
          steps: [{ targetClient: "svc-exact", targetTool: "t", argsTemplate: exact }],
        }),
      });
      expect(res.status).toBe(201);
    });
  });

  test("two distinct valid steps both get validated and persisted", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-two", ["t1", "t2"]);
      const res = await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          name: "flow-two",
          inputSchema: OBJ_SCHEMA,
          steps: [step("svc-two", "t1", { a: 1 }), step("svc-two", "t2", { b: 2 })],
        }),
      });
      expect(res.status).toBe(201);
      const detail = (await (
        await fetch(`${baseUrl}/admin-api/composites/flow-two`, { headers: bearer() })
      ).json()) as { steps: { targetClient: string; targetTool: string; argsTemplate: unknown }[] };
      expect(detail.steps).toEqual([
        { targetClient: "svc-two", targetTool: "t1", argsTemplate: { a: 1 } },
        { targetClient: "svc-two", targetTool: "t2", argsTemplate: { b: 2 } },
      ]);
    });
  });
});

describe("POST /admin-api/composites — createComposite error mapping", () => {
  test("an invalid name (containing __) returns the exact INVALID_NAME 400", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-badname");
      const res = await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "bad__name", inputSchema: OBJ_SCHEMA, steps: [step("svc-badname", "t")] }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_NAME");
    });
  });

  test("an inputSchema with the wrong type value returns the exact INVALID_SCHEMA 400", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-badschema");
      const res = await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          name: "flow-badschema",
          inputSchema: { type: "array" },
          steps: [step("svc-badschema", "t")],
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_SCHEMA");
    });
  });

  test("a step referencing an unknown tool returns the exact UNKNOWN_TOOL 400", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-unknown");
      const res = await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          name: "flow-unknown",
          inputSchema: OBJ_SCHEMA,
          steps: [step("svc-unknown", "ghost-tool")],
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("UNKNOWN_TOOL");
    });
  });

  test("a duplicate name returns the exact ALREADY_EXISTS 409", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-dup");
      const create = { name: "flow-dup", inputSchema: OBJ_SCHEMA, steps: [step("svc-dup", "t")] };
      await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify(create),
      });
      const res = await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify(create),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("ALREADY_EXISTS");
      expect(body.error.message).toBe('Composite "flow-dup" already exists');
    });
  });
});

describe("PATCH /admin-api/composites/:name — description", () => {
  async function makeBase(baseUrl: string, name: string, clientName: string): Promise<void> {
    await reg(clientName);
    await fetch(`${baseUrl}/admin-api/composites`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name, description: "original", inputSchema: OBJ_SCHEMA, steps: [step(clientName, "t")] }),
    });
  }

  test("a valid string description updates it, and the exact audit fields are recorded", async () => {
    await withApp(async (baseUrl) => {
      await makeBase(baseUrl, "flow-pd1", "svc-pd1");
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/composites/flow-pd1`, {
          method: "PATCH",
          headers: bearer(),
          body: JSON.stringify({ description: "updated" }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; name: string };
        expect(body).toEqual({ status: "updated", name: "flow-pd1" });
        expect(spy).toHaveBeenCalledWith(expect.any(String), "composite.update", "flow-pd1", {
          fields: ["description"],
        });
        const detail = (await (
          await fetch(`${baseUrl}/admin-api/composites/flow-pd1`, { headers: bearer() })
        ).json()) as { description: string | null };
        expect(detail.description).toBe("updated");
      } finally {
        spy.mockRestore();
      }
    });
  });

  test("an explicit null clears the description", async () => {
    await withApp(async (baseUrl) => {
      await makeBase(baseUrl, "flow-pd2", "svc-pd2");
      await fetch(`${baseUrl}/admin-api/composites/flow-pd2`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ description: null }),
      });
      const detail = (await (
        await fetch(`${baseUrl}/admin-api/composites/flow-pd2`, { headers: bearer() })
      ).json()) as { description: string | null };
      expect(detail.description).toBeNull();
    });
  });

  test("a non-string, non-null description returns the exact 400", async () => {
    await withApp(async (baseUrl) => {
      await makeBase(baseUrl, "flow-pd3", "svc-pd3");
      const res = await fetch(`${baseUrl}/admin-api/composites/flow-pd3`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ description: 42 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("description must be a string or null");
      // Confirm it wasn't applied.
      const detail = (await (
        await fetch(`${baseUrl}/admin-api/composites/flow-pd3`, { headers: bearer() })
      ).json()) as { description: string | null };
      expect(detail.description).toBe("original");
    });
  });

  test("omitting description leaves it untouched", async () => {
    await withApp(async (baseUrl) => {
      await makeBase(baseUrl, "flow-pd4", "svc-pd4");
      await fetch(`${baseUrl}/admin-api/composites/flow-pd4`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ enabled: false }),
      });
      const detail = (await (
        await fetch(`${baseUrl}/admin-api/composites/flow-pd4`, { headers: bearer() })
      ).json()) as { description: string | null };
      expect(detail.description).toBe("original");
    });
  });
});

describe("PATCH /admin-api/composites/:name — enabled", () => {
  async function makeBase(baseUrl: string, name: string, clientName: string): Promise<void> {
    await reg(clientName);
    await fetch(`${baseUrl}/admin-api/composites`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name, inputSchema: OBJ_SCHEMA, steps: [step(clientName, "t")] }),
    });
  }

  test("setting enabled: false is honored", async () => {
    await withApp(async (baseUrl) => {
      await makeBase(baseUrl, "flow-pe1", "svc-pe1");
      const spy = spyOn(auditMod, "recordAudit");
      try {
        await fetch(`${baseUrl}/admin-api/composites/flow-pe1`, {
          method: "PATCH",
          headers: bearer(),
          body: JSON.stringify({ enabled: false }),
        });
        expect(spy).toHaveBeenCalledWith(expect.any(String), "composite.update", "flow-pe1", {
          fields: ["enabled"],
        });
      } finally {
        spy.mockRestore();
      }
      const detail = (await (
        await fetch(`${baseUrl}/admin-api/composites/flow-pe1`, { headers: bearer() })
      ).json()) as { enabled: boolean };
      expect(detail.enabled).toBe(false);
    });
  });

  test("a non-boolean truthy enabled value returns the exact 400", async () => {
    await withApp(async (baseUrl) => {
      await makeBase(baseUrl, "flow-pe2", "svc-pe2");
      const res = await fetch(`${baseUrl}/admin-api/composites/flow-pe2`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ enabled: 1 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("enabled must be a boolean");
      const detail = (await (
        await fetch(`${baseUrl}/admin-api/composites/flow-pe2`, { headers: bearer() })
      ).json()) as { enabled: boolean };
      expect(detail.enabled).toBe(true);
    });
  });

  test("omitting enabled leaves it untouched", async () => {
    await withApp(async (baseUrl) => {
      await makeBase(baseUrl, "flow-pe3", "svc-pe3");
      await fetch(`${baseUrl}/admin-api/composites/flow-pe3`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ description: "x" }),
      });
      const detail = (await (
        await fetch(`${baseUrl}/admin-api/composites/flow-pe3`, { headers: bearer() })
      ).json()) as { enabled: boolean };
      expect(detail.enabled).toBe(true);
    });
  });
});

describe("PATCH /admin-api/composites/:name — inputSchema", () => {
  async function makeBase(baseUrl: string, name: string, clientName: string): Promise<void> {
    await reg(clientName);
    await fetch(`${baseUrl}/admin-api/composites`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name, inputSchema: OBJ_SCHEMA, steps: [step(clientName, "t")] }),
    });
  }

  test("a valid object schema updates it", async () => {
    await withApp(async (baseUrl) => {
      await makeBase(baseUrl, "flow-ps1", "svc-ps1");
      const custom = { type: "object", properties: { y: { type: "number" } } };
      const spy = spyOn(auditMod, "recordAudit");
      try {
        await fetch(`${baseUrl}/admin-api/composites/flow-ps1`, {
          method: "PATCH",
          headers: bearer(),
          body: JSON.stringify({ inputSchema: custom }),
        });
        expect(spy).toHaveBeenCalledWith(expect.any(String), "composite.update", "flow-ps1", {
          fields: ["inputSchema"],
        });
      } finally {
        spy.mockRestore();
      }
      const detail = (await (
        await fetch(`${baseUrl}/admin-api/composites/flow-ps1`, { headers: bearer() })
      ).json()) as { inputSchema: unknown };
      expect(detail.inputSchema).toEqual(custom);
    });
  });

  test("a non-object (string) inputSchema returns the exact 400 and does not apply", async () => {
    await withApp(async (baseUrl) => {
      await makeBase(baseUrl, "flow-ps2", "svc-ps2");
      const res = await fetch(`${baseUrl}/admin-api/composites/flow-ps2`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ inputSchema: "oops" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("inputSchema must be an object");
      const detail = (await (
        await fetch(`${baseUrl}/admin-api/composites/flow-ps2`, { headers: bearer() })
      ).json()) as { inputSchema: unknown };
      expect(detail.inputSchema).toEqual(OBJ_SCHEMA);
    });
  });

  test("an explicit null inputSchema returns the exact 400", async () => {
    await withApp(async (baseUrl) => {
      await makeBase(baseUrl, "flow-ps3", "svc-ps3");
      const res = await fetch(`${baseUrl}/admin-api/composites/flow-ps3`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ inputSchema: null }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("inputSchema must be an object");
    });
  });

  test("an array inputSchema returns the exact 400", async () => {
    await withApp(async (baseUrl) => {
      await makeBase(baseUrl, "flow-ps4", "svc-ps4");
      const res = await fetch(`${baseUrl}/admin-api/composites/flow-ps4`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ inputSchema: [1, 2, 3] }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("inputSchema must be an object");
    });
  });

  test("a schema-shaped object missing type:object is rejected by createComposite's own INVALID_SCHEMA downstream check", async () => {
    await withApp(async (baseUrl) => {
      await makeBase(baseUrl, "flow-ps5", "svc-ps5");
      const res = await fetch(`${baseUrl}/admin-api/composites/flow-ps5`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ inputSchema: { type: "array" } }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_SCHEMA");
    });
  });

  test("omitting inputSchema leaves it untouched", async () => {
    await withApp(async (baseUrl) => {
      await makeBase(baseUrl, "flow-ps6", "svc-ps6");
      await fetch(`${baseUrl}/admin-api/composites/flow-ps6`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ enabled: false }),
      });
      const detail = (await (
        await fetch(`${baseUrl}/admin-api/composites/flow-ps6`, { headers: bearer() })
      ).json()) as { inputSchema: unknown };
      expect(detail.inputSchema).toEqual(OBJ_SCHEMA);
    });
  });
});

describe("PATCH /admin-api/composites/:name — steps", () => {
  test("a valid new steps array replaces the old one", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-pst1", ["t1", "t2"]);
      await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "flow-pst1", inputSchema: OBJ_SCHEMA, steps: [step("svc-pst1", "t1")] }),
      });
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/composites/flow-pst1`, {
          method: "PATCH",
          headers: bearer(),
          body: JSON.stringify({ steps: [step("svc-pst1", "t2"), step("svc-pst1", "t1")] }),
        });
        expect(res.status).toBe(200);
        expect(spy).toHaveBeenCalledWith(expect.any(String), "composite.update", "flow-pst1", { fields: ["steps"] });
      } finally {
        spy.mockRestore();
      }
      const detail = (await (
        await fetch(`${baseUrl}/admin-api/composites/flow-pst1`, { headers: bearer() })
      ).json()) as { steps: { targetTool: string }[] };
      expect(detail.steps.map((s) => s.targetTool)).toEqual(["t2", "t1"]);
    });
  });

  test("an invalid steps array (empty) returns the exact validateSteps message, unchanged", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-pst2");
      await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "flow-pst2", inputSchema: OBJ_SCHEMA, steps: [step("svc-pst2", "t")] }),
      });
      const res = await fetch(`${baseUrl}/admin-api/composites/flow-pst2`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ steps: [] }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("a composite needs at least one step");
    });
  });

  test("steps referencing an unknown tool return the exact UNKNOWN_TOOL 400", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-pst3");
      await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "flow-pst3", inputSchema: OBJ_SCHEMA, steps: [step("svc-pst3", "t")] }),
      });
      const res = await fetch(`${baseUrl}/admin-api/composites/flow-pst3`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ steps: [step("svc-pst3", "ghost")] }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("UNKNOWN_TOOL");
    });
  });

  test("omitting steps leaves the existing ones untouched", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-pst4");
      await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "flow-pst4", inputSchema: OBJ_SCHEMA, steps: [step("svc-pst4", "t")] }),
      });
      await fetch(`${baseUrl}/admin-api/composites/flow-pst4`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ enabled: false }),
      });
      const detail = (await (
        await fetch(`${baseUrl}/admin-api/composites/flow-pst4`, { headers: bearer() })
      ).json()) as { steps: unknown[] };
      expect(detail.steps.length).toBe(1);
    });
  });
});

describe("PATCH /admin-api/composites/:name — not found + multi-field audit", () => {
  test("an unknown name returns the exact NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/composites/no-such-flow`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("NOT_FOUND");
      expect(body.error.message).toBe('Composite "no-such-flow" not found');
    });
  });

  test("updating multiple fields at once records all of their names, in order", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-multi");
      await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "flow-multi", inputSchema: OBJ_SCHEMA, steps: [step("svc-multi", "t")] }),
      });
      const spy = spyOn(auditMod, "recordAudit");
      try {
        await fetch(`${baseUrl}/admin-api/composites/flow-multi`, {
          method: "PATCH",
          headers: bearer(),
          body: JSON.stringify({ description: "new", enabled: false, inputSchema: OBJ_SCHEMA }),
        });
        expect(spy).toHaveBeenCalledWith(expect.any(String), "composite.update", "flow-multi", {
          fields: ["description", "enabled", "inputSchema"],
        });
      } finally {
        spy.mockRestore();
      }
    });
  });

  test("a PATCH request with no JSON body at all is a clean no-op 200, not a crash", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-nobody");
      await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "flow-nobody", inputSchema: OBJ_SCHEMA, steps: [step("svc-nobody", "t")] }),
      });
      const res = await fetch(`${baseUrl}/admin-api/composites/flow-nobody`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; name: string };
      expect(body).toEqual({ status: "updated", name: "flow-nobody" });
    });
  });
});

describe("DELETE /admin-api/composites/:name", () => {
  test("an unknown name returns the exact COMPOSITE_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/composites/no-such-delete`, {
        method: "DELETE",
        headers: bearer(),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("COMPOSITE_NOT_FOUND");
      expect(body.error.message).toBe("Composite not found");
    });
  });

  test("a known name is deleted, 200 with the exact shape, and the exact 3-arg audit call", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-del");
      await fetch(`${baseUrl}/admin-api/composites`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "flow-del", inputSchema: OBJ_SCHEMA, steps: [step("svc-del", "t")] }),
      });
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/composites/flow-del`, { method: "DELETE", headers: bearer() });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; name: string };
        expect(body).toEqual({ status: "deleted", name: "flow-del" });
        expect(spy).toHaveBeenCalledWith(expect.any(String), "composite.delete", "flow-del");
      } finally {
        spy.mockRestore();
      }
      const after = await fetch(`${baseUrl}/admin-api/composites/flow-del`, { headers: bearer() });
      expect(after.status).toBe(404);
    });
  });
});
