/**
 * TEST 5 — enforceJsonDepth is actually mounted in the Express app
 *
 * Boots a minimal app that mirrors what index.ts does (express.json + enforceJsonDepth)
 * and verifies that:
 *   1. A body exceeding maxJsonDepth returns 400 JSON_TOO_DEEP.
 *   2. A body at exactly maxJsonDepth does NOT return 400 JSON_TOO_DEEP.
 */
import { describe, test, expect } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { enforceJsonDepth } from "../middleware/json-depth.js";
import { config } from "../config.js";

// ---------------------------------------------------------------------------
// Minimal app factory — mirrors index.ts middleware stack up to enforceJsonDepth
// ---------------------------------------------------------------------------

function buildApp() {
  const app = express();
  // Mirror the exact order used in index.ts
  app.use(express.json({ limit: "64kb", strict: true }));
  app.use(enforceJsonDepth(config.maxJsonDepth));

  // A simple JSON-accepting route (no auth required)
  app.post("/test-depth", (req, res) => {
    res.status(200).json({ received: true, keys: Object.keys(req.body ?? {}) });
  });

  return app;
}

async function startServer(): Promise<{ url: string; stop: () => Promise<void> }> {
  const app = buildApp();
  return new Promise((resolve, reject) => {
    const srv: Server = app.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        stop: () => new Promise<void>((res) => srv.close(() => res())),
      });
    });
    srv.on("error", reject);
  });
}

/** Build a JSON object nested `depth` extra levels below the root. */
function deepBody(depth: number): Record<string, unknown> {
  let inner: unknown = { leaf: true };
  for (let i = 0; i < depth; i++) {
    inner = { child: inner };
  }
  return { root: inner };
}

// ---------------------------------------------------------------------------
// TEST 5a: Body exceeding maxJsonDepth → 400 JSON_TOO_DEEP
// ---------------------------------------------------------------------------

describe("enforceJsonDepth mounted — body exceeds maxJsonDepth: 400 JSON_TOO_DEEP", () => {
  test("POST /test-depth with body deeper than maxJsonDepth returns 400 JSON_TOO_DEEP", async () => {
    const { url, stop } = await startServer();
    try {
      // config.maxJsonDepth defaults to 32; build something safely beyond it
      const body = deepBody(config.maxJsonDepth + 5);
      const res = await fetch(`${url}/test-depth`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      expect(res.status).toBe(400);
      const json = (await res.json()) as { error?: { code?: string } };
      expect(json.error?.code).toBe("JSON_TOO_DEEP");
    } finally {
      await stop();
    }
  });
});

// ---------------------------------------------------------------------------
// TEST 5b: Body at exactly maxJsonDepth → does NOT return 400 JSON_TOO_DEEP
// ---------------------------------------------------------------------------

describe("enforceJsonDepth mounted — body at exactly maxJsonDepth: not rejected", () => {
  test("POST /test-depth with body at exactly maxJsonDepth returns 200 (not JSON_TOO_DEEP)", async () => {
    const { url, stop } = await startServer();
    try {
      // The middleware checks: if depth > maxDepth → reject.
      // So depth === maxJsonDepth is allowed.
      // deepBody(n) creates an object where the deepest node is at depth n+1 from root.
      // We want the total nesting to be exactly maxJsonDepth.
      // root(0) → root.root(1) → child*(maxJsonDepth-1 levels) → leaf = depth maxJsonDepth
      const body = deepBody(config.maxJsonDepth - 1);
      const res = await fetch(`${url}/test-depth`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      // Should NOT be rejected for depth — 200 OK
      expect(res.status).toBe(200);
    } finally {
      await stop();
    }
  });
});

// ---------------------------------------------------------------------------
// TEST 5c: Verifies middleware is mounted BEFORE the route handler
//          (i.e., enforceJsonDepth runs even if the route does nothing special)
// ---------------------------------------------------------------------------

describe("enforceJsonDepth mounted — middleware order: depth check before route handler", () => {
  test("depth check is applied before the route handler processes the body", async () => {
    const { url, stop } = await startServer();
    try {
      // A body that is clearly too deep
      const body = deepBody(config.maxJsonDepth + 10);
      const res = await fetch(`${url}/test-depth`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      // If enforceJsonDepth were NOT mounted, the route handler would return 200.
      // 400 proves the middleware intercepted it first.
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error?: { code?: string } };
      expect(json.error?.code).toBe("JSON_TOO_DEEP");
    } finally {
      await stop();
    }
  });
});
