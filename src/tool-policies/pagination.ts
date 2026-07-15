/**
 * Per-tool response auto-pagination for idempotent (GET) REST tools.
 *
 * When enabled, the proxy follows a tool's pagination and aggregates the array
 * found at `itemsPath` across pages into a single JSON body, bounded by
 * `maxPages` and the global response byte cap. Three strategies:
 *   - "cursor": the body carries a next cursor at `cursorResponsePath`; the next
 *     request repeats with that value in the `cursorParam` query param.
 *   - "page":   the next request increments a `pageParam` query param until a
 *     page returns an empty items array.
 *   - "link":   follow the RFC 5988 `Link: <url>; rel="next"` response header.
 *
 * Only same-host follow-ups are made (the proxy reuses the pinned IP + Host of
 * the primary request); a `link` next URL to a different host is not followed,
 * keeping the aggregation DNS-rebinding/SSRF-safe. This module holds the durable
 * config + the pure helpers; the fetch loop lives in proxy.ts where the pinned
 * transport is.
 */
import { getDb } from "../db/connection.js";
import { getByPath, hasUnsafeSegment } from "../lib/object-path.js";
import { toolExists, upsertConfig } from "../lib/tool-config.js";

export type PaginationStrategy = "cursor" | "page" | "link";

export interface PaginationConfig {
  enabled: boolean;
  strategy: PaginationStrategy;
  itemsPath: string;
  cursorResponsePath?: string;
  cursorParam?: string;
  pageParam?: string;
  maxPages: number;
}

/** Hard cap on pages followed, regardless of a tool's configured maxPages. */
export const MAX_PAGINATION_PAGES = 100;

interface PaginationRow {
  strategy: string;
  items_path: string;
  cursor_response_path: string | null;
  cursor_param: string | null;
  page_param: string | null;
  max_pages: number;
  enabled: number;
}

export function getPaginationConfig(clientName: string, toolName: string): PaginationConfig | null {
  const row = getDb()
    .query(
      `SELECT strategy, items_path, cursor_response_path, cursor_param, page_param, max_pages, enabled
       FROM tool_pagination WHERE client_name = ? AND tool_name = ?`,
    )
    .get(clientName, toolName) as PaginationRow | null;
  if (!row) return null;
  return {
    enabled: row.enabled === 1,
    strategy: row.strategy as PaginationStrategy,
    itemsPath: row.items_path,
    cursorResponsePath: row.cursor_response_path ?? undefined,
    cursorParam: row.cursor_param ?? undefined,
    pageParam: row.page_param ?? undefined,
    maxPages: row.max_pages,
  };
}

/**
 * Persists (or clears with null) a tool's pagination config. Returns false when
 * the tool does not exist. Callers validate the shape first (see admin route).
 */
export function setPaginationConfig(
  clientName: string,
  toolName: string,
  input: {
    enabled: boolean;
    strategy: PaginationStrategy;
    itemsPath: string;
    cursorResponsePath?: string;
    cursorParam?: string;
    pageParam?: string;
    maxPages: number;
  } | null,
): boolean {
  if (!toolExists(clientName, toolName)) return false;

  if (input === null) {
    getDb().query(`DELETE FROM tool_pagination WHERE client_name = ? AND tool_name = ?`).run(clientName, toolName);
    return true;
  }
  upsertConfig(
    "tool_pagination",
    { client_name: clientName, tool_name: toolName },
    {
      strategy: input.strategy,
      items_path: input.itemsPath,
      cursor_response_path: input.cursorResponsePath ?? null,
      cursor_param: input.cursorParam ?? null,
      page_param: input.pageParam ?? null,
      max_pages: input.maxPages,
      enabled: input.enabled ? 1 : 0,
    },
    Date.now(),
  );
  return true;
}

// ── Pure helpers (unit-tested; used by the proxy loop) ──────────────────────
// getByPath is the shared, prototype-pollution-safe helper from ../lib.

/** Returns the array at `itemsPath`, or null when it isn't an array. */
export function extractItems(body: unknown, itemsPath: string): unknown[] | null {
  const v = getByPath(body, itemsPath);
  return Array.isArray(v) ? v : null;
}

/** Returns the next cursor value (string/number coerced to string), or null. */
export function nextCursorValue(body: unknown, cursorResponsePath: string): string | null {
  const v = getByPath(body, cursorResponsePath);
  if (typeof v === "string") return v === "" ? null : v;
  if (typeof v === "number") return String(v);
  return null;
}

/** Parses an RFC 5988 Link header and returns the rel="next" URL, or null. */
export function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*(.+)/);
    if (!m) continue;
    if (/rel\s*=\s*"?next"?/i.test(m[2])) return m[1].trim();
  }
  return null;
}

/** Returns a shallow clone of `body` with the array at `itemsPath` replaced. */
export function withItems(body: unknown, itemsPath: string, items: unknown[]): unknown {
  if (itemsPath === "") return items;
  if (hasUnsafeSegment(itemsPath)) return body;
  if (body === null || typeof body !== "object") return body;
  const root: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  const keys = itemsPath.split(".");
  let cur = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const child = cur[keys[i]];
    if (child === null || typeof child !== "object") return root;
    cur[keys[i]] = { ...(child as Record<string, unknown>) };
    cur = cur[keys[i]] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = items;
  return root;
}
