// Stryker mutation-testing backstop for src/catalog/index.ts.
//
// The existing hand-written src/__tests__/catalog.test.ts already covers the
// happy-path CRUD round trip, invalid/duplicate slug rejection, NOT_FOUND on
// update, and false on delete-of-nonexistent. This file gap-fills:
//   - getCatalogEntry("custom:<non-numeric>") -> Number.isInteger(NaN) guard
//     in the private getCustomEntry() (distinct from "custom:999999", which
//     is a *valid* integer that's simply absent).
//   - createCustomEntry's full default-fallback matrix (every optional field
//     omitted -> stored as null/[]/0) and full-population matrix (every
//     optional field provided -> stored verbatim), including the
//     truthy-check (not `??`) branches on includeTags/excludeOperations,
//     where an explicit `[]` must NOT collapse to null.
//   - updateCustomEntry's per-field merge logic: omitting a field must
//     preserve the existing value, while explicitly passing `null` on a
//     nullable field must overwrite it to null (kills mutants that turn the
//     `!== undefined` merge guards into truthy checks) and explicitly
//     passing `false` on `featured` must overwrite a `true` (kills mutants
//     that turn it into `||`).
//   - listCatalog with >=2 distinct custom entries, including ORDER BY name
//     verification.
// src/catalog/builtin.ts's static data array is explicitly out of scope.

import { describe, test, expect, beforeEach } from "bun:test";
import { __resetDbForTesting } from "../db/connection.js";
import {
  listCatalog,
  getCatalogEntry,
  createCustomEntry,
  updateCustomEntry,
  deleteCustomEntry,
  type CustomCatalogEntryInput,
} from "../catalog/index.js";

beforeEach(() => {
  __resetDbForTesting();
});

function mustCreate(input: CustomCatalogEntryInput, actor: string | null = null) {
  const result = createCustomEntry(input, actor);
  if (!result.ok) throw new Error(`expected create to succeed: ${JSON.stringify(result.error)}`);
  return result.entry;
}

describe("getCatalogEntry — custom: prefix id parsing", () => {
  test("non-numeric suffix hits the Number.isInteger(NaN) guard and resolves to undefined", () => {
    expect(getCatalogEntry("custom:not-a-number")).toBeUndefined();
  });

  test("fractional (non-integer) suffix also resolves to undefined", () => {
    const created = mustCreate({ slug: "frac-target", name: "Frac Target", kind: "rest" });
    // 1.5 truncated/rounded would coincidentally hit a real row in a buggy
    // implementation; assert directly against the real created id to be sure
    // this isn't a false negative.
    expect(getCatalogEntry(`custom:${created.id}.5`)).toBeUndefined();
  });

  test("valid integer suffix for an existing row resolves correctly", () => {
    const created = mustCreate({ slug: "int-target", name: "Int Target", kind: "rest" });
    const found = getCatalogEntry(`custom:${created.id}`);
    expect(found?.source).toBe("custom");
    expect(found?.name).toBe("Int Target");
  });

  test("an id that does NOT start with 'custom:' but whose tail coincidentally parses to a real row id still resolves to undefined", () => {
    // Guards against mutants that force the `id.startsWith("custom:")` check
    // to always-true (or replace the "custom:" literal with ""): those would
    // incorrectly slice off the first 7 characters of ANY string and treat
    // the remainder as a row id. Craft a 7-char, non-"custom:" prefix so the
    // slice-by-7 still lands exactly on the real row's numeric id.
    const created = mustCreate({ slug: "coincidence-target", name: "Coincidence Target", kind: "rest" });
    const bogusId = `zzzzzzz${created.id}`; // "zzzzzzz" is 7 chars, same length as "custom:"
    expect(bogusId.startsWith("custom:")).toBe(false);
    expect(bogusId.startsWith("builtin:")).toBe(false);
    expect(getCatalogEntry(bogusId)).toBeUndefined();
  });
});

