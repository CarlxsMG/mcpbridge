/**
 * Server-side pagination follow-up for REST GET tools: given the first JSON
 * page, walk cursor / page / link pagination and aggregate the items array into
 * one result (MCP returns a single tool result per call). Every follow-up page
 * reuses the primary request's DNS-pinned fetch + Host, so it pins exactly like
 * the primary request — a `link` next-URL to a different host is never followed
 * (SSRF-safe), and the whole walk is bounded by `cfg.maxPages` and an aggregate
 * byte cap. Extracted from proxy.ts; the pure parsing helpers it builds on
 * (extractItems / nextCursorValue / parseNextLink / withItems) live in
 * tool-policies/pagination.ts.
 */
import {
  extractItems,
  nextCursorValue,
  parseNextLink,
  withItems,
  type PaginationConfig,
} from "../tool-policies/pagination.js";
import type { PinnedFetch } from "../net/ip-validator.js";
import { readBodyWithCap } from "./http-util.js";

export interface PageCtx {
  targetBaseUrl: string;
  resolvedPath: string;
  baseQuery: URLSearchParams;
  /**
   * The shared DNS-pinned fetch from the primary request (makePinnedFetch):
   * swaps the original hostname for the SSRF-validated IP, preserves the Host
   * header, and refuses redirects. Every follow-up page reuses it, so pagination
   * pins exactly like the primary request without re-implementing the technique.
   */
  pinnedFetch: PinnedFetch;
  /** Original host:port of the primary request — used only for the cross-host next-link guard. */
  originalHost: string;
  headers: Record<string, string>;
  timeoutMs: number;
  externalSignal: AbortSignal;
  maxBytes: number;
  firstBytes: number;
  firstLink: string | null;
}

/**
 * Builds a same-host page URL keeping the original hostname — the pinned fetch
 * (ctx.pinnedFetch) swaps it to the validated IP at request time.
 */
function buildPageUrl(baseUrl: string, path: string, query: URLSearchParams): string {
  const u = new URL(`${baseUrl}${path}`);
  u.search = query.toString();
  return u.toString();
}

/**
 * Follows pagination from a first JSON page, aggregating the array at
 * `cfg.itemsPath` across pages. Returns the merged body as pretty JSON, or null
 * when the first body isn't paginable (not JSON / itemsPath not an array / empty).
 * Every follow-up reuses the pinned IP + Host of the primary request; a `link`
 * next URL to a different host is not followed (SSRF-safe). Bounded by
 * cfg.maxPages and the aggregate byte cap.
 */
export async function fetchAllPages(
  firstBodyText: string,
  cfg: PaginationConfig,
  ctx: PageCtx,
): Promise<string | null> {
  let firstBody: unknown;
  try {
    firstBody = JSON.parse(firstBodyText);
  } catch {
    return null;
  }
  const firstItems = extractItems(firstBody, cfg.itemsPath);
  if (!firstItems || firstItems.length === 0) return null;

  const all: unknown[] = [...firstItems];
  let totalBytes = ctx.firstBytes;
  let cursor: string | null =
    cfg.strategy === "cursor" ? nextCursorValue(firstBody, cfg.cursorResponsePath ?? "") : null;
  let link: string | null = cfg.strategy === "link" ? parseNextLink(ctx.firstLink) : null;
  let pageNum = 2;

  const fetchPage = async (urlStr: string): Promise<{ ok: boolean; text: string | null; link: string | null }> => {
    const signal = AbortSignal.any([ctx.externalSignal, AbortSignal.timeout(ctx.timeoutMs)]);
    // urlStr carries the ORIGINAL hostname; ctx.pinnedFetch swaps it to the
    // validated IP, sets the Host header (host:port) from the URL, and refuses
    // redirects — the identical DNS-rebinding-safe transport the primary used.
    const resp = await ctx.pinnedFetch(urlStr, {
      method: "GET",
      headers: { ...ctx.headers, "Content-Type": "application/json" },
      signal,
    });
    const text = resp.ok ? await readBodyWithCap(resp) : null;
    return { ok: resp.ok, text, link: resp.headers.get("link") };
  };

  const limit = Math.min(cfg.maxPages, 100);
  for (let page = 1; page < limit; page++) {
    let urlStr: string;
    if (cfg.strategy === "cursor") {
      if (!cursor) break;
      const q = new URLSearchParams(ctx.baseQuery);
      q.set(cfg.cursorParam ?? "cursor", cursor);
      urlStr = buildPageUrl(ctx.targetBaseUrl, ctx.resolvedPath, q);
    } else if (cfg.strategy === "page") {
      const q = new URLSearchParams(ctx.baseQuery);
      q.set(cfg.pageParam ?? "page", String(pageNum));
      urlStr = buildPageUrl(ctx.targetBaseUrl, ctx.resolvedPath, q);
    } else {
      if (!link) break;
      let linkUrl: URL;
      try {
        linkUrl = new URL(link);
      } catch {
        break;
      }
      if (linkUrl.host !== ctx.originalHost) break; // cross-host next: stop (SSRF-safe)
      urlStr = linkUrl.toString(); // original hostname; ctx.pinnedFetch pins it to the validated IP
    }

    let res: { ok: boolean; text: string | null; link: string | null };
    try {
      res = await fetchPage(urlStr);
    } catch {
      break;
    }
    if (!res.ok || res.text === null) break;

    let body: unknown;
    try {
      body = JSON.parse(res.text);
    } catch {
      break;
    }
    const items = extractItems(body, cfg.itemsPath);
    if (!items || items.length === 0) break;

    all.push(...items);
    totalBytes += new TextEncoder().encode(res.text).length;
    if (totalBytes > ctx.maxBytes) break;

    if (cfg.strategy === "cursor") {
      cursor = nextCursorValue(body, cfg.cursorResponsePath ?? "");
      if (!cursor) break;
    } else if (cfg.strategy === "link") {
      link = parseNextLink(res.link);
      if (!link) break;
    } else {
      pageNum++;
    }
  }

  return JSON.stringify(withItems(firstBody, cfg.itemsPath, all), null, 2);
}
