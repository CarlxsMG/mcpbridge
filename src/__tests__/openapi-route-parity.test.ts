// ─────────────────────────────────────────────────────────────────────────────
// OpenAPI ↔ route parity gate. Catches spec drift in BOTH directions:
//   1. a real route in src/routes/ with no operation in src/openapi.yaml
//      (an undocumented endpoint — the failure mode that let DELETE
//      /admin-api/clients/{name}, the whole OIDC login surface, and the bundle
//      install-link endpoints ship undocumented for several releases);
//   2. an operation documented in src/openapi.yaml with no real route behind it
//      (a phantom endpoint — the repo has had at least one).
//
// Companion to admin-ui's demo-vs-real contract test: both consume the same
// committed route manifest (admin-ui/src/demo/__tests__/real-routes.generated.json,
// produced by scripts/extract-routes.ts). The first test below re-runs the
// extractor in --check mode so a stale manifest is a loud failure here rather
// than a silently-blind check in either consumer.
//
// The manifest covers the REST surface registered in src/routes/**. It does NOT
// cover the MCP transport plane (/mcp, /mcp/:clientName, /mcp-custom/:bundleName),
// which src/mcp/transports.ts wires up directly on the app — those operations
// ARE documented in openapi.yaml and are allow-listed below so the phantom check
// doesn't flag them.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const ROOT = join(import.meta.dir, "..", "..");
const OPENAPI_PATH = join(ROOT, "src", "openapi.yaml");
const MANIFEST_PATH = join(ROOT, "admin-ui", "src", "demo", "__tests__", "real-routes.generated.json");
const EXTRACTOR_PATH = join(ROOT, "scripts", "extract-routes.ts");

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

interface RealRoute {
  method: string;
  path: string;
  file: string;
}

/** Express `:param` → OpenAPI `{param}`, so the two path styles compare equal. */
function toOpenApiPath(expressPath: string): string {
  return expressPath
    .split("/")
    .map((seg) => (seg.startsWith(":") ? `{${seg.slice(1)}}` : seg))
    .join("/");
}

function opKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

/** MCP transport-plane operations: real, documented, but registered in
 * src/mcp/transports.ts (not src/routes/), so absent from the route manifest.
 * Allow-listed for the phantom-endpoint check only. */
const MCP_TRANSPORT_OPS = new Set<string>([
  "GET /mcp",
  "POST /mcp",
  "DELETE /mcp",
  "GET /mcp/{clientName}",
  "POST /mcp/{clientName}",
  "DELETE /mcp/{clientName}",
  "GET /mcp-custom/{bundleName}",
  "POST /mcp-custom/{bundleName}",
  "DELETE /mcp-custom/{bundleName}",
]);

function loadSpecOps(): Set<string> {
  const doc = parse(readFileSync(OPENAPI_PATH, "utf8")) as {
    paths?: Record<string, Record<string, unknown>>;
  };
  const ops = new Set<string>();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      if (item[method]) ops.add(opKey(method, path));
    }
  }
  return ops;
}

function loadRealOps(): Set<string> {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as RealRoute[];
  return new Set(manifest.map((r) => opKey(r.method, toOpenApiPath(r.path))));
}

describe("OpenAPI ↔ route parity", () => {
  test("the committed route manifest is fresh", () => {
    const result = Bun.spawnSync(["bun", EXTRACTOR_PATH, "--check"], { cwd: ROOT });
    const stderr = result.stderr.toString();
    expect(stderr === "" ? result.exitCode : `${result.exitCode}\n${stderr}`).toBe(0);
  });

  test("every real route is documented in openapi.yaml", () => {
    const specOps = loadSpecOps();
    const undocumented = [...loadRealOps()].filter((op) => !specOps.has(op)).sort();
    expect(
      undocumented,
      `Undocumented real routes (add them to src/openapi.yaml):\n${undocumented.join("\n")}`,
    ).toEqual([]);
  });

  test("every documented operation maps to a real route (no phantom endpoints)", () => {
    const realOps = loadRealOps();
    const phantom = [...loadSpecOps()].filter((op) => !realOps.has(op) && !MCP_TRANSPORT_OPS.has(op)).sort();
    expect(
      phantom,
      `Documented operations with no route behind them (remove from src/openapi.yaml or fix the path):\n${phantom.join("\n")}`,
    ).toEqual([]);
  });
});
