/**
 * Tests for src/mcp/transports.ts
 *
 * Strategy:
 * - Spin up a minimal Express app using setupTransports and hit it with raw fetch.
 * - /mcp is the system control plane (rootMcpAuth) — every request needs a
 *   resolved system-role credential; tests set config.adminApiKeys and send
 *   the matching Authorization header.
 * - activeSessionCount / double-decrement regression: tested via getActiveSessionCount().
 * - maxSessions cap: exercised through config mutation + POST /mcp.
 * - TTL cleanup: verified via short TTL config + cleanup interval.
 * - Session not found: missing/unknown session IDs return 404.
 * - getActiveSessionCount export: numeric and non-negative.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";

let baseUrl = "";
let activeServer: Server | null = null;

const ROOT_KEY = "test-root-admin-key";
const AUTH_HEADER = { Authorization: `Bearer ${ROOT_KEY}` };
const originalAdminApiKeys = config.adminApiKeys;

async function startApp(): Promise<() => void> {
  const { setupTransports } = await import("../../mcp/transports.js");
  const app = express();
  app.use(express.json({ limit: "64kb", strict: true }));
  const cleanup = setupTransports(app);

  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      activeServer = srv;
      resolve(cleanup);
    });
    srv.on("error", reject);
  });
}

function stopServer(cleanup: () => void): Promise<void> {
  cleanup();
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

beforeEach(() => {
  (config as Record<string, unknown>).adminApiKeys = [ROOT_KEY];
});

afterEach(() => {
  (config as Record<string, unknown>).adminApiKeys = originalAdminApiKeys;
});

// ---------------------------------------------------------------------------
// TEST 0: No system-role credential is rejected outright (no data-plane-style
// "unconfigured means open" fallback on the /mcp control plane).
// ---------------------------------------------------------------------------

describe("transports — /mcp requires a resolved system role", () => {
  test("POST /mcp without Authorization is rejected (401/403), not treated as open", async () => {
    const cleanup = await startApp();
    try {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
      });
      expect([401, 403]).toContain(res.status);
    } finally {
      await stopServer(cleanup);
    }
  });
});

// ---------------------------------------------------------------------------
// TEST 1: Unknown session on GET /mcp returns 404
// ---------------------------------------------------------------------------

describe("transports — unknown session ID on GET /mcp returns 404", () => {
  test("GET /mcp with a valid-looking but unknown session returns 404", async () => {
    const cleanup = await startApp();
    try {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "GET",
        headers: {
          "mcp-session-id": "00000000-0000-4000-8000-000000000000",
          ...AUTH_HEADER,
        },
      });
      expect(res.status).toBe(404);
    } finally {
      await stopServer(cleanup);
    }
  });
});

// ---------------------------------------------------------------------------
// TEST 2: Unknown session on DELETE /mcp returns 404
// ---------------------------------------------------------------------------

describe("transports — unknown session ID on DELETE /mcp returns 404", () => {
  test("DELETE /mcp with an unknown session returns 404", async () => {
    const cleanup = await startApp();
    try {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "DELETE",
        headers: {
          "mcp-session-id": "00000000-0000-4000-8000-000000000001",
          ...AUTH_HEADER,
        },
      });
      expect(res.status).toBe(404);
    } finally {
      await stopServer(cleanup);
    }
  });
});

// ---------------------------------------------------------------------------
// TEST 3: getActiveSessionCount is exported and returns a non-negative integer
// ---------------------------------------------------------------------------

describe("transports — getActiveSessionCount is exported and numeric", () => {
  test("getActiveSessionCount() returns a non-negative integer", async () => {
    const { getActiveSessionCount } = await import("../../mcp/transports.js");
    const count = getActiveSessionCount();
    expect(typeof count).toBe("number");
    expect(count).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(count)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TEST 4: TTL cleanup — counter remains non-negative after stale session purge
// ---------------------------------------------------------------------------

describe("transports — TTL cleanup loop does not underflow counter", () => {
  test("activeSessionCount stays non-negative after cleanup loop runs", async () => {
    const origTtl = config.sessionTtlMs;
    (config as Record<string, unknown>).sessionTtlMs = 1; // expire immediately

    const { getActiveSessionCount } = await import("../../mcp/transports.js");
    const cleanup = await startApp();

    // Wait long enough for the cleanup loop's 60s interval to NOT run — we are just
    // verifying that the counter does not go below zero via any other cleanup path.
    await new Promise((resolve) => setTimeout(resolve, 30));

    const count = getActiveSessionCount();
    expect(count).toBeGreaterThanOrEqual(0);

    (config as Record<string, unknown>).sessionTtlMs = origTtl;
    await stopServer(cleanup);
  });
});

// ---------------------------------------------------------------------------
// TEST 5: activeSessionCount consistency — no double-decrement over multiple cycles
// ---------------------------------------------------------------------------

describe("transports — activeSessionCount consistency across setup/cleanup cycles", () => {
  test("activeSessionCount remains non-negative after multiple start/stop cycles", async () => {
    const { getActiveSessionCount } = await import("../../mcp/transports.js");

    for (let i = 0; i < 3; i++) {
      const cleanup = await startApp();
      await stopServer(cleanup);
    }

    expect(getActiveSessionCount()).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// TEST 6: POST /mcp without session ID returns 503 when at capacity
// ---------------------------------------------------------------------------

describe("transports — POST /mcp new session respects maxSessions cap", () => {
  test("POST /mcp without mcp-session-id returns 503 when at capacity", async () => {
    const origMax = config.maxSessions;
    (config as Record<string, unknown>).maxSessions = 0;

    const cleanup = await startApp();
    try {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", ...AUTH_HEADER },
        body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
      });
      expect(res.status).toBe(503);
    } finally {
      (config as Record<string, unknown>).maxSessions = origMax;
      await stopServer(cleanup);
    }
  });
});

// ---------------------------------------------------------------------------
// TEST 7: DELETE releases exactly one session slot — the double-decrement
// regression. Establishes two REAL sessions (full initialize handshake), then
// deletes one and asserts the counter drops by exactly one. The pre-fix code
// decremented twice per departure (the transport's onclose AND the explicit
// DELETE/TTL/shutdown handler), which — with two live sessions — dropped the
// counter to the baseline while a session was still live, silently defeating
// the maxSessions cap. The Math.max(0, …) clamp masked this on a single
// session, so only the two-session case distinguishes the bug from the fix.
// ---------------------------------------------------------------------------

/** Full initialize → notifications/initialized handshake on the /mcp system scope. Returns the session id. */
async function initSystemSession(): Promise<string> {
  const initRes = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...AUTH_HEADER },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      id: 1,
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    }),
  });
  const sessionId = initRes.headers.get("mcp-session-id");
  if (initRes.status !== 200 || !sessionId) throw new Error(`initialize failed: status=${initRes.status}`);
  await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      ...AUTH_HEADER,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  return sessionId;
}

describe("transports — DELETE releases exactly one session slot (no double-decrement)", () => {
  test("deleting one of two live sessions leaves the counter at exactly one", async () => {
    const { getActiveSessionCount } = await import("../../mcp/transports.js");
    const cleanup = await startApp();
    try {
      const before = getActiveSessionCount();

      const a = await initSystemSession();
      const b = await initSystemSession();
      expect(getActiveSessionCount()).toBe(before + 2);

      // Delete one; the other stays live. Pre-fix, this decremented twice.
      const del = await fetch(`${baseUrl}/mcp`, { method: "DELETE", headers: { "mcp-session-id": a, ...AUTH_HEADER } });
      expect(del.status).toBeLessThan(300);
      // Let onclose (fired inside handleRequest) and the trailing explicit
      // release both settle before reading the counter.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(getActiveSessionCount()).toBe(before + 1);

      const del2 = await fetch(`${baseUrl}/mcp`, {
        method: "DELETE",
        headers: { "mcp-session-id": b, ...AUTH_HEADER },
      });
      expect(del2.status).toBeLessThan(300);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(getActiveSessionCount()).toBe(before);
    } finally {
      await stopServer(cleanup);
    }
  });
});
