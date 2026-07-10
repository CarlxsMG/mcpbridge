/**
 * Stryker mutation-testing backstop for src/routes/catalog.ts — domain 8.
 *
 * The existing routes-catalog.test.ts already covers the CRUD/install happy
 * paths, builtin immutability, and a real end-to-end REST install (plus a
 * dead-openapi_url DISCOVERY_ERROR case). Baseline against that file alone:
 * 270 mutants, 95 killed / 175 survived. This file gap-fills the rest —
 * mostly parseCustomEntryInput's field-by-field parsing (each nullable
 * string/array/enum field is its own independent AST cluster), the
 * route-level guards (malformed-id / nonexistent-id / no-body branches),
 * and the install handler's arg-passing to performRestRegistration /
 * performMcpRegistration (best proven via spies — the REAL end-to-end path
 * often can't distinguish `??` from `&&` since a `null` and `undefined`
 * argument are treated identically downstream).
 *
 * Left completely untouched: routes-catalog.test.ts.
 */
import { describe, test, expect, spyOn, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { requestIdMiddleware } from "../../middleware/request-id.js";
import { _internalsForTesting } from "../../middleware/rate-limiter.js";
import { registry } from "../../mcp/registry.js";
import { createCustomEntry, type CustomCatalogEntryInput, type CustomCatalogEntry } from "../../catalog/index.js";
import * as auditMod from "../../admin/audit/audit.js";
import * as registrationMod from "../../mcp/registration.js";
import type { RegisterOutcome } from "../../mcp/registration.js";

const ADMIN_KEY = "test-admin-key-catalog-mut";
const originalAllowPrivate = config.allowPrivateIps;

let adminBase = "";
let adminServer: Server | null = null;

async function startApp(): Promise<void> {
  __resetDbForTesting();
  for (const c of registry.listClients()) await registry.unregister(c.name);
  _internalsForTesting.registerBuckets.clear();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  (config as Record<string, unknown>).allowPrivateIps = true;

  const { catalogRoutes } = await import("../../routes/catalog.js");
  const app = express();
  app.use(express.json({ limit: "64kb", strict: true }));
  app.use(requestIdMiddleware);
  catalogRoutes(app);

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

function authOnly(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_KEY}` };
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
  (config as Record<string, unknown>).allowPrivateIps = originalAllowPrivate;
  for (const c of registry.listClients()) await registry.unregister(c.name);
});

function createRestEntry(slug: string, overrides: Partial<CustomCatalogEntryInput> = {}): CustomCatalogEntry {
  const res = createCustomEntry(
    {
      slug,
      name: `Name for ${slug}`,
      kind: "rest",
      healthUrl: "https://example.com/health",
      baseUrl: "https://example.com",
      ...overrides,
    },
    "admin",
  );
  if (!res.ok) throw new Error(`createRestEntry(${slug}) failed: ${res.error.message}`);
  return res.entry;
}

function createMcpEntry(slug: string, overrides: Partial<CustomCatalogEntryInput> = {}): CustomCatalogEntry {
  const res = createCustomEntry(
    {
      slug,
      name: `Name for ${slug}`,
      kind: "mcp",
      mcpUrl: "https://example.com/mcp",
      ...overrides,
    },
    "admin",
  );
  if (!res.ok) throw new Error(`createMcpEntry(${slug}) failed: ${res.error.message}`);
  return res.entry;
}

function okOutcome(toolsCount: number): RegisterOutcome {
  return {
    ok: true,
    status: 200,
    body: { status: "registered", name: "whatever", tools_count: toolsCount, source: "manual" },
  };
}

function failOutcome(): RegisterOutcome {
  return { ok: false, status: 400, body: { error: { code: "DISCOVERY_ERROR", message: "synthetic failure" } } };
}

describe("POST /admin-api/catalog — required-field guards (slug/name/kind)", () => {
  test("an entirely empty body is rejected — slug is required", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/catalog`, { method: "POST", headers: bearer(), body: "{}" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("slug is required");
  });

  test("a truthy non-string slug (number) is rejected, not silently coerced", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/catalog`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ slug: 12345, name: "n", kind: "rest" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("slug is required");
  });

  test("an empty-string slug is rejected (falsy-but-typed-string case)", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/catalog`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ slug: "", name: "n", kind: "rest" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("slug is required");
  });

  test("a truthy non-string name (number) is rejected", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/catalog`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ slug: "valid-slug-1", name: 12345, kind: "rest" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("name is required");
  });

  test("an empty-string name is rejected", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/catalog`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ slug: "valid-slug-2", name: "", kind: "rest" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("name is required");
  });

  test("an invalid kind is rejected with the exact message", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/catalog`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ slug: "valid-slug-3", name: "n", kind: "graphql" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("kind must be 'rest' or 'mcp'");
  });

  test("kind: 'mcp' is a genuinely accepted value, not just 'rest'", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/catalog`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ slug: "valid-mcp-slug", name: "MCP Name", kind: "mcp" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { kind: string; source: string };
    expect(body.kind).toBe("mcp");
    expect(body.source).toBe("custom");
  });
});

