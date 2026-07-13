#!/usr/bin/env bun
/**
 * Extracts every HTTP route registration from `src/routes/` and writes them to
 * admin-ui/src/demo/__tests__/real-routes.generated.json.
 *
 * That JSON is the "real backend" side of two source-of-truth checks:
 *   - admin-ui's demo-vs-real contract test
 *     (admin-ui/src/demo/__tests__/demo-contract.test.ts), which can't import
 *     backend src/ at runtime (it's a Bun-only Express app, and that suite runs
 *     under Vitest/jsdom); and
 *   - the backend OpenAPI route-parity test
 *     (src/__tests__/openapi-route-parity.test.ts), which asserts every real
 *     route is documented in src/openapi.yaml.
 *
 * The manifest is also guarded against silent rot by the "manifest is fresh"
 * case in src/__tests__/openapi-route-parity.test.ts, which re-runs this
 * extractor in --check mode and fails if the committed JSON is stale. So the
 * workflow is: after adding, removing, or renaming a route, regenerate and
 * commit the JSON —
 *
 *   bun scripts/extract-routes.ts
 *
 * — or CI's freshness test goes red.
 *
 * ── Two registration conventions, both matched ──────────────────────────────
 * Deliberately simple regex extraction rather than a full TS/AST parse, because
 * every route in this codebase follows one of exactly two shapes:
 *
 *   1. Top-level files (src/routes/*.ts) register directly on the app:
 *        `app.<method>("/path", …)`  →  path taken verbatim.
 *
 *   2. Per-entity admin sub-routers (src/routes/admin/*.ts) register on a
 *      `<name>Routes` Express Router that src/routes/admin/index.ts mounts, as
 *      one group, under `/admin-api`:
 *        `clientsRoutes.<method>("/clients/:name", …)`
 *        →  path prefixed with `/admin-api` (so `/admin-api/clients/:name`),
 *           attributed to file "admin.ts" (the mount entry point).
 *      Matching the `\w+Routes.` receiver (not a bare `\w+.`) is what keeps
 *      query-string reads like `searchParams.get(...)` / `headers.get(...)` and
 *      docstring examples (`r.get("/overview", …)`) out of the manifest.
 *
 * Runtime introspection of the Express 5 router stack was considered and
 * rejected: path-to-regexp v8 no longer exposes a mounted sub-router's prefix
 * as a readable string (`layer.path`/`layer.regexp` are `undefined`), so the
 * `/admin-api` prefix can't be recovered that way — the static rule above can.
 * If either convention ever changes, the freshness test makes the mismatch
 * loud rather than silent.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const ROUTES_DIR = join(ROOT, "src", "routes");
const ADMIN_ROUTES_DIR = join(ROUTES_DIR, "admin");
export const MANIFEST_PATH = join(ROOT, "admin-ui", "src", "demo", "__tests__", "real-routes.generated.json");

/** The `/admin-api` mount prefix that src/routes/admin/index.ts applies to
 * every per-entity sub-router (`app.use("/admin-api", r)`). */
const ADMIN_MOUNT_PREFIX = "/admin-api";

export type Method = "get" | "post" | "put" | "patch" | "delete";
export interface RouteEntry {
  method: Method;
  path: string;
  file: string;
}

// `app.get(` / `app.post(` / … followed (possibly across formatter line-wraps)
// by the path string literal as the first argument. Deliberately does NOT match
// `app.use(` — mount-only prefixes aren't route registrations we contract-check.
const APP_ROUTE_RE = /app\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;

// `<name>Routes.get(` / `.post(` / … — the admin sub-router registration shape.
// The `Routes`-suffixed receiver is the discriminator that excludes non-route
// `.get()`/`.post()` calls (Map/Headers/URLSearchParams) in the same files.
const ADMIN_ROUTE_RE = /(\w+Routes)\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;

function readTs(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".ts"));
}

function extractTopLevel(): RouteEntry[] {
  const entries: RouteEntry[] = [];
  for (const file of readTs(ROUTES_DIR)) {
    const src = readFileSync(join(ROUTES_DIR, file), "utf8");
    for (const m of src.matchAll(APP_ROUTE_RE)) {
      entries.push({ method: m[1] as Method, path: m[2], file });
    }
  }
  return entries;
}

function extractAdmin(): RouteEntry[] {
  const entries: RouteEntry[] = [];
  for (const file of readTs(ADMIN_ROUTES_DIR)) {
    const src = readFileSync(join(ADMIN_ROUTES_DIR, file), "utf8");
    for (const m of src.matchAll(ADMIN_ROUTE_RE)) {
      // m[1] = receiver (e.g. "clientsRoutes"), m[2] = method, m[3] = path.
      entries.push({ method: m[2] as Method, path: `${ADMIN_MOUNT_PREFIX}${m[3]}`, file: "admin.ts" });
    }
  }
  return entries;
}

/** The full, sorted route manifest. Shared by the generator (below) and the
 * freshness/parity tests, so all three agree by construction. */
export function extractRoutes(): RouteEntry[] {
  return [...extractTopLevel(), ...extractAdmin()].sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );
}

/** Serialized manifest, exactly as written to disk (2-space JSON + trailing
 * newline). Single source of the on-disk format, shared by write and --check. */
export function serializeManifest(routes: RouteEntry[]): string {
  return `${JSON.stringify(routes, null, 2)}\n`;
}

if (import.meta.main) {
  const routes = extractRoutes();
  const serialized = serializeManifest(routes);

  // `--check`: regenerate in memory and fail (non-zero) if the committed
  // manifest is stale, instead of overwriting it. Used by the freshness gate
  // in src/__tests__/openapi-route-parity.test.ts so a forgotten
  // `bun scripts/extract-routes.ts` is a loud CI failure, not a silently-blind
  // contract/parity test.
  if (process.argv.includes("--check")) {
    const committed = readFileSync(MANIFEST_PATH, "utf8");
    if (committed !== serialized) {
      const key = (r: RouteEntry) => `${r.method.toUpperCase()} ${r.path}`;
      const committedRoutes = JSON.parse(committed) as RouteEntry[];
      const freshKeys = new Set(routes.map(key));
      const committedKeys = new Set(committedRoutes.map(key));
      const added = routes.filter((r) => !committedKeys.has(key(r))).map(key);
      const removed = committedRoutes.filter((r) => !freshKeys.has(key(r))).map(key);
      console.error("real-routes.generated.json is STALE. Run: bun scripts/extract-routes.ts");
      if (added.length)
        console.error(
          `  + ${added.length} route(s) in code but not the manifest:\n${added.map((r) => `      ${r}`).join("\n")}`,
        );
      if (removed.length)
        console.error(
          `  - ${removed.length} route(s) in the manifest but not the code:\n${removed.map((r) => `      ${r}`).join("\n")}`,
        );
      process.exit(1);
    }
    console.log(`real-routes.generated.json is fresh (${routes.length} routes).`);
  } else {
    writeFileSync(MANIFEST_PATH, serialized, "utf8");
    console.log(`Wrote ${routes.length} routes from src/routes/ to ${MANIFEST_PATH}`);
  }
}
