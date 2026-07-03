// ─────────────────────────────────────────────────────────────────────────────
// Demo-vs-real contract test: flags ROUTE COVERAGE drift between demo.ts (the
// in-browser mock backend, see ../demo.ts) and the real Express admin API
// (src/routes/*.ts). Shared TypeScript types (src/types/api.ts) already keep
// response *shapes* honest at compile time — this test is the missing half:
// it catches a real route existing with no demo mock at all, which types
// can't see (demo.ts just never gets a branch for it, and TypeScript has no
// way to know a switch/if-chain "should" have one more case).
//
// ── How the two sides are gathered ──────────────────────────────────────────
// Real routes:  admin-ui can't import src/routes/*.ts at runtime (it's a
//   Bun-only Express app; this suite runs under Vitest/jsdom). Instead,
//   scripts/extract-routes.ts (repo root) greps every `app.<method>("path", …)`
//   call out of src/routes/*.ts and writes the flat list to
//   real-routes.generated.json, committed alongside this test.
//
//   ⚠️  REGENERATE THE MANIFEST WHEN BACKEND ROUTES CHANGE:
//       bun scripts/extract-routes.ts
//   (run from the repo root). Do this after adding, removing, or renaming an
//   admin-api route in src/routes/*.ts, then commit the updated
//   real-routes.generated.json. This test does not regenerate it for you —
//   a stale manifest just makes this test blind to the newest routes, it
//   won't error.
//
// Demo routes: demo.ts's `route()` is an imperative if-chain (string equality
//   plus regex .test()/.match() against `p`), not a literal data table — so
//   there is no structure to import and inspect directly. This test instead
//   statically scans demo.ts's source text for the two shapes that function
//   is built from (`p === "/exact/path"` and `/^\/regex\/pattern$/`) and
//   turns each into a matcher. This is intentionally simple regex-scraping,
//   not a real JS/TS parse — see extractDemoPatterns() below for exactly what
//   it recognizes, and its limits.
//
// ── Scope: path-level, not method-level ─────────────────────────────────────
// A real route is considered "covered" if ANY demo pattern matches its path,
// regardless of which HTTP method(s) that demo branch actually handles. This
// is a deliberate simplification: demo.ts binds methods to paths in a mix of
// styles (`p === "x" && method === "GET"` inline, but also
// `if (xMatch) { if (method === "GET") …; if (method === "PATCH") … }` in
// nested blocks for resource-detail routes), and reconstructing precise
// (path, method) pairs from that statically would need a much heavier parse
// for comparatively little extra safety. The failure mode this test exists to
// catch — a whole resource the demo never learned to fake — is still caught
// at the path level; it just won't distinguish "GET works, POST 404s" from
// "totally unmocked". Known consequence: POST /admin-api/backup and the
// bulk PATCH /admin-api/clients (DashboardPage.vue's multi-select
// enable/disable) both resolve to a path demo.ts has *some* handler for, but
// neither gets bespoke mock behavior — they fall through to the generic
// `{ ok: true }` / `{ items: [] }` default. That's a real, known gap in mock
// *fidelity* that this path-level check cannot see; call it out by hand if it
// ever matters enough to fix.
import { describe, expect, it } from "vitest";
// Vite's `?raw` suffix imports the file's source as a plain string — used
// here (rather than node:fs + import.meta.url) because Vitest doesn't run
// this file's import.meta.url as a real file:// URL, and `?raw` is the
// idiomatic Vite way to pull in source text anyway.
import demoSrc from "../demo.ts?raw";
import realRoutes from "./real-routes.generated.json";

interface RealRoute {
  method: string;
  path: string;
  file: string;
}

type DemoPattern = { kind: "exact"; value: string } | { kind: "regex"; value: string; re: RegExp };

/**
 * Scrapes demo.ts's route() for the two path-matching shapes it's built
 * from:
 *   1. `p === "/exact/literal/path"` — exact string comparisons.
 *   2. `/^\/regex\/pattern$/` — regex literals, always written `^`-anchored
 *      against the leading slash in this file (that's how every routing
 *      regex in demo.ts starts — verified by eye against ../demo.ts; the
 *      one non-routing regex literal in the file, `p.replace(/\/+$/, "")`,
 *      does NOT start with `^` and is correctly skipped by this scan).
 *
 * The regex-literal scanner is bracket/escape-aware (tracks `[...]` character
 * classes and `\`-escapes) so it doesn't get fooled by patterns like
 * `[^/]+`, which contain an unescaped `/` that is NOT the end of the literal.
 */
function extractDemoPatterns(src: string): DemoPattern[] {
  const patterns: DemoPattern[] = [];

  for (const m of src.matchAll(/p === "([^"]+)"/g)) {
    patterns.push({ kind: "exact", value: m[1] });
  }

  let i = 0;
  while (true) {
    const start = src.indexOf("/^", i);
    if (start === -1) break;
    const bodyStart = start + 1; // keep the leading '^'
    let inClass = false;
    let k = bodyStart;
    for (; k < src.length; k++) {
      const c = src[k];
      if (c === "\\") {
        k++; // skip the escaped character, whatever it is
        continue;
      }
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) break; // unescaped, outside a class: end of literal
    }
    const body = src.slice(bodyStart, k);
    patterns.push({ kind: "regex", value: body, re: new RegExp(body) });
    i = k + 1;
  }

  return patterns;
}

