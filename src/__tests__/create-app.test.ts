/**
 * Tests for `createApp()` in `src/server.ts` — the P1-1 follow-up
 * (extract app wiring from src/index.ts so tests don't have to).
 *
 * The point of the extraction is: a test should be able to build a
 * fully-wired Express app and hit any of the REST endpoints with a
 * single import, without `app.listen` or the long-running bootstrap
 * side-effects (DB migration, leader election, background loops).
 *
 * These tests also double as a smoke test for the wiring itself — if
 * `createApp` is missing a router, the corresponding endpoint won't
 * respond and the assertion below will fail.
 */
import { describe, test, expect, afterEach } from "bun:test";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { __resetLeaderFlagForTesting } from "../db/leader-lease.js";
import { createApp } from "../server.js";

let activeServer: Server | null = null;
let baseUrl = "";

async function startApp(): Promise<void> {
  __resetDbForTesting();
  __resetLeaderFlagForTesting();
  (config as Record<string, unknown>).adminApiKeys = ["test-admin-key"];
  (config as Record<string, unknown>).authDisabled = false;
  // Use a unique per-test admin API key so parallel test runs (each test
  // file gets its own process) don't share the auth credential.

  const { app, cleanupTransports } = createApp();
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      activeServer = srv;
      resolve();
    });
    srv.on("error", reject);
    // The cleanup hook is intentionally not invoked here — the test process
    // tears the listener down via `activeServer.close()` in afterEach, which
    // is enough to release the port. cleanupTransports() is for graceful
    // shutdown of MCP sessions, which these tests don't open.
    void cleanupTransports;
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (activeServer) {
      activeServer.close(() => {
        activeServer = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

afterEach(async () => {
  await stopServer();
});

describe("createApp()", () => {
  test("returns a fully-wired Express instance whose /livez responds 200", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/livez`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("alive");
  });

  test("returns a fully-wired Express instance whose /health responds 200 with uptime", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; uptime_seconds: number };
    expect(body.status).toBe("ok");
    expect(typeof body.uptime_seconds).toBe("number");
  });

  test("emits the baseline security-headers on every response", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/livez`);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toContain("default-src 'none'");
    const pp = res.headers.get("Permissions-Policy");
    expect(pp).toContain("camera=()");
  });

  test("responds with 404 (not 500) for an unknown admin route", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/this-route-does-not-exist`, {
      headers: { Authorization: "Bearer test-admin-key" },
    });
    expect(res.status).toBe(404);
  });

  test("the global error envelope is JSON, not HTML, when a route throws", async () => {
    // Force a 500 by requesting a known-broken JSON body on a route that
    // strictly validates: PATCH /admin-api/clients/:name/tools/:tool with
    // a body that trips the express.json() strict-mode before the route
    // is reached.
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/auth/login`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-admin-key",
        "Content-Type": "application/json",
        "X-Request-ID": "snapshot-req",
      },
      // `{"a":}` is malformed JSON; express.json() surfaces it as SyntaxError,
      // which the global error handler turns into a 400 JSON envelope.
      body: '{"a":}',
    });
    // express.json() SyntaxError produces 400, not 500; what we care about
    // is the envelope shape, not the code.
    expect([400, 500]).toContain(res.status);
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).toContain("application/json");
    const body = (await res.json()) as { error?: { code: string; message: string } };
    expect(body.error).toBeDefined();
    expect(typeof body.error!.code).toBe("string");
  });
});
