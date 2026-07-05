import { describe, test, expect, beforeEach } from "bun:test";
import { __resetDbForTesting } from "../db/connection.js";
import {
  listCatalog,
  getCatalogEntry,
  createCustomEntry,
  updateCustomEntry,
  deleteCustomEntry,
} from "../catalog/index.js";
import { BUILTIN_CATALOG } from "../catalog/builtin.js";

beforeEach(() => {
  __resetDbForTesting();
});

describe("listCatalog / getCatalogEntry", () => {
  test("includes every builtin entry, prefixed and tagged", () => {
    const items = listCatalog();
    for (const b of BUILTIN_CATALOG) {
      const found = items.find((i) => i.id === `builtin:${b.slug}`);
      expect(found).toBeDefined();
      expect(found?.source).toBe("builtin");
    }
  });

  test("resolves a builtin entry by prefixed id", () => {
    const b = BUILTIN_CATALOG[0];
    const entry = getCatalogEntry(`builtin:${b.slug}`);
    expect(entry?.source).toBe("builtin");
    expect(entry?.name).toBe(b.name);
  });

  test("unknown id resolves to undefined for both prefixes", () => {
    expect(getCatalogEntry("builtin:does-not-exist")).toBeUndefined();
    expect(getCatalogEntry("custom:999999")).toBeUndefined();
    expect(getCatalogEntry("not-a-prefixed-id")).toBeUndefined();
  });
});

describe("BUILTIN_CATALOG content", () => {
  test("the old Petstore demo entry is gone", () => {
    expect(BUILTIN_CATALOG.find((b) => b.slug === "petstore")).toBeUndefined();
    expect(BUILTIN_CATALOG.find((b) => /petstore/i.test(b.name))).toBeUndefined();
  });

  test("has a healthy number of real, professional entries", () => {
    expect(BUILTIN_CATALOG.length).toBeGreaterThanOrEqual(5);
  });

  test("every entry is well-formed", () => {
    const slugs = new Set<string>();
    for (const entry of BUILTIN_CATALOG) {
      expect(entry.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(slugs.has(entry.slug)).toBe(false);
      slugs.add(entry.slug);

      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.category.length).toBeGreaterThan(0);
      expect(entry.icon.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.tags)).toBe(true);
      expect(entry.tags.length).toBeGreaterThan(0);
      expect(["rest", "mcp"]).toContain(entry.kind);

      if (entry.kind === "rest") {
        // REST entries must be resolvable through the exact same install path
        // as a hand-typed registration: an openapi_url (or a manual base/health
        // pair), all served over https.
        expect(entry.openapiUrl).toBeDefined();
        expect(entry.openapiUrl).toMatch(/^https:\/\//);
        expect(entry.healthUrl).toBeDefined();
        expect(entry.healthUrl).toMatch(/^https:\/\//);
        expect(entry.baseUrl).toBeDefined();
        expect(entry.baseUrl).toMatch(/^https:\/\//);
      } else {
        expect(entry.mcpUrl).toBeDefined();
        expect(entry.mcpUrl).toMatch(/^https?:\/\//);
      }

      // includeTags/excludeOperations are only meaningful alongside an
      // openapi_url-driven discovery — the same precondition performRestRegistration
      // enforces (tools XOR openapi_url).
      if (entry.includeTags || entry.excludeOperations) {
        expect(entry.openapiUrl).toBeDefined();
      }
    }
  });

  test("featured entries are a small, deliberate subset", () => {
    const featured = BUILTIN_CATALOG.filter((b) => b.featured);
    expect(featured.length).toBeGreaterThanOrEqual(1);
    expect(featured.length).toBeLessThanOrEqual(3);
  });
});

describe("custom catalog entries", () => {
  test("create / list / get / update / delete round-trip", () => {
    const created = createCustomEntry(
      {
        slug: "internal-crm-staging",
        name: "Internal CRM (staging)",
        kind: "rest",
        healthUrl: "https://crm.staging.internal/health",
        openapiUrl: "https://crm.staging.internal/openapi.json",
      },
      "admin",
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const items = listCatalog();
    expect(items.find((i) => i.id === `custom:${created.entry.id}`)).toBeDefined();

    const fetched = getCatalogEntry(`custom:${created.entry.id}`);
    expect(fetched?.source).toBe("custom");
    expect(fetched?.name).toBe("Internal CRM (staging)");

    const updated = updateCustomEntry(created.entry.id, { name: "Internal CRM (staging, renamed)", featured: true });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.entry.name).toBe("Internal CRM (staging, renamed)");
      expect(updated.entry.featured).toBe(true);
    }

    expect(deleteCustomEntry(created.entry.id)).toBe(true);
    expect(getCatalogEntry(`custom:${created.entry.id}`)).toBeUndefined();
  });

  test("rejects an invalid slug", () => {
    const result = createCustomEntry({ slug: "Not Valid!", name: "x", kind: "rest" }, null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_SLUG");
  });

  test("rejects a duplicate slug", () => {
    createCustomEntry({ slug: "dup", name: "First", kind: "rest" }, null);
    const second = createCustomEntry({ slug: "dup", name: "Second", kind: "rest" }, null);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("ALREADY_EXISTS");
  });

  test("update on a nonexistent id returns NOT_FOUND", () => {
    const result = updateCustomEntry(999999, { name: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  test("delete on a nonexistent id returns false", () => {
    expect(deleteCustomEntry(999999)).toBe(false);
  });
});
