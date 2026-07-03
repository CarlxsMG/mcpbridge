/**
 * Playwright globalSetup: starts a tiny, dependency-free HTTP server (Node's
 * built-in `http` module — deliberately not `Bun.serve`, since this file may
 * be executed by either runtime depending on how `playwright test` was
 * invoked) that serves:
 *   - GET /health        -> 200 (backend health-check target)
 *   - GET /openapi.json  -> the repo's existing tests/fixtures/simple-openapi.json,
 *                           unchanged, so discovery exercises the same fixture
 *                           the backend unit tests already use
 *   - GET /api/v1/users  -> a canned 200 response for the "list-users" tool
 *     discovered from that spec (its server url is the relative "/api/v1")
 *
 * The bridge backend (started separately by webServer) reaches this over
 * plain loopback HTTP during OpenAPI discovery/registration and at tool-call
 * time — ALLOW_PRIVATE_IPS=true (set in playwright.config.ts's webServer.env)
 * is what lets the backend's SSRF guard accept a loopback target at all.
 *
 * Returning an async function from globalSetup makes Playwright treat it as
 * the globalTeardown — it runs in the same process/closure, so the `Server`
 * handle never needs to leave this module.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FIXTURE_PORT } from "./env";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OPENAPI_SPEC = readFileSync(join(__dirname, "../tests/fixtures/simple-openapi.json"), "utf-8");

export default async function globalSetup(): Promise<() => Promise<void>> {
  const server = createServer((req, res) => {
    const url = req.url ?? "";

    if (url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }

    if (url === "/openapi.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(OPENAPI_SPEC);
      return;
    }

    if (url.startsWith("/api/v1/users") && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          users: [
            { id: 1, name: "Ada Lovelace" },
            { id: 2, name: "Grace Hopper" },
          ],
        }),
      );
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(FIXTURE_PORT, "127.0.0.1", () => resolve());
  });

  return async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}
