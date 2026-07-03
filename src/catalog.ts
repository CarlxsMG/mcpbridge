import { getDb } from "./db/connection.js";
import { BUILTIN_CATALOG, type BuiltinCatalogEntry } from "./catalog/builtin.js";

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export interface CustomCatalogEntryInput {
  slug: string;
  name: string;
  description?: string | null;
  kind: "rest" | "mcp";
  category?: string | null;
  tags?: string[];
  icon?: string | null;
  openapiUrl?: string | null;
  healthUrl?: string | null;
  baseUrl?: string | null;
  includeTags?: string[] | null;
  excludeOperations?: string[] | null;
  mcpUrl?: string | null;
  mcpTransport?: "streamable-http" | "sse" | null;
  featured?: boolean;
}

interface CustomCatalogRow {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  kind: "rest" | "mcp";
  category: string | null;
  tags_json: string;
  icon: string | null;
  openapi_url: string | null;
  health_url: string | null;
  base_url: string | null;
  include_tags_json: string | null;
  exclude_operations_json: string | null;
  mcp_url: string | null;
  mcp_transport: "streamable-http" | "sse" | null;
  featured: number;
  created_at: number;
  updated_at: number;
  created_by: string | null;
}

export interface CustomCatalogEntry {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  kind: "rest" | "mcp";
  category: string | null;
  tags: string[];
  icon: string | null;
  openapiUrl: string | null;
  healthUrl: string | null;
  baseUrl: string | null;
  includeTags: string[] | null;
  excludeOperations: string[] | null;
  mcpUrl: string | null;
  mcpTransport: "streamable-http" | "sse" | null;
  featured: boolean;
  createdAt: number;
  updatedAt: number;
  createdBy: string | null;
}

export type CatalogEntry =
  | (BuiltinCatalogEntry & { id: string; source: "builtin" })
  | (Omit<CustomCatalogEntry, "id"> & { id: string; source: "custom" });

export type CatalogMutationError =
  | { code: "INVALID_SLUG"; message: string }
  | { code: "ALREADY_EXISTS"; message: string }
  | { code: "NOT_FOUND"; message: string }
  | { code: "IMMUTABLE_ENTRY"; message: string };

export type CatalogMutationResult =
  { ok: true; entry: CustomCatalogEntry } | { ok: false; error: CatalogMutationError };

const COLS =
  "id, slug, name, description, kind, category, tags_json, icon, openapi_url, health_url, base_url, include_tags_json, exclude_operations_json, mcp_url, mcp_transport, featured, created_at, updated_at, created_by";

function rowToEntry(row: CustomCatalogRow): CustomCatalogEntry {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    kind: row.kind,
    category: row.category,
    tags: JSON.parse(row.tags_json) as string[],
    icon: row.icon,
    openapiUrl: row.openapi_url,
    healthUrl: row.health_url,
    baseUrl: row.base_url,
    includeTags: row.include_tags_json ? (JSON.parse(row.include_tags_json) as string[]) : null,
    excludeOperations: row.exclude_operations_json ? (JSON.parse(row.exclude_operations_json) as string[]) : null,
    mcpUrl: row.mcp_url,
    mcpTransport: row.mcp_transport,
    featured: row.featured === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
  };
}

function listCustomEntries(): CustomCatalogEntry[] {
  return (getDb().query(`SELECT ${COLS} FROM catalog_entries ORDER BY name`).all() as CustomCatalogRow[]).map(
    rowToEntry,
  );
}

function getCustomEntry(id: number): CustomCatalogEntry | null {
  if (!Number.isInteger(id)) return null;
  const row = getDb().query(`SELECT ${COLS} FROM catalog_entries WHERE id = ?`).get(id) as CustomCatalogRow | null;
  return row ? rowToEntry(row) : null;
}

function customSlugExists(slug: string): boolean {
  return getDb().query(`SELECT 1 FROM catalog_entries WHERE slug = ?`).get(slug) != null;
}

/** Merges the static builtin catalog with admin-authored custom entries, tagging each with its source. */
export function listCatalog(): CatalogEntry[] {
  const builtin: CatalogEntry[] = BUILTIN_CATALOG.map((e) => ({
    ...e,
    id: `builtin:${e.slug}`,
    source: "builtin" as const,
  }));
  const custom: CatalogEntry[] = listCustomEntries().map((e) => ({
    ...e,
    id: `custom:${e.id}`,
    source: "custom" as const,
  }));
  return [...builtin, ...custom];
}

