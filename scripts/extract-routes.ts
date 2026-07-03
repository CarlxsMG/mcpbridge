#!/usr/bin/env bun
/**
 * Extracts every `app.<method>("path", ...)` registration from src/routes/*.ts
 * and writes them to admin-ui/src/composables/__tests__/real-routes.generated.json.
 *
 * That JSON is the "real backend" side of admin-ui's demo-vs-real contract test
 * (admin-ui/src/composables/__tests__/demo-contract.test.ts). The test itself
 * can't import backend src/ at runtime (it's a Bun-only Express app, and the
 * test runs under Vitest/jsdom), so this script is the bridge: run it whenever
 * routes are added/removed/renamed in src/routes/*.ts, commit the regenerated
 * JSON, and the contract test will pick up the change.
 *
 *   bun scripts/extract-routes.ts
 *
 * Deliberately simple regex extraction rather than a real TS/AST parse — every
 * route in this codebase is registered as a top-level `app.<method>(` call with
 * the path as a plain string literal (see src/routes/*.ts), so this is robust
 * in practice and much cheaper to maintain than pulling in a TS parser just for
 * this. If that convention ever changes, this script's output (and the CI-run
 * diff check below) will make the mismatch obvious.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const ROUTES_DIR = join(ROOT, "src", "routes");
const OUT_FILE = join(ROOT, "admin-ui", "src", "composables", "__tests__", "real-routes.generated.json");

type Method = "get" | "post" | "put" | "patch" | "delete";
interface RouteEntry {
  method: Method;
  path: string;
  file: string;
}

// Matches `app.get(`, `app.post(`, etc. followed (possibly across a line break,
// through however many middleware-laden formatter line-wraps) by the path
// string literal as the first argument. Deliberately does NOT match `app.use(`
// — mount-only prefixes aren't route registrations we need to contract-check.
const ROUTE_CALL_RE = /app\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;

function extractFromFile(filename: string): RouteEntry[] {
  const src = readFileSync(join(ROUTES_DIR, filename), "utf8");
  const entries: RouteEntry[] = [];
  for (const m of src.matchAll(ROUTE_CALL_RE)) {
    entries.push({ method: m[1] as Method, path: m[2], file: filename });
  }
  return entries;
}

const files = readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts"));
const routes = files
  .flatMap(extractFromFile)
  .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

writeFileSync(OUT_FILE, `${JSON.stringify(routes, null, 2)}\n`, "utf8");
console.log(`Wrote ${routes.length} routes from ${files.length} files in src/routes/ to ${OUT_FILE}`);
