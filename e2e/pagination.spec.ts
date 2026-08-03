/**
 * Keyset/cursor pagination — the admin list API, and the SPA pager built on it.
 *
 * ── The contract, read from src/lib/pagination-cursor.ts ─────────────────────
 * `keysetPaginate` asks SQLite for `limit + 1` rows, slices back down to
 * `limit`, and — only when that extra row actually existed — returns
 * `nextCursor`: the STRINGIFIED keyset key of the LAST row it just handed back.
 * There is no offset, no COUNT query and no opaque encoding. The cursor IS the
 * key, and every call site replays it as a plain SQL comparison against the same
 * column it ordered by (`id < ?` for the id-keyed listings, `name > ?` for the
 * name-keyed one, `HAVING MAX(id) < ?` for the grouped trace listing). A client
 * therefore walks a listing by echoing `nextCursor` back, and stops when the
 * field is absent.
 *
 * `clampLimit(value, defaultValue, max)` is
 * `Math.min(Math.max(value ?? defaultValue, 1), max)` behind a
 * `Number.isFinite` guard. Two rules that look like one but aren't, and that the
 * tests below keep apart:
 *   - a NON-NUMERIC limit (`?limit=abc` -> `Number("abc")` -> NaN) fails the
 *     isFinite guard and falls back to the DEFAULT;
 *   - a numeric-but-nonsense limit (`?limit=0`, `?limit=-1`) passes the guard
 *     and clamps to the FLOOR, 1 — not to the default.
 * The isFinite guard is load-bearing rather than defensive: a NaN reaching
 * bun:sqlite as the `LIMIT ?` param throws a raw 'datatype mismatch' instead of
 * paginating.
 *
 * ── Why this spec exists ─────────────────────────────────────────────────────
 * A pager that silently repeats or skips rows still renders a perfectly
 * plausible list, so the failure mode is invisible to "did a table appear"
 * assertions. This repo shipped exactly that as a P0 in the admin UI: `load()`
 * in useCursorPagination.ts took `cursor: string | undefined = currentCursor`,
 * and a JS default parameter applies whenever the argument is `undefined` —
 * including when it is passed explicitly. `prev()` pops `undefined` off the
 * cursor stack to mean "back to the very first, cursor-less page", so Prev
 * re-loaded the CURRENT page instead of navigating back. The fix split
 * `fetchAndApply(cursor)` (no default) out of `load()`; the last test here drives
 * Next then Prev through the real SPA and asserts the rows come back identical
 * to page one, which is the only assertion that can tell the two apart.
 *
 * ── What is NOT covered here, and why ────────────────────────────────────────
 * GET /admin-api/traces is the fourth listing using this idiom, and the only
 * one left out. It is genuinely different rather than merely unseeded: it keys
 * on `HAVING MAX(id) < ?` over a GROUP BY, so a "row" is an aggregate of spans
 * and `nextCursor` is a group's maximum id rather than any column of the row it
 * came from. Its walk, its clamps (50/500) and its cursor are covered by
 * traces.spec.ts, against the span fixtures that file already owns — repeating
 * them here would mean duplicating that seeding to test a different query
 * shape through the same generic table.
 *
 * The three listings below all key on a plain column, which is what makes them
 * comparable enough to be worth driving from one table. They deliberately span
 * all three distinct clamp pairs in the codebase (50/200 twice, 100/1000 once)
 * and both key directions, so a change to `clampLimit` or `keysetPaginate`
 * cannot pass by only satisfying one shape.
 */