describe("createCustomEntry — default fallback matrix (all optional fields omitted)", () => {
  test("stores null/[]/false defaults for every unspecified optional field", () => {
    const entry = mustCreate({ slug: "minimal-entry", name: "Minimal Entry", kind: "rest" });
    expect(entry.description).toBeNull();
    expect(entry.category).toBeNull();
    expect(entry.tags).toEqual([]);
    expect(entry.icon).toBeNull();
    expect(entry.openapiUrl).toBeNull();
    expect(entry.healthUrl).toBeNull();
    expect(entry.baseUrl).toBeNull();
    expect(entry.includeTags).toBeNull();
    expect(entry.excludeOperations).toBeNull();
    expect(entry.mcpUrl).toBeNull();
    expect(entry.mcpTransport).toBeNull();
    expect(entry.featured).toBe(false);
    expect(typeof entry.featured).toBe("boolean");
    expect(entry.createdBy).toBeNull();
  });

  test("actor is stored verbatim as createdBy when provided", () => {
    const entry = mustCreate({ slug: "with-actor", name: "With Actor", kind: "rest" }, "alice");
    expect(entry.createdBy).toBe("alice");
  });

  test("an explicit empty includeTags/excludeOperations array is stored as [] not null (truthy check, not `??`)", () => {
    const entry = mustCreate({
      slug: "empty-arrays",
      name: "Empty Arrays",
      kind: "rest",
      includeTags: [],
      excludeOperations: [],
    });
    expect(entry.includeTags).toEqual([]);
    expect(entry.excludeOperations).toEqual([]);
  });
});

describe("createCustomEntry — full population matrix (every optional field provided)", () => {
  test("stores every optional field verbatim", () => {
    const entry = mustCreate(
      {
        slug: "full-entry",
        name: "Full Entry",
        description: "a full description",
        kind: "mcp",
        category: "productivity",
        tags: ["alpha", "beta"],
        icon: "rocket",
        openapiUrl: "https://api.example.com/openapi.json",
        healthUrl: "https://api.example.com/health",
        baseUrl: "https://api.example.com",
        includeTags: ["public"],
        excludeOperations: ["deleteThing"],
        mcpUrl: "https://mcp.example.com",
        mcpTransport: "streamable-http",
        featured: true,
      },
      "bob",
    );
    expect(entry.description).toBe("a full description");
    expect(entry.kind).toBe("mcp");
    expect(entry.category).toBe("productivity");
    expect(entry.tags).toEqual(["alpha", "beta"]);
    expect(entry.icon).toBe("rocket");
    expect(entry.openapiUrl).toBe("https://api.example.com/openapi.json");
    expect(entry.healthUrl).toBe("https://api.example.com/health");
    expect(entry.baseUrl).toBe("https://api.example.com");
    expect(entry.includeTags).toEqual(["public"]);
    expect(entry.excludeOperations).toEqual(["deleteThing"]);
    expect(entry.mcpUrl).toBe("https://mcp.example.com");
    expect(entry.mcpTransport).toBe("streamable-http");
    expect(entry.featured).toBe(true);
    expect(entry.createdBy).toBe("bob");
  });
});