describe("PATCH /admin-api/catalog/:id — slug/name/kind guards fire independently of requireSlug", () => {
  test("a truthy non-string slug on update is rejected (requireSlug=false doesn't bypass it)", async () => {
    await startApp();
    const entry = createRestEntry("patch-guard-slug");
    const res = await fetch(`${adminBase}/admin-api/catalog/custom:${entry.id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ slug: 999 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("slug is required");
  });

  test("a truthy non-string name on update is rejected", async () => {
    await startApp();
    const entry = createRestEntry("patch-guard-name");
    const res = await fetch(`${adminBase}/admin-api/catalog/custom:${entry.id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ name: 999 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("name is required");
  });

  test("an invalid kind on update is rejected", async () => {
    await startApp();
    const entry = createRestEntry("patch-guard-kind");
    const res = await fetch(`${adminBase}/admin-api/catalog/custom:${entry.id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ kind: "soap" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("kind must be 'rest' or 'mcp'");
  });
});

describe("parseCustomEntryInput — nullable string fields (description/category/icon/openapiUrl/healthUrl/baseUrl/mcpUrl)", () => {
  test("valid strings are stored as-is, and survive an unrelated update untouched", async () => {
    await startApp();
    const create = await fetch(`${adminBase}/admin-api/catalog`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({
        slug: "batch-c-entry",
        name: "Batch C Entry",
        kind: "rest",
        description: "orig-desc",
        category: "orig-cat",
        icon: "orig-icon",
        openapiUrl: "https://example.com/openapi-orig.json",
        healthUrl: "https://example.com/health-orig",
        baseUrl: "https://example.com/orig",
        mcpUrl: "https://example.com/mcp-orig",
        tags: ["orig-tag"],
        includeTags: ["orig-include"],
        excludeOperations: ["orig-exclude"],
        mcpTransport: "sse",
        featured: true,
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as CustomCatalogEntry & { id: string };
    expect(created.description).toBe("orig-desc");
    expect(created.category).toBe("orig-cat");
    expect(created.icon).toBe("orig-icon");
    expect(created.openapiUrl).toBe("https://example.com/openapi-orig.json");
    expect(created.healthUrl).toBe("https://example.com/health-orig");
    expect(created.baseUrl).toBe("https://example.com/orig");
    expect(created.mcpUrl).toBe("https://example.com/mcp-orig");
    expect(created.tags).toEqual(["orig-tag"]);
    expect(created.includeTags).toEqual(["orig-include"]);
    expect(created.excludeOperations).toEqual(["orig-exclude"]);
    expect(created.mcpTransport).toBe("sse");
    expect(created.featured).toBe(true);
    expect(created.kind).toBe("rest");

    // Now update ONLY `name` and prove every other field — none of which was
    // present in this PATCH body — survives untouched rather than being
    // wiped to null/[]/false by a forced-true `!== undefined` guard.
    const update = await fetch(`${adminBase}/admin-api/catalog/${created.id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ name: "Renamed Batch C" }),
    });
    expect(update.status).toBe(200);
    const updated = (await update.json()) as CustomCatalogEntry;
    expect(updated.name).toBe("Renamed Batch C");
    expect(updated.description).toBe("orig-desc");
    expect(updated.category).toBe("orig-cat");
    expect(updated.icon).toBe("orig-icon");
    expect(updated.openapiUrl).toBe("https://example.com/openapi-orig.json");
    expect(updated.healthUrl).toBe("https://example.com/health-orig");
    expect(updated.baseUrl).toBe("https://example.com/orig");
    expect(updated.mcpUrl).toBe("https://example.com/mcp-orig");
    expect(updated.tags).toEqual(["orig-tag"]);
    expect(updated.includeTags).toEqual(["orig-include"]);
    expect(updated.excludeOperations).toEqual(["orig-exclude"]);
    expect(updated.mcpTransport).toBe("sse");
    expect(updated.featured).toBe(true);
    expect(updated.kind).toBe("rest");
  });

  test("a truthy non-string value for each nullable string field coerces to null, not the raw value", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/catalog`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({
        slug: "numeric-fields-entry",
        name: "Numeric Fields",
        kind: "rest",
        description: 1,
        category: 2,
        icon: 3,
        openapiUrl: 4,
        healthUrl: 5,
        baseUrl: 6,
        mcpUrl: 7,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CustomCatalogEntry;
    expect(body.description).toBeNull();
    expect(body.category).toBeNull();
    expect(body.icon).toBeNull();
    expect(body.openapiUrl).toBeNull();
    expect(body.healthUrl).toBeNull();
    expect(body.baseUrl).toBeNull();
    expect(body.mcpUrl).toBeNull();
  });
});

describe("parseCustomEntryInput — array fields (tags/includeTags/excludeOperations)", () => {
  test("tags filters out non-string elements, preserving order of the strings", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/catalog`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({
        slug: "mixed-tags-entry",
        name: "Mixed Tags",
        kind: "rest",
        tags: ["a", 123, "b", true, "c"],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CustomCatalogEntry;
    expect(body.tags).toEqual(["a", "b", "c"]);
  });

  test("tags falls back to [] (not left unset) when given a non-array value on update", async () => {
    await startApp();
    const entry = createRestEntry("tags-fallback-entry", { tags: ["keep-me"] });
    const res = await fetch(`${adminBase}/admin-api/catalog/custom:${entry.id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ tags: "not-an-array" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CustomCatalogEntry;
    expect(body.tags).toEqual([]);
  });

  test("includeTags/excludeOperations independently fall back to null for non-array values on update", async () => {
    await startApp();
    const entry = createRestEntry("include-exclude-fallback", {
      includeTags: ["keep-inc"],
      excludeOperations: ["keep-exc"],
    });
    const res = await fetch(`${adminBase}/admin-api/catalog/custom:${entry.id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ includeTags: 42, excludeOperations: "nope" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CustomCatalogEntry;
    expect(body.includeTags).toBeNull();
    expect(body.excludeOperations).toBeNull();
  });
});

describe("parseCustomEntryInput — mcpTransport enum ('streamable-http' | 'sse' | null)", () => {
  test("'streamable-http' is accepted", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/catalog`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ slug: "transport-http", name: "n", kind: "mcp", mcpTransport: "streamable-http" }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as CustomCatalogEntry).mcpTransport).toBe("streamable-http");
  });

  test("'sse' is accepted", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/catalog`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ slug: "transport-sse", name: "n", kind: "mcp", mcpTransport: "sse" }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as CustomCatalogEntry).mcpTransport).toBe("sse");
  });

  test("null is accepted", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/catalog`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ slug: "transport-null", name: "n", kind: "mcp", mcpTransport: null }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as CustomCatalogEntry).mcpTransport).toBeNull();
  });

  test("an invalid value is rejected with the exact message", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/catalog`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ slug: "transport-bad", name: "n", kind: "mcp", mcpTransport: "carrier-pigeon" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("mcpTransport must be 'streamable-http', 'sse', or null");
  });
});