import { test, expect, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { APP_BASE_URL, FIXTURE_BASE_URL } from "./support/env";
import {
  adminAuthHeaders,
  apiHeaders,
  deleteClient,
  login,
  mintMcpKey,
  registerViaApi,
  type AdminAuth,
} from "./support/admin";
import { closeTrackedMcpSessions, initMcpSession, mcpToolsCall } from "./support/mcp";

// ── Fixture identities ───────────────────────────────────────────────────────

/**
 * Prefix for every client this spec registers. Also the SPA's `?q=` filter, so
 * the browser test paginates a set this spec fully owns instead of whatever
 * count the sibling specs happened to leave behind.
 */
const CLIENT_PREFIX = "e2e-page-c";

/**
 * 55 clients against a page size of 50 (ServersPage.vue's `buildQuery` hardcodes
 * `limit=50`) gives a full first page and a 5-row second page — two sizes, so
 * "did the pager actually move" is unambiguous from the row count alone.
 */
const SEEDED_CLIENTS = 55;

/** ServersPage.vue -> buildQuery(): `params.set("limit", "50")`. */
const SPA_PAGE_SIZE = 50;

/**
 * Bulk enable/disable passes (src/routes/admin/clients.ts's PATCH /clients
 * records one audit row per name it toggles). Four passes over 55 clients is
 * 220 audit rows from two-ish seconds of setup — enough for the audit log's own
 * `max` ceiling of 200 to be observable rather than asserted into thin air.
 */
const AUDIT_TOGGLE_PASSES = 4;
const SEEDED_AUDIT_ROWS = SEEDED_CLIENTS * AUDIT_TOGGLE_PASSES;

/**
 * A real, dispatchable client used only to fill `tool_traffic` — the 55 stubs
 * above are registered from a manual tool list and have no reachable upstream,
 * so they can seed audit rows but not traffic.
 */
const TRAFFIC_CLIENT = "e2e-page-traffic-api";
const TRAFFIC_TOOL = "list-users";

/**
 * One more than the traffic listing's default page size (100), which is the
 * floor two assertions need: `?limit=abc` must come back with a FULL default
 * page, and it must still advertise a nextCursor. Exactly 100 would make the
 * page terminal and quietly weaken both.
 */
const SEEDED_TRAFFIC_ROWS = 101;

function clientName(index: number): string {
  return `${CLIENT_PREFIX}${String(index).padStart(2, "0")}`;
}

const SEEDED_NAMES: readonly string[] = Array.from({ length: SEEDED_CLIENTS }, (_, i) => clientName(i + 1));

// ── Response narrowing (TS strict: no `any`, no non-null assertions) ──────────

interface PageBody {
  items: Record<string, unknown>[];
  nextCursor: string | undefined;
}

/** The `{ items, nextCursor? }` envelope every keyset-paginated listing returns. */
function pageOf(body: unknown): PageBody {
  const envelope = typeof body === "object" && body !== null ? (body as { items?: unknown; nextCursor?: unknown }) : {};
  const items = Array.isArray(envelope.items)
    ? envelope.items.filter((i): i is Record<string, unknown> => typeof i === "object" && i !== null)
    : [];
  return { items, nextCursor: typeof envelope.nextCursor === "string" ? envelope.nextCursor : undefined };
}

/** One row field as a string — cursors are stringified keys, so numeric ids count. */
function fieldAsString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  throw new Error(`row has no usable '${key}' (got ${typeof value})`);
}

// ── Local helpers (the shared-helpers boundary keeps these in this file) ──────

/**
 * Register a REST client from a hand-written one-tool list rather than the
 * OpenAPI fixture.
 *
 * `registerViaApi` would do here, but this spec needs 55 of them and the
 * OpenAPI branch fetches + parses the spec document per registration; the
 * `tools` array is the same `performRestRegistration` entry point with the
 * discovery round trip removed (src/mcp/registration.ts: an explicit `tools`
 * array is one of the four accepted discovery sources). Tolerates the 409 a
 * local re-run against a reused server produces.
 */
