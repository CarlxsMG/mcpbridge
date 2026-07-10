/**
 * Stryker mutation-testing backstop for src/routes/policies.ts — domain 8.
 *
 * The existing routes-policies.test.ts only covers: create + duplicate-name
 * 409 + list + delete (happy path, status codes only), applying a policy to
 * an explicit tools array, the apply-requires-bundle-or-tools 400, and the
 * blanket "requires auth" 401. It never touches PATCH at all (a whole
 * endpoint with zero coverage), never exercises the apply-to-bundle branch,
 * never asserts exact error codes/messages or recordAudit call args, and
 * never probes the optPositiveOrNull / validateToolRefs boundary conditions.
 * This file gap-fills all of that without duplicating what's already there.
 */
import { describe, test, expect, afterEach, spyOn } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { requestIdMiddleware } from "../../middleware/request-id.js";
import * as auditMod from "../../admin/audit/audit.js";
import { getGuardPolicy } from "../../admin/entities/policies.js";
import { createBundle } from "../../admin/tool-composition/bundles.js";
import type { RestToolDefinition } from "../../mcp/types.js";

const ADMIN_KEY = "test-admin-key-policies-mut";

function makeTool(name: string): RestToolDefinition {
  return {
    name,
    method: "GET",
    endpoint: `/${name}`,
    description: "d",
    inputSchema: { type: "object", properties: {} },
  };
}

let baseUrl = "";
let server: Server | null = null;

async function startApp(): Promise<void> {
  __resetDbForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  const { policyRoutes } = await import("../../routes/policies.js");
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  policyRoutes(app);
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
      server = srv;
      resolve();
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

async function createPolicy(body: Record<string, unknown>): Promise<{ id: number; [k: string]: unknown }> {
  const res = await fetch(`${baseUrl}/admin-api/policies`, {
    method: "POST",
    headers: bearer(),
    body: JSON.stringify(body),
  });
  return (await res.json()) as { id: number };
}

afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  await new Promise<void>((resolve) => {
    if (server)
      server.close(() => {
        server = null;
        resolve();
      });
    else resolve();
  });
});

describe("POST /admin-api/policies — name validation", () => {
  test("missing name returns exact 400 VALIDATION_ERROR", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/policies`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("name is required (1-128 chars)");
  });

  // A truthy non-string (number) name must still be rejected: the typeof
  // check forces name to "" rather than letting a number flow through.
  test("a non-string name (truthy, wrong type) is rejected the same as missing", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/policies`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name: 12345 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("name is required (1-128 chars)");
  });

  test("a whitespace-only name is rejected after trimming", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/policies`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name: "   " }),
    });
    expect(res.status).toBe(400);
  });

  test("a name over 128 chars is rejected", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/policies`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name: "a".repeat(129) }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("name is required (1-128 chars)");
  });

  test("a name at exactly 128 chars is accepted (boundary)", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/policies`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name: "b".repeat(128) }),
    });
    expect(res.status).toBe(201);
  });

  test("no request body at all is a graceful validation error, not a crash", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/policies`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("POST /admin-api/policies — rateLimitPerMin/timeoutMs validation", () => {
  test("a string value for rateLimitPerMin is rejected", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/policies`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name: "p1", rateLimitPerMin: "10" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("rateLimitPerMin and timeoutMs must be positive numbers or null");
  });

  test("zero is rejected (must be strictly > 0)", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/policies`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name: "p2", rateLimitPerMin: 0 }),
    });
    expect(res.status).toBe(400);
  });

  test("a negative number is rejected", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/policies`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name: "p3", timeoutMs: -5 }),
    });
    expect(res.status).toBe(400);
  });

  // JSON.stringify(Infinity) serializes to `null` (a valid, clearing
  // value), so the only way to get a genuinely non-finite `number` through
  // the wire is a numeric literal that overflows to Infinity on parse.
  test("Infinity is rejected (must be finite)", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/policies`, {
      method: "POST",
      headers: bearer(),
      body: '{"name":"p4","timeoutMs":1e400}',
    });
    expect(res.status).toBe(400);
  });

  test("undefined/omitted rate and timeout are accepted as null", async () => {
    await startApp();
    const created = await createPolicy({ name: "p5" });
    expect(created.rateLimitPerMin).toBeNull();
    expect(created.timeoutMs).toBeNull();
  });

  test("valid positive numbers for both fields are persisted", async () => {
    await startApp();
    const created = await createPolicy({ name: "p6", rateLimitPerMin: 42, timeoutMs: 5000 });
    expect(created.rateLimitPerMin).toBe(42);
    expect(created.timeoutMs).toBe(5000);
    const persisted = getGuardPolicy(created.id);
    expect(persisted?.rateLimitPerMin).toBe(42);
    expect(persisted?.timeoutMs).toBe(5000);
  });
});

