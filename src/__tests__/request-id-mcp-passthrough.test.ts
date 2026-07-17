/**
 * Regression test for `withRequestIdError` (src/server.ts), finding #44.
 *
 * `withRequestIdError` wraps the two global middlewares that write their own
 * error body without reaching the global error handler (JSON-depth's 400 and
 * the global rate-limit's 429), backfilling `request_id` into the emitted
 * `{ error: {...} }` envelope. It does that by temporarily patching `res.json`
 * and restoring it the instant the wrapped middleware sends its body or passes
 * control on.
 *
 * The load-bearing invariant this file guards: that restore MUST happen before
 * routing, so a DIFFERENT downstream `res.json` caller — notably the MCP
 * Streamable-HTTP transport, whose JSON-RPC error payloads are `{ jsonrpc,
 * error: { code, message }, id }` — never has `request_id` injected into its
 * `error` object. A JSON-RPC `error` object is structurally the same
 * "object with no `request_id` key" the backfill looks for, so a leaked patch
 * would silently corrupt the protocol response. server-mutation.test.ts proves
 * the positive side (the two wrapped middlewares DO carry request_id); this
 * file proves the negative side against a real mounted `/mcp` handler and keeps
 * both assertions side by side so the contrast is self-contained.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { randomUUID } from "crypto";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { __resetLeaderFlagForTesting } from "../db/leader-lease.js";
import { createApp } from "../server.js";
import { _internalsForTesting as rateLimiterInternals } from "../middleware/rate-limiter.js";

const ADMIN_KEY = "test-admin-key-reqid-passthrough";

let activeServer: Server | null = null;
let baseUrl = "";

async function startApp(): Promise<void> {
  __resetDbForTesting();
  __resetLeaderFlagForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  const { app, cleanupTransports } = createApp();
  void cleanupTransports; // sessions aren't opened here; afterEach closes the listener
  await new Promise<void>((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
      activeServer = srv;
      resolve();
    });
    srv.on("error", reject);
  });
}

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (activeServer) {
      activeServer.close(() => {
        activeServer = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
});

describe("withRequestIdError does not leak its res.json patch into /mcp", () => {
  test("a /mcp JSON-RPC error body is left untouched — no request_id injected into the error object", async () => {
    await startApp();
    // A valid-shaped v4 session id that was never issued: handleStreamablePost
    // returns its 404 JSON-RPC "Session not found or expired" envelope directly
    // via Express `res.json` — the exact call site a leaked patch would corrupt.
    const unknownSession = randomUUID();
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ADMIN_KEY}`,
        "Content-Type": "application/json",
        "mcp-session-id": unknownSession,
        "X-Request-ID": "mcp-passthrough-req-id",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 42 }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      jsonrpc?: string;
      error?: Record<string, unknown>;
      id?: unknown;
      request_id?: unknown;
    };
    // It really is a JSON-RPC error envelope (not the plain admin error shape).
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error).toBeDefined();
    expect(body.error?.code).toBe(-32000);
    expect(body.id).toBe(42);
    // The invariant: the JSON-RPC error object carries NO request_id key…
    expect("request_id" in (body.error as object)).toBe(false);
    // …and none was smuggled onto the top-level body either.
    expect("request_id" in body).toBe(false);
    // The correlation id still travels in the response header, as always.
    expect(res.headers.get("X-Request-ID")).toBe("mcp-passthrough-req-id");
  });

  test("contrast: a 400 JSON_TOO_DEEP body DOES carry the request_id", async () => {
    await startApp();
    let payload: unknown = { leaf: true };
    for (let i = 0; i < config.maxJsonDepth + 5; i++) payload = { nested: payload };
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ADMIN_KEY}`,
        "Content-Type": "application/json",
        "X-Request-ID": "depth-req-id",
      },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; request_id: string } };
    expect(body.error.code).toBe("JSON_TOO_DEEP");
    expect(body.error.request_id).toBe("depth-req-id");
  });

  test("contrast: a 429 RATE_LIMITED body DOES carry the request_id", async () => {
    const originalGlobal = config.rateLimitGlobal;
    (config as Record<string, unknown>).rateLimitGlobal = 1;
    rateLimiterInternals.globalBuckets.clear();
    try {
      await startApp(); // captures the limit of 1 in the rateLimitGlobal closure
      const first = await fetch(`${baseUrl}/livez`);
      expect(first.status).toBe(200); // consumes the single global token
      const res = await fetch(`${baseUrl}/livez`, { headers: { "X-Request-ID": "rl-req-id" } });
      expect(res.status).toBe(429);
      const body = (await res.json()) as { error: { code: string; request_id: string; retry_after?: number } };
      expect(body.error.code).toBe("RATE_LIMITED");
      expect(body.error.request_id).toBe("rl-req-id");
      expect(typeof body.error.retry_after).toBe("number");
    } finally {
      (config as Record<string, unknown>).rateLimitGlobal = originalGlobal;
      rateLimiterInternals.globalBuckets.clear();
    }
  });
});
