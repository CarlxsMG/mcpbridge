/**
 * TEST 7 — isValidSessionId UUID guard in transports.ts
 *
 * Boots a minimal Express app with setupTransports and verifies that:
 *   1. POST /mcp with mcp-session-id: "not-a-uuid" → 400 INVALID_SESSION_ID.
 *   2. GET /mcp with mcp-session-id: "12345" → 400 INVALID_SESSION_ID.
 *   3. DELETE /mcp with mcp-session-id: "../etc/passwd" → 400 INVALID_SESSION_ID.
 *   4. POST /messages?sessionId=invalid → 400 INVALID_SESSION_ID.
 *   5. All four with a valid UUIDv4 → NOT 400 INVALID_SESSION_ID (may be 404 session-not-found).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";

// ---------------------------------------------------------------------------
// App factory — mirrors index.ts transport setup without auth/rate-limit
// ---------------------------------------------------------------------------

let baseUrl = "";
let activeServer: Server | null = null;
let cleanupFn: (() => void) | null = null;

async function startApp(): Promise<void> {
  const { setupTransports } = await import("../transports.js");
  const app = express();
  app.use(express.json({ limit: "64kb", strict: true }));
  cleanupFn = setupTransports(app);

  await new Promise<void>((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      activeServer = srv;
      resolve();
    });
    srv.on("error", reject);
  });
}

function stopApp(): Promise<void> {
  if (cleanupFn) cleanupFn();
  return new Promise<void>(resolve => {
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

const VALID_UUID = "00000000-0000-4000-8000-000000000000";

// ---------------------------------------------------------------------------
// TEST 7a: Invalid session IDs → 400 INVALID_SESSION_ID
// ---------------------------------------------------------------------------

describe("transports — INVALID_SESSION_ID guard: POST /mcp with bad session", () => {
  beforeEach(startApp);
  afterEach(stopApp);

  test("POST /mcp with non-UUID mcp-session-id returns 400 INVALID_SESSION_ID", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-session-id": "not-a-uuid",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe("INVALID_SESSION_ID");
  });
});

describe("transports — INVALID_SESSION_ID guard: GET /mcp with numeric session", () => {
  beforeEach(startApp);
  afterEach(stopApp);

  test("GET /mcp with mcp-session-id: '12345' returns 400 INVALID_SESSION_ID", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "GET",
      headers: { "mcp-session-id": "12345" },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe("INVALID_SESSION_ID");
  });
});

describe("transports — INVALID_SESSION_ID guard: DELETE /mcp with path traversal", () => {
  beforeEach(startApp);
  afterEach(stopApp);

  test("DELETE /mcp with mcp-session-id: '../etc/passwd' returns 400 INVALID_SESSION_ID", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: { "mcp-session-id": "../etc/passwd" },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe("INVALID_SESSION_ID");
  });
});

describe("transports — INVALID_SESSION_ID guard: POST /messages with invalid sessionId", () => {
  beforeEach(startApp);
  afterEach(stopApp);

  test("POST /messages?sessionId=invalid returns 400 INVALID_SESSION_ID", async () => {
    const res = await fetch(`${baseUrl}/messages?sessionId=invalid`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe("INVALID_SESSION_ID");
  });
});

// ---------------------------------------------------------------------------
// TEST 7b: Valid UUIDv4 → NOT 400 INVALID_SESSION_ID (may be 404 session-not-found)
// ---------------------------------------------------------------------------

describe("transports — INVALID_SESSION_ID guard: valid UUID passes format check", () => {
  beforeEach(startApp);
  afterEach(stopApp);

  test("POST /mcp with valid UUID does not return 400 INVALID_SESSION_ID", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-session-id": VALID_UUID,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    // Must NOT be 400 for the session ID format reason
    // (may be 404 session-not-found, 500, 200, etc.)
    if (res.status === 400) {
      const body = await res.json() as { error?: { code?: string } };
      expect(body.error?.code).not.toBe("INVALID_SESSION_ID");
    } else {
      expect(res.status).not.toBe(400);
    }
  });

  test("GET /mcp with valid UUID does not return 400 INVALID_SESSION_ID", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "GET",
      headers: { "mcp-session-id": VALID_UUID },
    });
    if (res.status === 400) {
      const body = await res.json() as { error?: { code?: string } };
      expect(body.error?.code).not.toBe("INVALID_SESSION_ID");
    } else {
      expect(res.status).not.toBe(400);
    }
  });

  test("DELETE /mcp with valid UUID does not return 400 INVALID_SESSION_ID", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: { "mcp-session-id": VALID_UUID },
    });
    if (res.status === 400) {
      const body = await res.json() as { error?: { code?: string } };
      expect(body.error?.code).not.toBe("INVALID_SESSION_ID");
    } else {
      expect(res.status).not.toBe(400);
    }
  });

  test("POST /messages with valid UUID does not return 400 INVALID_SESSION_ID", async () => {
    const res = await fetch(`${baseUrl}/messages?sessionId=${VALID_UUID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
    });
    if (res.status === 400) {
      const body = await res.json() as { error?: { code?: string } };
      expect(body.error?.code).not.toBe("INVALID_SESSION_ID");
    } else {
      expect(res.status).not.toBe(400);
    }
  });
});
