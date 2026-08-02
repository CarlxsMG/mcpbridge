/**
 * The fake upstream the bridge proxies to during e2e.
 *
 * Extracted out of global-setup.ts once more than one spec needed to influence
 * its behaviour. Still Node's built-in `http` (not `Bun.serve`) because this
 * module is loaded by globalSetup, which runs under whichever runtime invoked
 * `playwright test`.
 *
 * Endpoints:
 *   GET  /health                 -> 200, always. Deliberately independent of the
 *                                   "down" flag below: the bridge's health loop
 *                                   evicts unhealthy clients, which would remove
 *                                   a client out from under the breaker spec
 *                                   before its breaker could trip.
 *   GET  /openapi.json           -> fixtures/simple-openapi.json, unchanged
 *   GET  /openapi-extended.json  -> the e2e-only superset (openapi-extended.ts)
 *   POST /graphql                -> introspection + resolved data (graphql-fixture.ts)
 *   GET  /api/v1/users           -> canned users
 *   GET  /api/v1/secret          -> credential-shaped strings, for the sanitizer
 *   GET  /api/v1/flaky           -> 200, or 500 while marked down
 *   GET  /api/v1/slow            -> responds after ?ms (capped)
 *   GET  /api/v1/echo            -> reflects the headers/query the bridge sent
 *   POST /__control/down|up      -> toggles the flaky endpoint
 *   GET  /__control/state        -> current flag + per-endpoint hit counts
 *
 * POST /api/v1/users stays unhandled (404) on purpose — mcp-protocol.spec.ts
 * asserts that an upstream 404 surfaces as an MCP `isError` result rather than
 * a transport error, and that assertion needs a path that really does 404.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  FIXTURE_CONTROL_PATH,
  FIXTURE_GRAPHQL_PATH,
  FIXTURE_OPENAPI_EXTENDED_PATH,
  FIXTURE_OPENAPI_PATH,
  FIXTURE_PORT,
} from "./env";
import { EXTENDED_OPENAPI } from "./openapi-extended";
import { handleGraphqlRequest } from "./graphql-fixture";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OPENAPI_SPEC = readFileSync(join(__dirname, "../../fixtures/simple-openapi.json"), "utf-8");

/** Longest a spec may ask /slow to sleep — bounds a typo against the 30s test timeout. */
const MAX_SLOW_MS = 10_000;

/**
 * Mutable fixture state. Lives in module scope rather than in a closure so the
 * control endpoints and the request handler share one instance; the process
 * hosting it is torn down between runs, so there is nothing to reset.
 */
const state = {
  /** While true, GET /api/v1/flaky returns 500. Flipped via the control channel. */
  flakyDown: false,
  /** Per-path hit counts — lets a spec assert the bridge stopped calling upstream. */
  hits: {} as Record<string, number>,
};

function recordHit(path: string): void {
  state.hits[path] = (state.hits[path] ?? 0) + 1;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

export function createFixtureServer(): Server {
  return createServer((req, res) => {
    const rawUrl = req.url ?? "";
    // Split the query off once; every branch below matches on the path only.
    const [path, queryString = ""] = rawUrl.split("?");
    const query = new URLSearchParams(queryString);
    const method = req.method ?? "GET";
    recordHit(path);

    // ── Control channel ──────────────────────────────────────────────────────
    if (path.startsWith(FIXTURE_CONTROL_PATH)) {
      const action = path.slice(FIXTURE_CONTROL_PATH.length);
      if (action === "/down") {
        state.flakyDown = true;
        sendJson(res, 200, { status: "down" });
        return;
      }
      if (action === "/up") {
        state.flakyDown = false;
        sendJson(res, 200, { status: "up" });
        return;
      }
      if (action === "/state") {
        sendJson(res, 200, { flakyDown: state.flakyDown, hits: state.hits });
        return;
      }
      sendJson(res, 404, { error: "unknown_control_action" });
      return;
    }

    // ── Discovery documents ──────────────────────────────────────────────────
    if (path === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }

    if (path === FIXTURE_OPENAPI_PATH) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(OPENAPI_SPEC);
      return;
    }

    if (path === FIXTURE_OPENAPI_EXTENDED_PATH) {
      sendJson(res, 200, EXTENDED_OPENAPI);
      return;
    }

    if (path === FIXTURE_GRAPHQL_PATH && method === "POST") {
      void readBody(req).then((body) => sendJson(res, 200, handleGraphqlRequest(body)));
      return;
    }

    // ── Proxied REST endpoints ───────────────────────────────────────────────
    if (path === "/api/v1/users" && method === "GET") {
      sendJson(res, 200, {
        users: [
          { id: 1, name: "Ada Lovelace" },
          { id: 2, name: "Grace Hopper" },
        ],
      });
      return;
    }

    if (path === "/api/v1/secret" && method === "GET") {
      // Shapes the response sanitizer is expected to redact. Kept obviously
      // fake, and asserted on by name in response-sanitization.spec.ts.
      sendJson(res, 200, {
        note: "these should never reach an MCP client verbatim",
        apiKey: "sk-e2e-1234567890abcdefghijklmnopqrstuvwxyz",
        authorization: "Bearer e2e-upstream-token-abcdef0123456789",
        password: "e2e-hunter2-not-a-real-password",
      });
      return;
    }

    if (path === "/api/v1/flaky" && method === "GET") {
      if (state.flakyDown) {
        sendJson(res, 500, { error: "upstream_down", detail: "fixture marked down via control channel" });
        return;
      }
      sendJson(res, 200, { status: "ok", hits: state.hits["/api/v1/flaky"] ?? 0 });
      return;
    }

    if (path === "/api/v1/slow" && method === "GET") {
      const requested = Number(query.get("ms") ?? "0");
      const ms = Number.isFinite(requested) ? Math.min(Math.max(requested, 0), MAX_SLOW_MS) : 0;
      setTimeout(() => sendJson(res, 200, { status: "ok", sleptMs: ms }), ms);
      return;
    }

    if (path === "/api/v1/echo" && method === "GET") {
      sendJson(res, 200, {
        // The bridge must send the ORIGINAL hostname as Host even though it
        // connects to the pinned IP — see the SSRF invariants in CLAUDE.md.
        host: req.headers.host ?? null,
        authorization: req.headers.authorization ?? null,
        headers: req.headers,
        query: Object.fromEntries(query.entries()),
      });
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  });
}

/** Start the fixture on FIXTURE_PORT; resolves with a stop function. */
export async function startFixtureServer(): Promise<() => Promise<void>> {
  const server = createFixtureServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(FIXTURE_PORT, "127.0.0.1", () => resolve());
  });
  return async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}