describe("parseCustomEntryInput — featured Boolean() coercion", () => {
  test("a truthy non-boolean value (non-empty string '0') coerces to true", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/catalog`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ slug: "featured-string-zero", name: "n", kind: "rest", featured: "0" }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as CustomCatalogEntry).featured).toBe(true);
  });

  test("a falsy non-boolean value (number 0) coerces to false", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/catalog`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ slug: "featured-number-zero", name: "n", kind: "rest", featured: 0 }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as CustomCatalogEntry).featured).toBe(false);
  });
});

describe("POST /admin-api/catalog — recordAudit", () => {
  test("records the exact action/target/detail on a successful create", async () => {
    await startApp();
    const auditSpy = spyOn(auditMod, "recordAudit");
    try {
      const res = await fetch(`${adminBase}/admin-api/catalog`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ slug: "audit-create-entry", name: "n", kind: "rest" }),
      });
      expect(res.status).toBe(201);
      expect(auditSpy).toHaveBeenCalledWith("bearer:admin-api-key", "catalog.entry.create", "audit-create-entry", {
        kind: "rest",
      });
    } finally {
      auditSpy.mockRestore();
    }
  });
});

describe("PATCH /admin-api/catalog/:id — route-level guards & response shape", () => {
  test("a malformed id (matches neither builtin: nor custom:) 404s WITHOUT falling through to update-by-coincidental-index", async () => {
    await startApp();
    const entry = createRestEntry("patch-malformed-victim");
    // Crafted so that a 7-char-then-slice bug (id.slice("custom:".length))
    // would coincidentally land on this real row's numeric id if the
    // `!id.startsWith("custom:")` guard were ever skipped.
    const malformedId = `zzzzzzz${entry.id}`;
    const res = await fetch(`${adminBase}/admin-api/catalog/${malformedId}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ featured: true }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("Catalog entry not found");
  });

  test("a builtin id 403s with the exact IMMUTABLE_ENTRY message", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/catalog/builtin:slack`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("IMMUTABLE_ENTRY");
    expect(body.error.message).toBe("Builtin catalog entries can't be edited at runtime");
  });

  test("a nonexistent (but validly-prefixed) custom id 404s with the entity-level message", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/catalog/custom:999999`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ featured: true }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("Catalog entry 999999 not found");
  });

  test("a request with no body at all (no Content-Type) is a safe no-op update, not a crash", async () => {
    await startApp();
    const entry = createRestEntry("patch-no-body-entry");
    const res = await fetch(`${adminBase}/admin-api/catalog/custom:${entry.id}`, {
      method: "PATCH",
      headers: authOnly(),
    });
    expect(res.status).toBe(200);
  });

  test("records the exact action/target/detail, and the exact response shape, on a successful update", async () => {
    await startApp();
    const entry = createRestEntry("patch-audit-entry", { featured: false });
    const auditSpy = spyOn(auditMod, "recordAudit");
    try {
      const res = await fetch(`${adminBase}/admin-api/catalog/custom:${entry.id}`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ featured: true }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string; source: string; featured: boolean };
      expect(body.id).toBe(`custom:${entry.id}`);
      expect(body.source).toBe("custom");
      expect(body.featured).toBe(true);
      expect(auditSpy).toHaveBeenCalledWith("bearer:admin-api-key", "catalog.entry.update", "patch-audit-entry", {
        fields: ["featured"],
      });
    } finally {
      auditSpy.mockRestore();
    }
  });
});

describe("DELETE /admin-api/catalog/:id — route-level guards & response shape", () => {
  test("a malformed id 404s without falling through to delete-by-coincidental-index", async () => {
    await startApp();
    const entry = createRestEntry("delete-malformed-victim");
    const malformedId = `zzzzzzz${entry.id}`;
    const res = await fetch(`${adminBase}/admin-api/catalog/${malformedId}`, {
      method: "DELETE",
      headers: bearer(),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("Catalog entry not found");
    // Prove it genuinely wasn't deleted, not just that the response was 404.
    const list = (await (await fetch(`${adminBase}/admin-api/catalog`, { headers: bearer() })).json()) as {
      items: { slug: string }[];
    };
    expect(list.items.some((i) => i.slug === "delete-malformed-victim")).toBe(true);
  });

  test("a builtin id 403s with the exact IMMUTABLE_ENTRY code and message", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/catalog/builtin:slack`, { method: "DELETE", headers: bearer() });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("IMMUTABLE_ENTRY");
    expect(body.error.message).toBe("Builtin catalog entries can't be deleted");
  });

  test("a nonexistent custom id 404s with the exact NOT_FOUND code and message", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/catalog/custom:999999`, { method: "DELETE", headers: bearer() });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("Catalog entry not found");
  });

  test("records the exact action/target, and the exact response body, on a successful delete", async () => {
    await startApp();
    const entry = createRestEntry("delete-audit-entry");
    const auditSpy = spyOn(auditMod, "recordAudit");
    try {
      const res = await fetch(`${adminBase}/admin-api/catalog/custom:${entry.id}`, {
        method: "DELETE",
        headers: bearer(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; id: string };
      expect(body).toEqual({ status: "deleted", id: `custom:${entry.id}` });
      // Note: delete's audit target is the raw prefixed id string, NOT the
      // entry's slug (unlike create/update, which both use result.entry.slug).
      expect(auditSpy).toHaveBeenCalledWith("bearer:admin-api-key", "catalog.entry.delete", `custom:${entry.id}`);
    } finally {
      auditSpy.mockRestore();
    }
  });
});

describe("POST /admin-api/catalog/:id/install — 404 for an unknown entry", () => {
  test("returns the exact CATALOG_ENTRY_NOT_FOUND code and message", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/catalog/custom:999999/install`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("CATALOG_ENTRY_NOT_FOUND");
    expect(body.error.message).toBe("Catalog entry not found");
  });
});