describe("POST /admin-api/policies — duplicate name", () => {
  // The existing routes-policies.test.ts only asserts status 409 for this
  // case, never the exact code/message — this call site's literals are a
  // distinct location from the PATCH handler's identically-worded 409.
  test("a duplicate name on create returns the exact 409 POLICY_EXISTS code and message", async () => {
    await startApp();
    await createPolicy({ name: "dup-create" });
    const res = await fetch(`${baseUrl}/admin-api/policies`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name: "dup-create" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("POLICY_EXISTS");
    expect(body.error.message).toBe("A policy with that name already exists");
  });
});

describe("POST /admin-api/policies — audit", () => {
  test("records policy.create with the exact actor/action/target/detail", async () => {
    await startApp();
    const spy = spyOn(auditMod, "recordAudit");
    try {
      const res = await fetch(`${baseUrl}/admin-api/policies`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "audited" }),
      });
      const created = (await res.json()) as { id: number };
      expect(spy).toHaveBeenCalledWith("bearer:admin-api-key", "policy.create", String(created.id), {
        name: "audited",
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("PATCH /admin-api/policies/:id — not found", () => {
  test("an unknown id returns the exact POLICY_NOT_FOUND 404", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/policies/999999`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("POLICY_NOT_FOUND");
    expect(body.error.message).toBe("Policy not found");
  });

  test("a non-numeric id (NaN) also 404s rather than matching a row", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/policies/not-a-number`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /admin-api/policies/:id — name updates", () => {
  test("body.name === undefined leaves the name unchanged and records empty fields", async () => {
    await startApp();
    const created = await createPolicy({ name: "keep-me", rateLimitPerMin: 3 });
    const spy = spyOn(auditMod, "recordAudit");
    try {
      const res = await fetch(`${baseUrl}/admin-api/policies/${created.id}`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { name: string; rateLimitPerMin: number | null };
      expect(body.name).toBe("keep-me");
      expect(body.rateLimitPerMin).toBe(3);
      expect(spy).toHaveBeenCalledWith("bearer:admin-api-key", "policy.update", String(created.id), { fields: [] });
    } finally {
      spy.mockRestore();
    }
  });

  test("a non-string name on update returns the exact 400 message", async () => {
    await startApp();
    const created = await createPolicy({ name: "orig" });
    const res = await fetch(`${baseUrl}/admin-api/policies/${created.id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ name: 5 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("name must be a non-empty string");
  });

  test("a whitespace-only name on update is rejected", async () => {
    await startApp();
    const created = await createPolicy({ name: "orig2" });
    const res = await fetch(`${baseUrl}/admin-api/policies/${created.id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ name: "   " }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("name must be a non-empty string");
  });

  // Distinguishes the `!==` in `body.name.trim() !== existing.name &&
  // policyNameExists(...)` from a mutated `===`: renaming a policy to its
  // OWN current name must be a no-op 200, never a false 409. If the
  // comparison were flipped, this would incorrectly find the row that IS
  // itself and reject it as a duplicate.
  test("renaming a policy to its own current name is a no-op success, not 409", async () => {
    await startApp();
    const created = await createPolicy({ name: "self-same" });
    const res = await fetch(`${baseUrl}/admin-api/policies/${created.id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ name: "self-same", rateLimitPerMin: 7 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; rateLimitPerMin: number | null };
    expect(body.name).toBe("self-same");
    expect(body.rateLimitPerMin).toBe(7);
  });

  test("renaming to a name already used by a DIFFERENT policy returns 409 POLICY_EXISTS", async () => {
    await startApp();
    await createPolicy({ name: "taken" });
    const second = await createPolicy({ name: "renamable" });
    const res = await fetch(`${baseUrl}/admin-api/policies/${second.id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ name: "taken" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("POLICY_EXISTS");
    expect(body.error.message).toBe("A policy with that name already exists");
  });

  // Kills the `.trim()` being dropped from `body.name.trim() !== existing.name`
  // (the FIRST occurrence on that line): a whitespace-PADDED rename to the
  // policy's own current name must still be recognized as a no-op (the
  // trimmed value equals existing.name) and return 200, not 409. Without the
  // trim, the padded raw string is never equal to the stored (already-
  // trimmed) name, so the `!==` clause would stay true and fall through to
  // policyNameExists — which (since the trimmed name IS this row's own name)
  // would find a match and wrongly 409.
  test("a whitespace-padded rename to its own current name is still a no-op 200", async () => {
    await startApp();
    const created = await createPolicy({ name: "pad-self-same" });
    const res = await fetch(`${baseUrl}/admin-api/policies/${created.id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ name: "  pad-self-same  " }),
    });
    expect(res.status).toBe(200);
    const persisted = getGuardPolicy(created.id);
    // Also kills the `.trim()` dropped from `updates.name = body.name.trim()`:
    // the persisted name must be the trimmed form, never the padded raw one.
    expect(persisted?.name).toBe("pad-self-same");
  });

  // Kills the `.trim()` being dropped from the SECOND occurrence on that
  // line, `policyNameExists(body.name.trim())`: renaming to a padded version
  // of a DIFFERENT existing policy's name must still collide (409), because
  // the existence check has to compare the trimmed value against the
  // (trimmed) stored names. Without the trim, `policyNameExists("  taken2  ")`
  // would miss the stored "taken2" row entirely and let the collision through.
  test("a whitespace-padded rename that collides with a DIFFERENT policy still 409s", async () => {
    await startApp();
    await createPolicy({ name: "taken2" });
    const second = await createPolicy({ name: "renamable2" });
    const res = await fetch(`${baseUrl}/admin-api/policies/${second.id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ name: "  taken2  " }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("POLICY_EXISTS");
  });

  test("renaming to a genuinely new name succeeds and is persisted", async () => {
    await startApp();
    const created = await createPolicy({ name: "old-name" });
    const res = await fetch(`${baseUrl}/admin-api/policies/${created.id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ name: "new-name" }),
    });
    expect(res.status).toBe(200);
    const persisted = getGuardPolicy(created.id);
    expect(persisted?.name).toBe("new-name");
  });
});

describe("PATCH /admin-api/policies/:id — rateLimitPerMin/timeoutMs updates", () => {
  test("an invalid rateLimitPerMin update returns the exact 400 message", async () => {
    await startApp();
    const created = await createPolicy({ name: "r1" });
    const res = await fetch(`${baseUrl}/admin-api/policies/${created.id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ rateLimitPerMin: -1 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("rateLimitPerMin must be a positive number or null");
  });

  test("an invalid timeoutMs update returns the exact 400 message", async () => {
    await startApp();
    const created = await createPolicy({ name: "t1" });
    const res = await fetch(`${baseUrl}/admin-api/policies/${created.id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ timeoutMs: "abc" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("timeoutMs must be a positive number or null");
  });

  test("clearing rateLimitPerMin to null is accepted and persisted", async () => {
    await startApp();
    const created = await createPolicy({ name: "r2", rateLimitPerMin: 99 });
    const res = await fetch(`${baseUrl}/admin-api/policies/${created.id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ rateLimitPerMin: null }),
    });
    expect(res.status).toBe(200);
    const persisted = getGuardPolicy(created.id);
    expect(persisted?.rateLimitPerMin).toBeNull();
  });

  test("updating only timeoutMs records only that field in the audit detail", async () => {
    await startApp();
    const created = await createPolicy({ name: "t2" });
    const spy = spyOn(auditMod, "recordAudit");
    try {
      const res = await fetch(`${baseUrl}/admin-api/policies/${created.id}`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ timeoutMs: 2500 }),
      });
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledWith(expect.any(String), "policy.update", String(created.id), {
        fields: ["timeoutMs"],
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("a combined name+rate+timeout update persists all three and reports all fields", async () => {
    await startApp();
    const created = await createPolicy({ name: "combo" });
    const spy = spyOn(auditMod, "recordAudit");
    try {
      const res = await fetch(`${baseUrl}/admin-api/policies/${created.id}`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ name: "combo-renamed", rateLimitPerMin: 11, timeoutMs: 2222 }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { name: string; rateLimitPerMin: number | null; timeoutMs: number | null };
      expect(body.name).toBe("combo-renamed");
      expect(body.rateLimitPerMin).toBe(11);
      expect(body.timeoutMs).toBe(2222);
      const call = spy.mock.calls.find((c) => c[1] === "policy.update");
      expect(call?.[3]).toEqual({ fields: ["name", "rateLimitPerMin", "timeoutMs"] });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("DELETE /admin-api/policies/:id", () => {
  test("an unknown id returns the exact POLICY_NOT_FOUND 404", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/policies/999999`, { method: "DELETE", headers: bearer() });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("POLICY_NOT_FOUND");
    expect(body.error.message).toBe("Policy not found");
  });

  test("a successful delete returns the exact response shape and removes the row", async () => {
    await startApp();
    const created = await createPolicy({ name: "to-delete" });
    const res = await fetch(`${baseUrl}/admin-api/policies/${created.id}`, { method: "DELETE", headers: bearer() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "deleted", id: created.id });
    expect(getGuardPolicy(created.id)).toBeNull();
  });

  test("records policy.delete with the exact actor/action/target and no detail arg", async () => {
    await startApp();
    const created = await createPolicy({ name: "to-delete-audited" });
    const spy = spyOn(auditMod, "recordAudit");
    try {
      await fetch(`${baseUrl}/admin-api/policies/${created.id}`, { method: "DELETE", headers: bearer() });
      expect(spy).toHaveBeenCalledWith("bearer:admin-api-key", "policy.delete", String(created.id));
    } finally {
      spy.mockRestore();
    }
  });
});

describe("POST /admin-api/policies/:id/apply — policy not found", () => {
  test("an unknown policy id returns the exact POLICY_NOT_FOUND 404", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/policies/999999/apply`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ tools: [] }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("POLICY_NOT_FOUND");
    expect(body.error.message).toBe("Policy not found");
  });
});

describe("POST /admin-api/policies/:id/apply — bundle branch", () => {
  test("an unknown bundle name returns the exact BUNDLE_NOT_FOUND 404", async () => {
    await startApp();
    const created = await createPolicy({ name: "bundle-policy" });
    const res = await fetch(`${baseUrl}/admin-api/policies/${created.id}/apply`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ bundle: "no-such-bundle" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("BUNDLE_NOT_FOUND");
    expect(body.error.message).toBe("Bundle not found");
  });

  test("a valid bundle applies the policy to its tools and returns applied count", async () => {
    await startApp();
    await reg("svc-bundle");
    const bundleResult = await createBundle("my-bundle", undefined, [{ client: "svc-bundle", tool: "t" }], "tester");
    expect(bundleResult.ok).toBe(true);
    const created = await createPolicy({ name: "bundle-policy-2", rateLimitPerMin: 17 });

    const spy = spyOn(auditMod, "recordAudit");
    try {
      const res = await fetch(`${baseUrl}/admin-api/policies/${created.id}/apply`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ bundle: "my-bundle" }),
      });
      expect(res.status).toBe(200);
      const result = (await res.json()) as { applied: number };
      expect(result.applied).toBe(1);
      expect(registry.resolveTool("svc-bundle__t")?.tool.guards?.rateLimitPerMin).toBe(17);
      expect(spy).toHaveBeenCalledWith("bearer:admin-api-key", "policy.apply", String(created.id), {
        bundle: "my-bundle",
        applied: 1,
      });
    } finally {
      spy.mockRestore();
    }
  });

  // An empty-string bundle must fall through to the tools branch rather
  // than being treated as "bundle provided" (the `&& body.bundle`
  // truthiness check, not just `typeof === "string"`).
  test("an empty-string bundle falls through to the tools-required validation error", async () => {
    await startApp();
    const created = await createPolicy({ name: "empty-bundle-policy" });
    const res = await fetch(`${baseUrl}/admin-api/policies/${created.id}/apply`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ bundle: "" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("provide either bundle (string) or tools ([{client, tool}])");
  });

  // A non-string, truthy bundle value must also fall through (not crash,
  // not get treated as a bundle name) — verifies the `typeof === "string"`
  // half of the clause independently of the truthiness half.
  test("a non-string truthy bundle value falls through to tools validation error", async () => {
    await startApp();
    const created = await createPolicy({ name: "numeric-bundle-policy" });
    const res = await fetch(`${baseUrl}/admin-api/policies/${created.id}/apply`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ bundle: 123 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("provide either bundle (string) or tools ([{client, tool}])");
  });
});

describe("POST /admin-api/policies/:id/apply — tools branch validation", () => {
  test("a non-array tools value returns the exact 400", async () => {
    await startApp();
    const created = await createPolicy({ name: "tools-not-array" });
    const res = await fetch(`${baseUrl}/admin-api/policies/${created.id}/apply`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ tools: "svc__t" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("provide either bundle (string) or tools ([{client, tool}])");
  });

  test("no request body at all falls through to the tools-required validation error, not a crash", async () => {
    await startApp();
    const created = await createPolicy({ name: "no-body-apply" });
    const res = await fetch(`${baseUrl}/admin-api/policies/${created.id}/apply`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("provide either bundle (string) or tools ([{client, tool}])");
  });

  // Mixed valid+invalid array entries: a single bad ref must invalidate
  // the whole batch (validateToolRefs returns ok:false as soon as any item
  // fails), distinguishing this from a per-item filter.
  test("an array with one valid and one malformed ref is rejected entirely", async () => {
    await startApp();
    const created = await createPolicy({ name: "mixed-refs" });
    const res = await fetch(`${baseUrl}/admin-api/policies/${created.id}/apply`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ tools: [{ client: "svc", tool: "t" }, { client: "svc" }] }),
    });
    expect(res.status).toBe(400);
  });

  // Distinguishes the `typeof e.client !== "string"` clause from the later
  // `!e.client` clause: a TRUTHY non-string (a number) sails past `!e.client`
  // (5 is truthy) and is only caught by the typeof check.
  test("a truthy non-string client (a number) is rejected, not silently coerced", async () => {
    await startApp();
    const created = await createPolicy({ name: "numeric-client-ref" });
    const res = await fetch(`${baseUrl}/admin-api/policies/${created.id}/apply`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ tools: [{ client: 5, tool: "t" }] }),
    });
    expect(res.status).toBe(400);
  });

  // Same distinction for the `typeof e.tool !== "string"` clause.
  test("a truthy non-string tool (a number) is rejected, not silently coerced", async () => {
    await startApp();
    const created = await createPolicy({ name: "numeric-tool-ref" });
    const res = await fetch(`${baseUrl}/admin-api/policies/${created.id}/apply`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ tools: [{ client: "svc", tool: 5 }] }),
    });
    expect(res.status).toBe(400);
  });

  test("a ref with an empty-string client or tool is rejected (falsy check, not just typeof)", async () => {
    await startApp();
    const created = await createPolicy({ name: "empty-string-ref" });
    const res = await fetch(`${baseUrl}/admin-api/policies/${created.id}/apply`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ tools: [{ client: "", tool: "t" }] }),
    });
    expect(res.status).toBe(400);
  });

  test("a null entry in the tools array is rejected", async () => {
    await startApp();
    const created = await createPolicy({ name: "null-ref" });
    const res = await fetch(`${baseUrl}/admin-api/policies/${created.id}/apply`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ tools: [null] }),
    });
    expect(res.status).toBe(400);
  });

  test("an empty tools array is valid and applies to zero tools", async () => {
    await startApp();
    const created = await createPolicy({ name: "empty-tools-array" });
    const spy = spyOn(auditMod, "recordAudit");
    try {
      const res = await fetch(`${baseUrl}/admin-api/policies/${created.id}/apply`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ tools: [] }),
      });
      expect(res.status).toBe(200);
      const result = (await res.json()) as { applied: number };
      expect(result.applied).toBe(0);
      expect(spy).toHaveBeenCalledWith("bearer:admin-api-key", "policy.apply", String(created.id), {
        tools: 0,
        applied: 0,
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("a mix of one found and one unknown ref reports a partial applied count", async () => {
    await startApp();
    await reg("svc-partial");
    const created = await createPolicy({ name: "partial-apply" });
    const res = await fetch(`${baseUrl}/admin-api/policies/${created.id}/apply`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({
        tools: [
          { client: "svc-partial", tool: "t" },
          { client: "svc-partial", tool: "does-not-exist" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const result = (await res.json()) as { applied: number; skipped: { tool: string; reason: string }[] };
    expect(result.applied).toBe(1);
    expect(result.skipped).toEqual([{ tool: "svc-partial__does-not-exist", reason: "not found" }]);
  });

  test("records policy.apply for the tools branch with the exact tools count and applied count", async () => {
    await startApp();
    await reg("svc-audit-apply");
    const created = await createPolicy({ name: "audit-apply-policy" });
    const spy = spyOn(auditMod, "recordAudit");
    try {
      await fetch(`${baseUrl}/admin-api/policies/${created.id}/apply`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ tools: [{ client: "svc-audit-apply", tool: "t" }] }),
      });
      expect(spy).toHaveBeenCalledWith("bearer:admin-api-key", "policy.apply", String(created.id), {
        tools: 1,
        applied: 1,
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("GET /admin-api/policies — list shape", () => {
  test("returns the exact { items } envelope with two distinct policies", async () => {
    await startApp();
    await createPolicy({ name: "list-a" });
    await createPolicy({ name: "list-b" });
    const res = await fetch(`${baseUrl}/admin-api/policies`, { headers: bearer() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { name: string }[] };
    const names = body.items.map((i) => i.name).sort();
    expect(names).toEqual(["list-a", "list-b"]);
  });
});