/** Resolves a catalog entry by its prefixed id ("builtin:<slug>" or "custom:<row id>"). */
export function getCatalogEntry(id: string): CatalogEntry | undefined {
  if (id.startsWith("builtin:")) {
    const slug = id.slice("builtin:".length);
    const e = BUILTIN_CATALOG.find((b) => b.slug === slug);
    return e ? { ...e, id, source: "builtin" } : undefined;
  }
  if (id.startsWith("custom:")) {
    const rowId = Number(id.slice("custom:".length));
    const e = getCustomEntry(rowId);
    return e ? { ...e, id, source: "custom" } : undefined;
  }
  return undefined;
}

export function createCustomEntry(input: CustomCatalogEntryInput, actor: string | null): CatalogMutationResult {
  if (!NAME_RE.test(input.slug)) {
    return {
      ok: false,
      error: { code: "INVALID_SLUG", message: "Catalog entry slug must match /^[a-z0-9][a-z0-9_-]{0,62}$/" },
    };
  }
  if (customSlugExists(input.slug)) {
    return { ok: false, error: { code: "ALREADY_EXISTS", message: `Catalog entry "${input.slug}" already exists` } };
  }
  const now = Date.now();
  const row = getDb()
    .query(
      `INSERT INTO catalog_entries
         (slug, name, description, kind, category, tags_json, icon, openapi_url, health_url, base_url, include_tags_json, exclude_operations_json, mcp_url, mcp_transport, featured, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING ${COLS}`,
    )
    .get(
      input.slug,
      input.name,
      input.description ?? null,
      input.kind,
      input.category ?? null,
      JSON.stringify(input.tags ?? []),
      input.icon ?? null,
      input.openapiUrl ?? null,
      input.healthUrl ?? null,
      input.baseUrl ?? null,
      input.includeTags ? JSON.stringify(input.includeTags) : null,
      input.excludeOperations ? JSON.stringify(input.excludeOperations) : null,
      input.mcpUrl ?? null,
      input.mcpTransport ?? null,
      input.featured ? 1 : 0,
      now,
      now,
      actor,
    ) as CustomCatalogRow;
  return { ok: true, entry: rowToEntry(row) };
}

export function updateCustomEntry(id: number, updates: Partial<CustomCatalogEntryInput>): CatalogMutationResult {
  const existing = getCustomEntry(id);
  if (!existing) {
    return { ok: false, error: { code: "NOT_FOUND", message: `Catalog entry ${id} not found` } };
  }
  const merged: CustomCatalogEntryInput = {
    slug: existing.slug,
    name: updates.name ?? existing.name,
    description: updates.description !== undefined ? updates.description : existing.description,
    kind: updates.kind ?? existing.kind,
    category: updates.category !== undefined ? updates.category : existing.category,
    tags: updates.tags ?? existing.tags,
    icon: updates.icon !== undefined ? updates.icon : existing.icon,
    openapiUrl: updates.openapiUrl !== undefined ? updates.openapiUrl : existing.openapiUrl,
    healthUrl: updates.healthUrl !== undefined ? updates.healthUrl : existing.healthUrl,
    baseUrl: updates.baseUrl !== undefined ? updates.baseUrl : existing.baseUrl,
    includeTags: updates.includeTags !== undefined ? updates.includeTags : existing.includeTags,
    excludeOperations: updates.excludeOperations !== undefined ? updates.excludeOperations : existing.excludeOperations,
    mcpUrl: updates.mcpUrl !== undefined ? updates.mcpUrl : existing.mcpUrl,
    mcpTransport: updates.mcpTransport !== undefined ? updates.mcpTransport : existing.mcpTransport,
    featured: updates.featured !== undefined ? updates.featured : existing.featured,
  };
  getDb()
    .query(
      `UPDATE catalog_entries SET
         name = ?, description = ?, kind = ?, category = ?, tags_json = ?, icon = ?,
         openapi_url = ?, health_url = ?, base_url = ?, include_tags_json = ?, exclude_operations_json = ?,
         mcp_url = ?, mcp_transport = ?, featured = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      merged.name,
      merged.description ?? null,
      merged.kind,
      merged.category ?? null,
      JSON.stringify(merged.tags ?? []),
      merged.icon ?? null,
      merged.openapiUrl ?? null,
      merged.healthUrl ?? null,
      merged.baseUrl ?? null,
      merged.includeTags ? JSON.stringify(merged.includeTags) : null,
      merged.excludeOperations ? JSON.stringify(merged.excludeOperations) : null,
      merged.mcpUrl ?? null,
      merged.mcpTransport ?? null,
      merged.featured ? 1 : 0,
      Date.now(),
      id,
    );
  return { ok: true, entry: getCustomEntry(id)! };
}

export function deleteCustomEntry(id: number): boolean {
  return getDb().query(`DELETE FROM catalog_entries WHERE id = ?`).run(id).changes > 0;
}