describe("POST /admin-api/catalog/:id/install — dispatch to the correct registration branch", () => {
  test("a rest-kind entry calls performRestRegistration, and never performMcpRegistration", async () => {
    await startApp();
    const entry = createRestEntry("dispatch-rest-entry");
    const restSpy = spyOn(registrationMod, "performRestRegistration").mockResolvedValue(okOutcome(3));
    const mcpSpy = spyOn(registrationMod, "performMcpRegistration").mockResolvedValue(okOutcome(3));
    try {
      const res = await fetch(`${adminBase}/admin-api/catalog/custom:${entry.id}/install`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      expect(restSpy).toHaveBeenCalledTimes(1);
      expect(mcpSpy).not.toHaveBeenCalled();
    } finally {
      restSpy.mockRestore();
      mcpSpy.mockRestore();
    }
  });

  test("an mcp-kind entry calls performMcpRegistration, and never performRestRegistration", async () => {
    await startApp();
    const entry = createMcpEntry("dispatch-mcp-entry");
    const restSpy = spyOn(registrationMod, "performRestRegistration").mockResolvedValue(okOutcome(3));
    const mcpSpy = spyOn(registrationMod, "performMcpRegistration").mockResolvedValue(okOutcome(3));
    try {
      const res = await fetch(`${adminBase}/admin-api/catalog/custom:${entry.id}/install`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      expect(mcpSpy).toHaveBeenCalledTimes(1);
      expect(restSpy).not.toHaveBeenCalled();
    } finally {
      restSpy.mockRestore();
      mcpSpy.mockRestore();
    }
  });
});

describe("POST /admin-api/catalog/:id/install — MCP branch arg-passing", () => {
  test("defaults mcp_transport to 'streamable-http' when the entry's is unset", async () => {
    await startApp();
    const entry = createMcpEntry("mcp-transport-default", { mcpTransport: null });
    const mcpSpy = spyOn(registrationMod, "performMcpRegistration").mockResolvedValue(okOutcome(1));
    try {
      const res = await fetch(`${adminBase}/admin-api/catalog/custom:${entry.id}/install`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      expect(mcpSpy).toHaveBeenCalledWith(
        { name: entry.slug, mcp_url: entry.mcpUrl, mcp_transport: "streamable-http" },
        expect.anything(),
        expect.anything(),
      );
    } finally {
      mcpSpy.mockRestore();
    }
  });

  test("passes the entry's own mcp_transport through unchanged when set", async () => {
    await startApp();
    const entry = createMcpEntry("mcp-transport-sse", { mcpTransport: "sse" });
    const mcpSpy = spyOn(registrationMod, "performMcpRegistration").mockResolvedValue(okOutcome(1));
    try {
      const res = await fetch(`${adminBase}/admin-api/catalog/custom:${entry.id}/install`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      expect(mcpSpy).toHaveBeenCalledWith(
        { name: entry.slug, mcp_url: entry.mcpUrl, mcp_transport: "sse" },
        expect.anything(),
        expect.anything(),
      );
    } finally {
      mcpSpy.mockRestore();
    }
  });
});

describe("POST /admin-api/catalog/:id/install — REST branch arg-passing", () => {
  test("passes include_tags/exclude_operations as undefined (not null) when the entry's are unset", async () => {
    await startApp();
    const entry = createRestEntry("rest-tags-unset");
    expect(entry.includeTags).toBeNull();
    expect(entry.excludeOperations).toBeNull();
    const restSpy = spyOn(registrationMod, "performRestRegistration").mockResolvedValue(okOutcome(1));
    try {
      const res = await fetch(`${adminBase}/admin-api/catalog/custom:${entry.id}/install`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      expect(restSpy).toHaveBeenCalledTimes(1);
      const callArg = restSpy.mock.calls[0][0] as { include_tags?: unknown; exclude_operations?: unknown };
      expect(callArg.include_tags).toBeUndefined();
      expect(callArg.exclude_operations).toBeUndefined();
    } finally {
      restSpy.mockRestore();
    }
  });
});

describe("POST /admin-api/catalog/:id/install — custom name resolution", () => {
  test("a whitespace-only custom name falls back to the entry's slug", async () => {
    await startApp();
    const entry = createRestEntry("name-whitespace-entry");
    const restSpy = spyOn(registrationMod, "performRestRegistration").mockResolvedValue(okOutcome(1));
    try {
      const res = await fetch(`${adminBase}/admin-api/catalog/custom:${entry.id}/install`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "   " }),
      });
      expect(res.status).toBe(200);
      const callArg = restSpy.mock.calls[0][0] as { name: string };
      expect(callArg.name).toBe(entry.slug);
    } finally {
      restSpy.mockRestore();
    }
  });

  test("a padded custom name is trimmed before use, not passed through raw", async () => {
    await startApp();
    const entry = createRestEntry("name-padded-entry");
    const restSpy = spyOn(registrationMod, "performRestRegistration").mockResolvedValue(okOutcome(1));
    try {
      const res = await fetch(`${adminBase}/admin-api/catalog/custom:${entry.id}/install`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "  my-custom-name  " }),
      });
      expect(res.status).toBe(200);
      const callArg = restSpy.mock.calls[0][0] as { name: string };
      expect(callArg.name).toBe("my-custom-name");
    } finally {
      restSpy.mockRestore();
    }
  });
});