const demoPatterns = extractDemoPatterns(demoSrc);

/** Turns an Express path ("/admin-api/clients/:name") into a concrete sample
 * path demo patterns can be tested against. ":id" segments become a digit
 * string so `\d+`-anchored demo patterns (mcp-keys revoke, traffic replay,
 * approvals decide, …) match correctly; every other param becomes an opaque
 * non-slash token, which satisfies both exact-segment and `[^/]+` demo
 * patterns. */
function concretize(expressPath: string): string {
  return expressPath
    .split("/")
    .map((seg) => {
      if (!seg.startsWith(":")) return seg;
      return seg.slice(1) === "id" ? "42" : "sampleseg";
    })
    .join("/");
}

function demoHandles(expressPath: string): boolean {
  const concrete = concretize(expressPath);
  return demoPatterns.some((p) => (p.kind === "exact" ? p.value === concrete : p.re.test(concrete)));
}

/**
 * Real routes the demo deliberately does NOT need to fake, with the reason
 * why. Each entry is `${METHOD} ${path}` exactly as it appears in
 * real-routes.generated.json. Verified by grepping admin-ui/src for callers
 * (`Grep "admin-api/backup|register/schema|/metrics|api\\.\\w+\\("`) — none
 * of these paths are referenced anywhere in the admin-ui frontend, so demo.ts
 * has nothing to stand in for.
 */
const EXCLUDED_ROUTES = new Set<string>([
  // introspection.ts's /clients* is a legacy, non-"/admin-api"-prefixed
  // read/unregister API that predates the admin-api namespace. admin-ui only
  // ever calls the /admin-api/clients equivalents; nothing in admin-ui/src
  // references bare "/clients".
  "GET /clients",
  "DELETE /clients/:name",
  "GET /clients/:name/tools",
  // Prometheus text-exposition-format scrape endpoints, not JSON, not
  // fetched by any admin-ui page.
  "GET /metrics",
  "GET /metrics/legacy",
  // Ops/CLI-triggered backup export; no admin-ui page or composable calls it.
  "POST /admin-api/backup",
  // Legacy discovery-schema endpoint, superseded by
  // /admin-api/discovery/preview(-graphql); not called by admin-ui.
  "GET /register/schema",
  // Public, unauthenticated "install this bundle" landing endpoint
  // (src/routes/install-links.ts). ShareInstallLinkDialog.vue only ever
  // builds this URL as a string (`${base}/install/${token}`) to display/copy
  // for an external recipient to open directly against a *real* deployed
  // gateway — the admin-ui SPA itself never fetches it, so the demo (a
  // static SPA with no real backend behind it) has nothing to stand in for.
  "GET /install/:token",
  // OIDC SSO (src/routes/auth-oidc.ts): LoginPage.vue only ever builds these
  // as a plain `href`/full-page redirect target for a *real* deployed gateway
  // + IdP round trip — never fetched via api.*(), and a static demo SPA has
  // no backend to redirect through or IdP to fake a callback from. GET
  // /admin-api/auth/oidc/config and .../settings ARE fetched by the demo and
  // have real mocks above.
  "GET /admin-api/auth/oidc/start",
  "GET /admin-api/auth/oidc/callback",
]);

describe("demo.ts vs real backend route coverage", () => {
  const routes = realRoutes as RealRoute[];

  it("loaded a non-trivial real-routes manifest", () => {
    // Sanity check against a manifest that regenerated empty/truncated
    // (e.g. scripts/extract-routes.ts run from the wrong cwd).
    expect(routes.length).toBeGreaterThan(50);
  });

  it("has a demo mock for every real admin-api route the UI can call", () => {
    const missing = routes
      .filter((r) => !EXCLUDED_ROUTES.has(`${r.method.toUpperCase()} ${r.path}`))
      .filter((r) => !demoHandles(r.path));

    if (missing.length > 0) {
      const list = missing.map((r) => `  - ${r.method.toUpperCase()} ${r.path}  (src/routes/${r.file})`).join("\n");
      // AccountPage.vue's password-change and session-management calls (the
      // original known-red gap this test was written against) now have
      // demo.ts mocks. Left failing (not warn-only) so any *future* drift —
      // a new admin-api route the demo never learned to fake — is a loud
      // regression signal. Not wired into scripts/check-all.ts or
      // .github/workflows/ci.yml (neither currently runs admin-ui's vitest
      // suite at all), so a red run here does not block the aggregate CI
      // gate — it only surfaces on `bun run test` in admin-ui/.
      expect.fail(`${missing.length} real admin-api route(s) have no demo.ts mock:\n${list}`);
    }
  });
});