describe("createCustomEntry — slug validation boundaries", () => {
  test("a single-character slug (minimum length) is valid", () => {
    const result = createCustomEntry({ slug: "a", name: "A", kind: "rest" }, null);
    expect(result.ok).toBe(true);
  });

  test("a 63-character slug (1 + 62, the maximum) is valid", () => {
    const slug = "a" + "b".repeat(62);
    expect(slug.length).toBe(63);
    const result = createCustomEntry({ slug, name: "Long", kind: "rest" }, null);
    expect(result.ok).toBe(true);
  });

  test("a 64-character slug (one over the maximum) is rejected", () => {
    const slug = "a" + "b".repeat(63);
    expect(slug.length).toBe(64);
    const result = createCustomEntry({ slug, name: "TooLong", kind: "rest" }, null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_SLUG");
  });

  test("an empty slug is rejected", () => {
    const result = createCustomEntry({ slug: "", name: "Empty", kind: "rest" }, null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_SLUG");
  });

  test("a slug starting with a disallowed leading character (underscore) is rejected", () => {
    const result = createCustomEntry({ slug: "_leading", name: "Leading", kind: "rest" }, null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_SLUG");
  });

  test("INVALID_SLUG error carries the full, real, non-empty guidance message", () => {
    const result = createCustomEntry({ slug: "Not Valid!", name: "x", kind: "rest" }, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("Catalog entry slug must match /^[a-z0-9][a-z0-9_-]{0,62}$/");
    }
  });

  test("ALREADY_EXISTS error message names the actual offending slug", () => {
    mustCreate({ slug: "message-dup", name: "First", kind: "rest" });
    const second = createCustomEntry({ slug: "message-dup", name: "Second", kind: "rest" }, null);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.message).toBe('Catalog entry "message-dup" already exists');
    }
  });

  test("a slug with underscores and dashes after the first character is valid", () => {
    const result = createCustomEntry({ slug: "a_b-c9", name: "Mixed", kind: "rest" }, null);
    expect(result.ok).toBe(true);
  });
});

describe("updateCustomEntry — per-field merge semantics", () => {
  function createFullEntry() {
    return mustCreate(
      {
        slug: "merge-target",
        name: "Original Name",
        description: "original description",
        kind: "rest",
        category: "original-category",
        tags: ["orig-tag"],
        icon: "orig-icon",
        openapiUrl: "https://orig.example.com/openapi.json",
        healthUrl: "https://orig.example.com/health",
        baseUrl: "https://orig.example.com",
        includeTags: ["orig-include"],
        excludeOperations: ["orig-exclude"],
        mcpUrl: "https://orig-mcp.example.com",
        mcpTransport: "sse",
        featured: true,
      },
      "creator",
    );
  }

  test("updating only one field preserves every other field untouched", () => {
    const original = createFullEntry();
    const result = updateCustomEntry(original.id, { category: "new-category" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const updated = result.entry;

    expect(updated.category).toBe("new-category");
    // Everything else must be byte-for-byte preserved.
    expect(updated.slug).toBe(original.slug);
    expect(updated.name).toBe(original.name);
    expect(updated.description).toBe(original.description);
    expect(updated.kind).toBe(original.kind);
    expect(updated.tags).toEqual(original.tags);
    expect(updated.icon).toBe(original.icon);
    expect(updated.openapiUrl).toBe(original.openapiUrl);
    expect(updated.healthUrl).toBe(original.healthUrl);
    expect(updated.baseUrl).toBe(original.baseUrl);
    expect(updated.includeTags).toEqual(original.includeTags);
    expect(updated.excludeOperations).toEqual(original.excludeOperations);
    expect(updated.mcpUrl).toBe(original.mcpUrl);
    expect(updated.mcpTransport).toBe(original.mcpTransport);
    expect(updated.featured).toBe(original.featured);
  });

  test("explicit null on every nullable field overwrites a previously non-null value (not a truthy check)", () => {
    const original = createFullEntry();
    const result = updateCustomEntry(original.id, {
      description: null,
      category: null,
      icon: null,
      openapiUrl: null,
      healthUrl: null,
      baseUrl: null,
      includeTags: null,
      excludeOperations: null,
      mcpUrl: null,
      mcpTransport: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const updated = result.entry;
    expect(updated.description).toBeNull();
    expect(updated.category).toBeNull();
    expect(updated.icon).toBeNull();
    expect(updated.openapiUrl).toBeNull();
    expect(updated.healthUrl).toBeNull();
    expect(updated.baseUrl).toBeNull();
    expect(updated.includeTags).toBeNull();
    expect(updated.excludeOperations).toBeNull();
    expect(updated.mcpUrl).toBeNull();
    expect(updated.mcpTransport).toBeNull();
    // Untouched fields must remain exactly as they were.
    expect(updated.name).toBe(original.name);
    expect(updated.tags).toEqual(original.tags);
    expect(updated.featured).toBe(original.featured);
  });

  test("explicit featured:false overwrites a previously-true value (not `||`), and category is preserved when omitted", () => {
    const original = createFullEntry();
    expect(original.featured).toBe(true);
    const result = updateCustomEntry(original.id, { featured: false });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.featured).toBe(false);
      // `category` was NOT part of this update payload — guards against a
      // mutant that forces category's `!== undefined` merge guard to always
      // pick `updates.category` (which would be `undefined` here, wiping the
      // existing value to null instead of preserving it).
      expect(result.entry.category).toBe(original.category);
    }
  });

  test("update on a nonexistent id returns NOT_FOUND with a message naming the real id", () => {
    const result = updateCustomEntry(918273645, { name: "ghost" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.message).toBe("Catalog entry 918273645 not found");
    }
  });

  test("updating name/kind/tags overrides the previous values (?? left-hand truthy branch)", () => {
    const original = createFullEntry();
    const result = updateCustomEntry(original.id, {
      name: "Renamed",
      kind: "mcp",
      tags: ["new-tag-a", "new-tag-b"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.name).toBe("Renamed");
    expect(result.entry.kind).toBe("mcp");
    expect(result.entry.tags).toEqual(["new-tag-a", "new-tag-b"]);
  });

  test("the returned entry matches a fresh read of the same custom id (persists to the DB)", () => {
    const original = createFullEntry();
    updateCustomEntry(original.id, { name: "Persisted Rename" });
    const reread = getCatalogEntry(`custom:${original.id}`);
    expect(reread?.name).toBe("Persisted Rename");
  });

  test("update on a nonexistent id returns NOT_FOUND without touching any row", () => {
    const before = listCatalog().filter((e) => e.source === "custom").length;
    const result = updateCustomEntry(123456789, { name: "ghost" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    const after = listCatalog().filter((e) => e.source === "custom").length;
    expect(after).toBe(before);
  });
});

describe("listCatalog — multiple custom entries", () => {
  test("includes >=2 distinct custom entries each with their own distinct prefixed id", () => {
    const first = mustCreate({ slug: "distinct-one", name: "Distinct One", kind: "rest" });
    const second = mustCreate({ slug: "distinct-two", name: "Distinct Two", kind: "rest" });
    expect(first.id).not.toBe(second.id);

    const items = listCatalog();
    const foundFirst = items.find((i) => i.id === `custom:${first.id}`);
    const foundSecond = items.find((i) => i.id === `custom:${second.id}`);
    expect(foundFirst).toBeDefined();
    expect(foundSecond).toBeDefined();
    expect(foundFirst?.name).toBe("Distinct One");
    expect(foundSecond?.name).toBe("Distinct Two");
    // The two entries must genuinely be different rows, not the same one
    // duplicated (which a broken filter could produce).
    expect(foundFirst?.id).not.toBe(foundSecond?.id);
  });

  test("custom entries are returned ordered by name ascending (ORDER BY name)", () => {
    mustCreate({ slug: "order-charlie", name: "Charlie", kind: "rest" });
    mustCreate({ slug: "order-alpha", name: "Alpha", kind: "rest" });
    mustCreate({ slug: "order-bravo", name: "Bravo", kind: "rest" });

    const customNames = listCatalog()
      .filter((e) => e.source === "custom")
      .map((e) => e.name);
    expect(customNames).toEqual(["Alpha", "Bravo", "Charlie"]);
  });
});

describe("deleteCustomEntry", () => {
  test("returns true and removes the entry from listCatalog on success", () => {
    const entry = mustCreate({ slug: "to-delete", name: "To Delete", kind: "rest" });
    expect(listCatalog().some((i) => i.id === `custom:${entry.id}`)).toBe(true);

    expect(deleteCustomEntry(entry.id)).toBe(true);

    expect(listCatalog().some((i) => i.id === `custom:${entry.id}`)).toBe(false);
    expect(getCatalogEntry(`custom:${entry.id}`)).toBeUndefined();
  });

  test("deleting one entry does not affect a sibling entry", () => {
    const keep = mustCreate({ slug: "keep-me", name: "Keep Me", kind: "rest" });
    const remove = mustCreate({ slug: "remove-me", name: "Remove Me", kind: "rest" });

    expect(deleteCustomEntry(remove.id)).toBe(true);

    expect(getCatalogEntry(`custom:${keep.id}`)).toBeDefined();
    expect(getCatalogEntry(`custom:${remove.id}`)).toBeUndefined();
  });
});