describe("POST /admin-api/catalog/:id/install — recordAudit only fires on success", () => {
  test("records the exact detail on a successful install", async () => {
    await startApp();
    const entry = createRestEntry("install-audit-success");
    const restSpy = spyOn(registrationMod, "performRestRegistration").mockResolvedValue(okOutcome(7));
    const auditSpy = spyOn(auditMod, "recordAudit");
    try {
      const res = await fetch(`${adminBase}/admin-api/catalog/custom:${entry.id}/install`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "my-install-name" }),
      });
      expect(res.status).toBe(200);
      expect(auditSpy).toHaveBeenCalledWith("bearer:admin-api-key", "catalog.install", `custom:${entry.id}`, {
        installedAs: "my-install-name",
        toolsCount: 7,
      });
    } finally {
      restSpy.mockRestore();
      auditSpy.mockRestore();
    }
  });

  test("does NOT record audit when the registration outcome is a failure", async () => {
    await startApp();
    const entry = createRestEntry("install-audit-failure");
    const restSpy = spyOn(registrationMod, "performRestRegistration").mockResolvedValue(failOutcome());
    const auditSpy = spyOn(auditMod, "recordAudit");
    try {
      const res = await fetch(`${adminBase}/admin-api/catalog/custom:${entry.id}/install`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      expect(auditSpy).not.toHaveBeenCalled();
    } finally {
      restSpy.mockRestore();
      auditSpy.mockRestore();
    }
  });
});
