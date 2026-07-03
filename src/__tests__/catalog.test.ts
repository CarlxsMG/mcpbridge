import { describe, test, expect, beforeEach } from "bun:test";
import { __resetDbForTesting } from "../db/connection.js";
import { listCatalog, getCatalogEntry, createCustomEntry, updateCustomEntry, deleteCustomEntry } from "../catalog.js";
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