async function registerStubClient(request: APIRequestContext, auth: AdminAuth, name: string): Promise<void> {
  const res = await request.post(`${APP_BASE_URL}/register`, {
    headers: apiHeaders(auth),
    data: {
      name,
      health_url: `${FIXTURE_BASE_URL}/health`,
      base_url: FIXTURE_BASE_URL,
      tools: [
        {
          name: "ping",
          method: "GET",
          endpoint: "/health",
          description: "e2e pagination fixture tool",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    },
  });
  expect([200, 201, 409], `register(${name}) failed: ${res.status()} ${await res.text()}`).toContain(res.status());
}

/** One bulk enable/disable pass over every seeded client — 55 audit rows a call. */
async function bulkToggle(request: APIRequestContext, auth: AdminAuth, enabled: boolean): Promise<void> {
  const res = await request.patch(`${APP_BASE_URL}/admin-api/clients`, {
    headers: apiHeaders(auth),
    data: { names: SEEDED_NAMES, enabled },
  });
  expect(res.status(), `bulk toggle failed: ${await res.text()}`).toBe(200);
}

// ── The paginated-endpoint table ─────────────────────────────────────────────

interface PaginatedEndpoint {
  /** Test-name fragment. */
  label: string;
  /** Path under APP_BASE_URL, without a query string. */
  path: string;
  /**
   * Extra query params confining the listing to rows this spec seeded, so no
   * assertion below depends on what the sibling specs left in the database.
   * A function because the audit-log bound is only known at setup time.
   */
  narrow: () => string;
  /** Rows the narrowed listing is guaranteed to hold. A floor, never an exact count. */
  minRows: number;
  /** `defaultValue` at this call site's clampLimit — used when `limit` is absent or NaN. */
  defaultLimit: number;
  /** `max` at this call site's clampLimit. */
  maxLimit: number;
  /** Page size for the full walk — chosen so the walk terminates in a handful of requests. */
  walkPageSize: number;
  /** The keyset key of a row: exactly what `nextCursor` stringifies. */
  idOf: (row: Record<string, unknown>) => string;
  /** The documented relation between the keys of two consecutive rows. */
  inOrder: (earlier: string, later: string) => boolean;
  /** Human-readable form of `inOrder`, for assertion messages. */
  order: string;
  /** A cursor that is not a legal keyset key for this endpoint. */
  garbageCursor: string;
  /** What the source does with `garbageCursor` — read, not guessed. */
  garbageNote: string;
}

/** Set in beforeAll, immediately before the audit rows this spec mints. */
let seedStartMs = 0;

const PAGINATED: readonly PaginatedEndpoint[] = [
  {
    // src/mcp/registry-read-models.ts -> listClientsSummaryReadModel. Hand-rolled
    // rather than routed through keysetPaginate (its `status` post-filter needs
    // the sliced page), but arithmetically the same clamp and the same
    // "fetch limit+1, nextCursor = last returned key" rule.
    label: "clients",
    path: "/admin-api/clients",
    narrow: () => `q=${CLIENT_PREFIX}`,
    minRows: SEEDED_CLIENTS,
    defaultLimit: 50,
    maxLimit: 200,
    walkPageSize: 20,
    idOf: (row) => fieldAsString(row, "name"),
    // ORDER BY c.name, cursor replayed as `c.name > ?` — the one ASCENDING,
    // string-keyed listing among these.
    inOrder: (earlier, later) => earlier < later,
    order: "ascending by name",
    // `c.name > ?` uses the cursor verbatim as a name boundary, so a garbage
    // cursor is neither rejected nor ignored — it is honoured literally. '~'
    // (0x7E) sorts after every character a client name may legally start with
    // (/^[a-z0-9]/, max 'z' = 0x7A), so no row can follow it.
    garbageCursor: "~~not-a-cursor~~",
    garbageNote: "used verbatim as a `name > ?` boundary that sorts after every legal client name",
  },
  {
    // src/admin/audit/audit.ts -> listAuditLog, via keysetPaginate.
    label: "audit-log",
    path: "/admin-api/audit-log",
    narrow: () => `from=${seedStartMs}`,
    minRows: SEEDED_AUDIT_ROWS,
    defaultLimit: 50,
    maxLimit: 200,
    walkPageSize: 100,
    idOf: (row) => fieldAsString(row, "id"),
    // ORDER BY id DESC, cursor replayed as `id < ?` — newest first, so the walk
    // moves backwards and rows written mid-walk (higher ids) can never enter a
    // window we have already passed.
    inOrder: (earlier, later) => Number(earlier) > Number(later),
    order: "descending by id",
    // The cursor goes through `Number(...)` before binding, so a non-numeric one
    // becomes NaN — which binds fine and makes `id < ?` false for every row
    // (src/routes/__tests__/routes-audit-log-mutation.test.ts documents the same
    // coercion). Empty page, HTTP 200, no throw.
    garbageCursor: "not-a-cursor",
    garbageNote: "coerced by Number() to NaN, making the `id < ?` comparison false for every row",
  },
  {
    // src/observability/traffic.ts -> listTraffic, via keysetPaginate. The third
    // distinct clamp pair in the codebase (100/1000 rather than 50/200), which
    // is the reason it earns a row here rather than being assumed equivalent to
    // the audit log just because both key on a descending id.
    label: "traffic",
    path: "/admin-api/traffic",
    narrow: () => `client=${TRAFFIC_CLIENT}`,
    minRows: SEEDED_TRAFFIC_ROWS,
    defaultLimit: 100,
    maxLimit: 1000,
    walkPageSize: 40,
    idOf: (row) => fieldAsString(row, "id"),
    inOrder: (earlier, later) => Number(earlier) > Number(later),
    order: "descending by id",
    // Same Number() coercion as the audit log — asserted separately rather than
    // inferred from it, since they are different call sites.
    garbageCursor: "not-a-cursor",
    garbageNote: "coerced by Number() to NaN, making the `id < ?` comparison false for every row",
  },
];

/** GET a listing and assert it answered 200 before narrowing the envelope. */
async function getPage(
  request: APIRequestContext,
  auth: AdminAuth,
  endpoint: PaginatedEndpoint,
  query: string,
): Promise<PageBody> {
  const url = `${APP_BASE_URL}${endpoint.path}?${endpoint.narrow()}&${query}`;
  const res = await request.get(url, { headers: apiHeaders(auth) });
  expect(res.status(), `GET ${url}: ${await res.text()}`).toBe(200);
  return pageOf(await res.json());
}

test.describe("keyset pagination — the admin list API and the SPA pager", () => {
  let context: BrowserContext;
  let spaPage: Page;
  let request: APIRequestContext;
  let auth: AdminAuth;

  test.beforeAll(async ({ browser }) => {
    // 55 registrations plus four bulk passes over all of them — sized for
    // building a fixture, not for a single test.
    test.setTimeout(180_000);

    context = await browser.newContext();
    spaPage = await context.newPage();
    await login(spaPage);
    auth = await adminAuthHeaders(spaPage);
    request = context.request;

    for (const name of SEEDED_NAMES) {
      await registerStubClient(request, auth, name);
    }

    // Everything after this instant in the audit log is this spec's own doing,
    // which is what `?from=` narrows on below. Captured before the first toggle.
    seedStartMs = Date.now();
    for (let pass = 0; pass < AUDIT_TOGGLE_PASSES; pass++) {
      // Ends on `true` (even pass count), so the seeded clients are left enabled
      // for the SPA test and for a local re-run against the same database.
      await bulkToggle(request, auth, pass % 2 === 1);
    }

    // Traffic rows can only come from real dispatches, so this needs a client
    // with a reachable upstream and an MCP session — unlike the two listings
    // above, which are seeded purely through the admin API.
    await registerViaApi(request, auth, TRAFFIC_CLIENT);
    const { authHeader } = await mintMcpKey(request, auth, "e2e-page-traffic");
    const dataPlane = `/mcp/${TRAFFIC_CLIENT}`;
    const { sessionId } = await initMcpSession(dataPlane, { authHeader, clientName: "e2e-pagination" });
    for (let i = 0; i < SEEDED_TRAFFIC_ROWS; i++) {
      const call = await mcpToolsCall(dataPlane, sessionId, `${TRAFFIC_CLIENT}__${TRAFFIC_TOOL}`, authHeader);
      // Asserted, not fired and forgotten: a call that never reached dispatch
      // writes no traffic row, and the resulting "fewer rows than seeded"
      // failure three tests later would point nowhere near here.
      expect(call.isError, `traffic seed call ${i} failed: ${call.text}`).toBeFalsy();
    }
  });

  test.afterAll(async () => {
    test.setTimeout(180_000);
    for (const name of SEEDED_NAMES) {
      await deleteClient(request, auth, name);
    }
    await deleteClient(request, auth, TRAFFIC_CLIENT);
    // Hand the session slot back to the process-wide maxSessions budget — a
    // leak here subtracts from every later spec's headroom and surfaces as an
    // unrelated 503 nowhere near this file.
    await closeTrackedMcpSessions();
    await context.close();
  });

  // ── Sanity: the fixture is really there, so nothing below is vacuous ────────

  test("setup seeded the rows every assertion below depends on", async () => {
    for (const endpoint of PAGINATED) {
      // Asking for the endpoint's own ceiling reads the whole narrowed listing
      // in one request (or fills the ceiling, if the listing is bigger).
      const page = await getPage(request, auth, endpoint, `limit=${endpoint.maxLimit}`);
      expect(
        page.items.length,
        `${endpoint.label} holds only ${page.items.length} row(s) — fewer than the ${endpoint.minRows} this spec ` +
          "seeded, so every assertion below would be measuring an almost-empty table",
      ).toBeGreaterThanOrEqual(Math.min(endpoint.minRows, endpoint.maxLimit));
    }
  });

  // ── (1) Page 1 -> nextCursor -> page 2 ────────────────────────────────────

  for (const endpoint of PAGINATED) {
    test(`GET ${endpoint.label} — page 2 follows page 1 with no repeated and no skipped rows`, async () => {
      const size = 5;

      const first = await getPage(request, auth, endpoint, `limit=${size}`);
      expect(first.items, `${endpoint.label} page 1 was not full at limit=${size}`).toHaveLength(size);
      expect(
        first.nextCursor,
        `${endpoint.label} page 1 reported no nextCursor despite more rows existing`,
      ).toBeDefined();
      // The cursor is not opaque: it is the last returned row's own key. Pinning
      // that here is what makes the walk below a genuine keyset walk rather than
      // "some string round-tripped".
      expect(first.nextCursor, `${endpoint.label} nextCursor is not the last returned row's key`).toBe(
        endpoint.idOf(first.items[first.items.length - 1]),
      );

      const second = await getPage(request, auth, endpoint, `limit=${size}&cursor=${first.nextCursor ?? ""}`);
      expect(second.items, `${endpoint.label} page 2 was not full at limit=${size}`).toHaveLength(size);

      const firstIds = first.items.map(endpoint.idOf);
      const secondIds = second.items.map(endpoint.idOf);

      // THE bug class: a pager that re-serves rows it already served (or hops
      // over rows it never served) still renders a believable list.
      const repeated = secondIds.filter((id) => firstIds.includes(id));
      expect(repeated, `${endpoint.label} served the same rows on both pages: ${repeated.join(", ")}`).toEqual([]);

      // And the concatenation has to still be in the order the endpoint documents —
      // disjoint pages in the wrong order would skip rows just as silently.
      const walked = [...firstIds, ...secondIds];
      for (let i = 1; i < walked.length; i++) {
        expect(
          endpoint.inOrder(walked[i - 1], walked[i]),
          `${endpoint.label} is not ${endpoint.order} across the page boundary: ${walked[i - 1]} then ${walked[i]}`,
        ).toBe(true);
      }
    });
  }

  // ── (2) The limit is clamped, not trusted ─────────────────────────────────

  for (const endpoint of PAGINATED) {
    test(`GET ${endpoint.label} — an absurd ?limit is clamped to the documented max (${endpoint.maxLimit})`, async () => {
      const page = await getPage(request, auth, endpoint, "limit=99999999");
      expect(
        page.items.length,
        `${endpoint.label} served ${page.items.length} rows for ?limit=99999999 — the ${endpoint.maxLimit} ceiling is not applied`,
      ).toBeLessThanOrEqual(endpoint.maxLimit);

      if (endpoint.minRows > endpoint.maxLimit) {
        // Only the audit log clears its own ceiling here (220 seeded rows vs a
        // max of 200), so only there can "at most max" be told apart from "there
        // simply weren't that many rows".
        expect(page.items, `${endpoint.label} did not fill its ${endpoint.maxLimit}-row ceiling`).toHaveLength(
          endpoint.maxLimit,
        );
        expect(
          page.nextCursor,
          `${endpoint.label} truncated at the ceiling without saying more rows remain`,
        ).toBeDefined();
      }
    });

    test(`GET ${endpoint.label} — a non-numeric ?limit falls back to the default (${endpoint.defaultLimit})`, async () => {
      // Number("abc") is NaN, which `clampLimit`'s Number.isFinite guard turns
      // into the default. Without that guard the NaN reaches bun:sqlite as the
      // `LIMIT ?` param and the request dies on a datatype mismatch, so a 200
      // with exactly `defaultLimit` rows is the whole assertion.
      const page = await getPage(request, auth, endpoint, "limit=abc");
      expect(page.items, `${endpoint.label} ignored the default page size for a non-numeric ?limit`).toHaveLength(
        endpoint.defaultLimit,
      );
      expect(
        page.nextCursor,
        `${endpoint.label} returned an unbounded/terminal page for a non-numeric ?limit`,
      ).toBeDefined();
    });

    test(`GET ${endpoint.label} — ?limit=0 and ?limit=-1 clamp to the floor of 1, not to the default`, async () => {
      // Worth keeping distinct from the case above: 0 and -1 ARE finite, so they
      // never reach the `?? defaultValue` fallback — Math.max(n, 1) catches them
      // and the page is one row long. A pager that answered `defaultLimit` here
      // would mean the isFinite guard had swallowed a legitimate number.
      for (const limit of ["0", "-1"]) {
        const page = await getPage(request, auth, endpoint, `limit=${limit}`);
        expect(page.items, `${endpoint.label} did not clamp ?limit=${limit} to a single row`).toHaveLength(1);
        expect(page.nextCursor, `${endpoint.label} reported no more rows after a 1-row page`).toBeDefined();
      }
    });
  }

  // ── (3) The last page terminates ──────────────────────────────────────────

  for (const endpoint of PAGINATED) {
    test(`GET ${endpoint.label} — walking to the end drops nextCursor, and no row is served twice`, async () => {
      const size = endpoint.walkPageSize;
      // Bounded so a broken terminator (an endless nextCursor) fails the test
      // instead of hanging the run — the exact failure mode mcp-discovery.ts
      // guards its own upstream paging against.
      const maxRequests = 25;

      const seen: string[] = [];
      let cursor: string | undefined;
      let requests = 0;
      let terminated = false;

      while (requests < maxRequests) {
        requests++;
        const query = cursor === undefined ? `limit=${size}` : `limit=${size}&cursor=${cursor}`;
        const page = await getPage(request, auth, endpoint, query);
        seen.push(...page.items.map(endpoint.idOf));

        if (page.nextCursor === undefined) {
          terminated = true;
          break;
        }
        // Every page that claims more rows follow must itself be full — a short
        // page WITH a nextCursor means rows were dropped between the slice and
        // the cursor.
        expect(page.items, `${endpoint.label} served a short page while still advertising more rows`).toHaveLength(
          size,
        );
        expect(page.nextCursor, `${endpoint.label} nextCursor is not the last returned row's key`).toBe(
          endpoint.idOf(page.items[page.items.length - 1]),
        );
        cursor = page.nextCursor;
      }

      expect(
        terminated,
        `${endpoint.label} never dropped nextCursor within ${maxRequests} pages — a client has no way to stop`,
      ).toBe(true);
      expect(requests, `${endpoint.label} terminated on the first page, so the walk proved nothing`).toBeGreaterThan(1);
      expect(seen.length, `${endpoint.label} walk returned fewer rows than this spec seeded`).toBeGreaterThanOrEqual(
        endpoint.minRows,
      );
      expect(
        new Set(seen).size,
        `${endpoint.label} served ${seen.length - new Set(seen).size} duplicate row(s) across the full walk`,
      ).toBe(seen.length);
      for (let i = 1; i < seen.length; i++) {
        expect(
          endpoint.inOrder(seen[i - 1], seen[i]),
          `${endpoint.label} walk is not ${endpoint.order}: ${seen[i - 1]} then ${seen[i]}`,
        ).toBe(true);
      }
    });
  }

  // ── (4) A garbage cursor is handled, not fatal ────────────────────────────

  for (const endpoint of PAGINATED) {
    test(`GET ${endpoint.label} — a garbage ?cursor is ${endpoint.garbageNote}`, async () => {
      // Positive control first: the same request without the cursor really does
      // return rows, so the empty page below is the cursor's doing.
      const control = await getPage(request, auth, endpoint, `limit=${endpoint.walkPageSize}`);
      expect(control.items.length, `${endpoint.label} is empty even without a cursor`).toBeGreaterThan(0);

      const page = await getPage(
        request,
        auth,
        endpoint,
        `limit=${endpoint.walkPageSize}&cursor=${encodeURIComponent(endpoint.garbageCursor)}`,
      );
      // Neither a 500 (getPage already asserted 200) nor a rejection: both call
      // sites resolve a malformed cursor into a comparison that simply matches
      // nothing, so the caller gets a well-formed, empty, terminal page.
      expect(page.items, `${endpoint.label} returned rows for a cursor that can match none`).toEqual([]);
      expect(page.nextCursor, `${endpoint.label} offered to page on from an empty result`).toBeUndefined();
    });
  }

  // ── (5) The P0: the SPA's Next/Prev round trip ────────────────────────────

  test("the admin UI's Next then Prev returns to the exact same first page", async () => {
    // `?q=` is seeded into ServersPage's filter refs by useQueryFilters at setup
    // (one-way, from route.query), so this drives the pager over the 55 clients
    // this spec owns rather than over whatever the sibling specs left behind.
    await spaPage.goto(`/admin/servers?q=${CLIENT_PREFIX}`);

    const rows = spaPage.locator(".data-table tbody tr");
    const rowLinks = spaPage.locator(".data-table tbody tr td:nth-child(2) a");
    const pager = spaPage.locator(".pagination-bar");
    const nextButton = pager.getByRole("button", { name: "Next", exact: true });
    const prevButton = pager.getByRole("button", { name: "Previous", exact: true });

    const namesOnPage = async (): Promise<string[]> => (await rowLinks.allInnerTexts()).map((n) => n.trim());

    // Page 1: full at the SPA's hardcoded limit=50, with nowhere back to go.
    await expect(rows).toHaveCount(SPA_PAGE_SIZE, { timeout: 15_000 });
    await expect(prevButton).toBeDisabled();
    await expect(nextButton).toBeEnabled();
    const firstPage = await namesOnPage();
    expect(firstPage).toEqual(SEEDED_NAMES.slice(0, SPA_PAGE_SIZE));

    // Next: the remaining 5. A different row count as well as different rows, so
    // the waits below can't settle on a stale render.
    await nextButton.click();
    await expect(rows).toHaveCount(SEEDED_CLIENTS - SPA_PAGE_SIZE);
    const secondPage = await namesOnPage();
    expect(secondPage).toEqual(SEEDED_NAMES.slice(SPA_PAGE_SIZE));
    expect(
      secondPage.filter((name) => firstPage.includes(name)),
      "the SPA's second page repeats rows from the first",
    ).toEqual([]);
    await expect(prevButton).toBeEnabled();
    await expect(spaPage).toHaveURL(/cursor=/);

    // Prev: pops `undefined` off the cursor stack, meaning "back to the very
    // first, cursor-less page". The shipped P0 applied `load`'s default
    // parameter to that explicit `undefined` and re-fetched page TWO — which
    // still renders a list, so only comparing the rows catches it.
    await prevButton.click();
    await expect(rows).toHaveCount(SPA_PAGE_SIZE);
    expect(await namesOnPage(), "Prev did not return to page one — it re-rendered the page it was already on").toEqual(
      firstPage,
    );
    // Two independent witnesses to the same navigation: the pager is back at the
    // start of the stack, and the URL no longer carries a cursor.
    await expect(prevButton).toBeDisabled();
    await expect(nextButton).toBeEnabled();
    await expect(spaPage).not.toHaveURL(/cursor=/);
  });
});
