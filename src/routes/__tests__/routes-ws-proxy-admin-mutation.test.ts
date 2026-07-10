/**
 * Stryker mutation-testing backstop for src/routes/ws-proxy-admin.ts —
 * domain 8. No prior test file existed for these admin CRUD routes: the
 * existing routes-ws-proxy.test.ts only covers ws-proxy.ts's actual WS
 * upgrade/pipe logic via a raw server.on("upgrade") harness — it never
 * mounts wsProxyAdminRoutes at all, so this file's endpoints
 * (GET list/detail, POST create, PATCH update, DELETE, POST
 * disconnect-all) had zero coverage of any kind.
 */
import { describe, test, expect, spyOn } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { __resetWsProxyForTesting, handleWsProxyUpgrade } from "../../ws-proxy.js";
import { removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import { registry } from "../../mcp/registry.js";
import { requestIdMiddleware } from "../../middleware/request-id.js";
import * as auditMod from "../../admin/audit/audit.js";

const ADMIN_KEY = "test-admin-key-ws-proxy-admin-mut";
// A raw IPv4 literal (not a real reachable host, but not in any blocked
// range either) — same technique used throughout this program to avoid a
// real DNS lookup in the sandbox (validateBackendUrl's IP-literal fast path
// skips DNS entirely for this kind of URL).
const VALID_URL = "ws://5.6.7.8";

async function startApp(): Promise<{ baseUrl: string; server: Server }> {
  __resetDbForTesting();
  __resetWsProxyForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  const { wsProxyAdminRoutes } = await import("../../routes/ws-proxy-admin.js");
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  wsProxyAdminRoutes(app);
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      resolve({ baseUrl: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, server: srv });
    });
    srv.on("error", reject);
    // Wired unconditionally (harmless for tests that never dial /ws-proxy/*)
    // so the one test that DOES open a real WS connection can exercise
    // disconnect-all's true forwarded count.
    srv.on("upgrade", (req, socket, head) => {
      if (req.url?.startsWith("/ws-proxy/")) {
        void handleWsProxyUpgrade(req, socket, head);
      } else {
        socket.destroy();
      }
    });
  });
}

function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" };
}

async function withApp(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const { baseUrl, server } = await startApp();
  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Same defense-in-depth as routes-ws-proxy.test.ts: once a socket has
      // gone through "upgrade" Bun's http.Server.close() callback does not
      // reliably fire, so race it against a short timeout.
      server.closeAllConnections();
      setTimeout(resolve, 500);
    });
  }
}

async function reg(name: string): Promise<void> {
  await registry.register(
    name,
    [{ name: "t", method: "GET", endpoint: "/t", description: "d", inputSchema: { type: "object", properties: {} } }],
    "http://example.com/health",
    "1.2.3.4",
    "http://example.com",
    "1.2.3.4",
  );
}

interface TargetDetail {
  name: string;
  backendWsUrl: string;
  resolvedIp: string;
  maxConnections: number;
  maxMessageBytes: number;
  idleTimeoutMs: number;
  enabled: boolean;
  activeConnections: number;
}

async function createTarget(baseUrl: string, name: string, extra: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${baseUrl}/admin-api/ws-proxy-targets`, {
    method: "POST",
    headers: bearer(),
    body: JSON.stringify({ name, backendWsUrl: VALID_URL, ...extra }),
  });
}

describe("GET /admin-api/ws-proxy-targets", () => {
  test("lists targets sorted by name with activeConnections, filtered to none when empty", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/ws-proxy-targets`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[] };
      expect(body.items).toEqual([]);
    });
  });

  test("returns exactly the created targets, sorted alphabetically, each with activeConnections 0", async () => {
    await withApp(async (baseUrl) => {
      await createTarget(baseUrl, "svc-wspa-list-zzz");
      await createTarget(baseUrl, "svc-wspa-list-aaa");
      const res = await fetch(`${baseUrl}/admin-api/ws-proxy-targets`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: TargetDetail[] };
      expect(body.items.map((t) => t.name)).toEqual(["svc-wspa-list-aaa", "svc-wspa-list-zzz"]);
      expect(body.items[0].activeConnections).toBe(0);
    });
  });
});

describe("GET /admin-api/ws-proxy-targets/:name", () => {
  test("returns the exact WS_PROXY_TARGET_NOT_FOUND 404 for an unknown target", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/ws-proxy-targets/does-not-exist`, { headers: bearer() });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("WS_PROXY_TARGET_NOT_FOUND");
      expect(body.error.message).toBe("Target not found");
    });
  });

  test("returns 200 with the full detail for a known target", async () => {
    await withApp(async (baseUrl) => {
      await createTarget(baseUrl, "svc-wspa-detail-ok");
      const res = await fetch(`${baseUrl}/admin-api/ws-proxy-targets/svc-wspa-detail-ok`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as TargetDetail;
      expect(body.name).toBe("svc-wspa-detail-ok");
      expect(body.backendWsUrl).toBe(VALID_URL);
      expect(body.activeConnections).toBe(0);
    });
  });
});

describe("POST /admin-api/ws-proxy-targets", () => {
  test("no request body at all is a graceful validation error, not a crash", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/ws-proxy-targets`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("backendWsUrl is required");
    });
  });

  test("a missing backendWsUrl fails with the exact message", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/ws-proxy-targets`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "svc-wspa-no-url" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("backendWsUrl is required");
    });
  });

  test("a non-string backendWsUrl (truthy, wrong type) fails with the exact message", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/ws-proxy-targets`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "svc-wspa-numeric-url", backendWsUrl: 12345 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("backendWsUrl is required");
    });
  });

  describe("maxConnections boundary cluster", () => {
    test("a non-number (truthy string) maxConnections fails validation", async () => {
      await withApp(async (baseUrl) => {
        const res = await createTarget(baseUrl, "svc-wspa-mc-string", { maxConnections: "5" });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe("VALIDATION_ERROR");
        expect(body.error.message).toBe("maxConnections must be a positive integer");
      });
    });

    test("a non-integer maxConnections fails validation", async () => {
      await withApp(async (baseUrl) => {
        const res = await createTarget(baseUrl, "svc-wspa-mc-float", { maxConnections: 2.5 });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.message).toBe("maxConnections must be a positive integer");
      });
    });

    test("maxConnections of 0 fails the positive-integer boundary", async () => {
      await withApp(async (baseUrl) => {
        const res = await createTarget(baseUrl, "svc-wspa-mc-zero", { maxConnections: 0 });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.message).toBe("maxConnections must be a positive integer");
      });
    });

    test("maxConnections of exactly 1 is accepted (the boundary itself)", async () => {
      await withApp(async (baseUrl) => {
        const res = await createTarget(baseUrl, "svc-wspa-mc-one", { maxConnections: 1 });
        expect(res.status).toBe(201);
        const body = (await res.json()) as TargetDetail;
        expect(body.maxConnections).toBe(1);
      });
    });
  });

  describe("maxMessageBytes boundary cluster", () => {
    test("a non-number (truthy string) maxMessageBytes fails validation", async () => {
      await withApp(async (baseUrl) => {
        const res = await createTarget(baseUrl, "svc-wspa-mb-string", { maxMessageBytes: "1024" });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.message).toBe("maxMessageBytes must be a positive integer");
      });
    });

    test("a non-integer maxMessageBytes fails validation", async () => {
      await withApp(async (baseUrl) => {
        const res = await createTarget(baseUrl, "svc-wspa-mb-float", { maxMessageBytes: 100.1 });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.message).toBe("maxMessageBytes must be a positive integer");
      });
    });

    test("maxMessageBytes of 0 fails the positive-integer boundary", async () => {
      await withApp(async (baseUrl) => {
        const res = await createTarget(baseUrl, "svc-wspa-mb-zero", { maxMessageBytes: 0 });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.message).toBe("maxMessageBytes must be a positive integer");
      });
    });

    test("maxMessageBytes of exactly 1 is accepted (the boundary itself)", async () => {
      await withApp(async (baseUrl) => {
        const res = await createTarget(baseUrl, "svc-wspa-mb-one", { maxMessageBytes: 1 });
        expect(res.status).toBe(201);
        const body = (await res.json()) as TargetDetail;
        expect(body.maxMessageBytes).toBe(1);
      });
    });
  });

  describe("idleTimeoutMs boundary cluster", () => {
    test("a non-number (truthy string) idleTimeoutMs fails validation", async () => {
      await withApp(async (baseUrl) => {
        const res = await createTarget(baseUrl, "svc-wspa-it-string", { idleTimeoutMs: "60000" });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.message).toBe("idleTimeoutMs must be a positive integer");
      });
    });

    test("a non-integer idleTimeoutMs fails validation", async () => {
      await withApp(async (baseUrl) => {
        const res = await createTarget(baseUrl, "svc-wspa-it-float", { idleTimeoutMs: 500.5 });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.message).toBe("idleTimeoutMs must be a positive integer");
      });
    });

    test("idleTimeoutMs of 0 fails the positive-integer boundary", async () => {
      await withApp(async (baseUrl) => {
        const res = await createTarget(baseUrl, "svc-wspa-it-zero", { idleTimeoutMs: 0 });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.message).toBe("idleTimeoutMs must be a positive integer");
      });
    });

    test("idleTimeoutMs of exactly 1 is accepted (the boundary itself)", async () => {
      await withApp(async (baseUrl) => {
        const res = await createTarget(baseUrl, "svc-wspa-it-one", { idleTimeoutMs: 1 });
        expect(res.status).toBe(201);
        const body = (await res.json()) as TargetDetail;
        expect(body.idleTimeoutMs).toBe(1);
      });
    });
  });

  test("a non-boolean (truthy, wrong type) enabled fails validation with the exact message", async () => {
    await withApp(async (baseUrl) => {
      const res = await createTarget(baseUrl, "svc-wspa-enabled-badtype", { enabled: "false" });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("enabled must be a boolean");
    });
  });

  test("an omitted name defaults to empty string and fails INVALID_NAME", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/ws-proxy-targets`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ backendWsUrl: VALID_URL }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("INVALID_NAME");
      expect(body.error.message).toBe("Name must match /^[a-z0-9][a-z0-9_-]{0,62}$/");
    });
  });

  test("an invalid-shaped name (uppercase) fails the exact INVALID_NAME 400", async () => {
    await withApp(async (baseUrl) => {
      const res = await createTarget(baseUrl, "Bad-Name");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("INVALID_NAME");
      expect(body.error.message).toBe("Name must match /^[a-z0-9][a-z0-9_-]{0,62}$/");
    });
  });

  test("a name colliding with an already-registered MCP/REST client fails the exact NAME_COLLISION 409", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-wspa-collide");
      const res = await createTarget(baseUrl, "svc-wspa-collide");
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("NAME_COLLISION");
      expect(body.error.message).toBe('"svc-wspa-collide" is already registered as an MCP/REST client');
    });
  });

  test("a backendWsUrl with a non-ws(s) protocol fails the exact INVALID_URL 400", async () => {
    await withApp(async (baseUrl) => {
      const res = await createTarget(baseUrl, "svc-wspa-bad-protocol", { backendWsUrl: "http://5.6.7.8" });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("INVALID_URL");
      expect(body.error.message).toBe("backendWsUrl must start with ws:// or wss://");
    });
  });

  test("a backendWsUrl resolving to a blocked private range fails INVALID_URL with the validator's own reason", async () => {
    // Force this OFF regardless of the ambient dev .env's own
    // ALLOW_PRIVATE_IPS=true (used elsewhere in this file, and in this
    // repo's local dev setup, to permit loopback registration) — this
    // specific test exists to prove the block itself, so it must not
    // depend on which environment happens to be running it.
    const originalAllowPrivate = config.allowPrivateIps;
    (config as Record<string, unknown>).allowPrivateIps = false;
    try {
      await withApp(async (baseUrl) => {
        const res = await createTarget(baseUrl, "svc-wspa-blocked-ip", { backendWsUrl: "ws://127.0.0.1:9" });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe("INVALID_URL");
        expect(body.error.message).toBe("IP is in a blocked private range: 127.0.0.1");
      });
    } finally {
      (config as Record<string, unknown>).allowPrivateIps = originalAllowPrivate;
    }
  });

  test("a fully valid target is created, audited with the exact detail, and returned with defaults", async () => {
    await withApp(async (baseUrl) => {
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await createTarget(baseUrl, "svc-wspa-create-ok");
        expect(res.status).toBe(201);
        const body = (await res.json()) as TargetDetail;
        expect(body.name).toBe("svc-wspa-create-ok");
        expect(body.backendWsUrl).toBe(VALID_URL);
        expect(body.enabled).toBe(true);
        expect(body.maxConnections).toBe(config.wsProxyDefaultMaxConnectionsPerTarget);
        expect(body.maxMessageBytes).toBe(config.wsProxyDefaultMaxMessageBytes);
        expect(body.idleTimeoutMs).toBe(config.wsProxyDefaultIdleTimeoutMs);
        expect(spy).toHaveBeenCalledWith(expect.any(String), "ws_proxy_target.create", "svc-wspa-create-ok", {
          backendWsUrl: VALID_URL,
        });
      } finally {
        spy.mockRestore();
      }
    });
  });

  test("enabled: false is preserved exactly (not coerced to the true default)", async () => {
    await withApp(async (baseUrl) => {
      const res = await createTarget(baseUrl, "svc-wspa-create-disabled", { enabled: false });
      expect(res.status).toBe(201);
      const body = (await res.json()) as TargetDetail;
      expect(body.enabled).toBe(false);
    });
  });
});

describe("PATCH /admin-api/ws-proxy-targets/:name", () => {
  test("returns the exact WS_PROXY_TARGET_NOT_FOUND 404 for an unknown target", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/ws-proxy-targets/does-not-exist`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("WS_PROXY_TARGET_NOT_FOUND");
      expect(body.error.message).toBe("Target not found");
    });
  });

  test("no request body at all does not crash: existing values are re-applied and audited with an empty fields list", async () => {
    await withApp(async (baseUrl) => {
      await createTarget(baseUrl, "svc-wspa-patch-nobody");
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/ws-proxy-targets/svc-wspa-patch-nobody`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${ADMIN_KEY}` },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as TargetDetail;
        expect(body.backendWsUrl).toBe(VALID_URL);
        expect(spy).toHaveBeenCalledWith(expect.any(String), "ws_proxy_target.update", "svc-wspa-patch-nobody", {
          fields: [],
        });
      } finally {
        spy.mockRestore();
      }
    });
  });

  test("a partial patch overrides only the given field, preserving every other existing value", async () => {
    await withApp(async (baseUrl) => {
      await createTarget(baseUrl, "svc-wspa-patch-partial", { maxConnections: 3, maxMessageBytes: 2048 });
      const res = await fetch(`${baseUrl}/admin-api/ws-proxy-targets/svc-wspa-patch-partial`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ maxConnections: 7 }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as TargetDetail;
      expect(body.maxConnections).toBe(7);
      expect(body.maxMessageBytes).toBe(2048);
      expect(body.backendWsUrl).toBe(VALID_URL);
    });
  });

  test("a merged-in invalid field fails validation the same way create does", async () => {
    await withApp(async (baseUrl) => {
      await createTarget(baseUrl, "svc-wspa-patch-badmerge");
      const res = await fetch(`${baseUrl}/admin-api/ws-proxy-targets/svc-wspa-patch-badmerge`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ maxConnections: -1 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("maxConnections must be a positive integer");
    });
  });

  test("re-validates the backend URL on update and fails INVALID_URL for a newly-bad URL", async () => {
    await withApp(async (baseUrl) => {
      await createTarget(baseUrl, "svc-wspa-patch-badurl");
      const res = await fetch(`${baseUrl}/admin-api/ws-proxy-targets/svc-wspa-patch-badurl`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ backendWsUrl: "http://5.6.7.8" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("INVALID_URL");
      expect(body.error.message).toBe("backendWsUrl must start with ws:// or wss://");
    });
  });

  test("a fully valid multi-field patch is applied, audited with the exact field-name list, and returned", async () => {
    await withApp(async (baseUrl) => {
      await createTarget(baseUrl, "svc-wspa-patch-ok");
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/ws-proxy-targets/svc-wspa-patch-ok`, {
          method: "PATCH",
          headers: bearer(),
          body: JSON.stringify({ enabled: false, maxConnections: 9 }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as TargetDetail;
        expect(body.enabled).toBe(false);
        expect(body.maxConnections).toBe(9);
        expect(spy).toHaveBeenCalledWith(expect.any(String), "ws_proxy_target.update", "svc-wspa-patch-ok", {
          fields: ["enabled", "maxConnections"],
        });
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("DELETE /admin-api/ws-proxy-targets/:name", () => {
  test("returns the exact WS_PROXY_TARGET_NOT_FOUND 404 for an unknown target", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/ws-proxy-targets/does-not-exist`, {
        method: "DELETE",
        headers: bearer(),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("WS_PROXY_TARGET_NOT_FOUND");
      expect(body.error.message).toBe("Target not found");
    });
  });

  test("a successful delete is audited (no detail) and returns the exact response shape, genuinely removing the target", async () => {
    await withApp(async (baseUrl) => {
      await createTarget(baseUrl, "svc-wspa-delete-ok");
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/ws-proxy-targets/svc-wspa-delete-ok`, {
          method: "DELETE",
          headers: bearer(),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; name: string };
        expect(body).toEqual({ status: "deleted", name: "svc-wspa-delete-ok" });
        expect(spy).toHaveBeenCalledWith(expect.any(String), "ws_proxy_target.delete", "svc-wspa-delete-ok");
      } finally {
        spy.mockRestore();
      }
      const get = await fetch(`${baseUrl}/admin-api/ws-proxy-targets/svc-wspa-delete-ok`, { headers: bearer() });
      expect(get.status).toBe(404);
    });
  });
});

describe("POST /admin-api/ws-proxy-targets/:name/disconnect-all", () => {
  test("returns the exact WS_PROXY_TARGET_NOT_FOUND 404 for an unknown target", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/ws-proxy-targets/does-not-exist/disconnect-all`, {
        method: "POST",
        headers: bearer(),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("WS_PROXY_TARGET_NOT_FOUND");
      expect(body.error.message).toBe("Target not found");
    });
  });

  test("with zero live connections, reports closed: 0 and is audited with that exact detail", async () => {
    await withApp(async (baseUrl) => {
      await createTarget(baseUrl, "svc-wspa-disc-empty");
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/ws-proxy-targets/svc-wspa-disc-empty/disconnect-all`, {
          method: "POST",
          headers: bearer(),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; closed: number };
        expect(body).toEqual({ status: "disconnected", closed: 0 });
        expect(spy).toHaveBeenCalledWith(expect.any(String), "ws_proxy_target.disconnect_all", "svc-wspa-disc-empty", {
          closed: 0,
        });
      } finally {
        spy.mockRestore();
      }
    });
  });

  test("force-closes a REAL live connection and reports the true forwarded count (not a hardcoded 0)", async () => {
    await withApp(async (baseUrl) => {
      const originalAllowPrivate = config.allowPrivateIps;
      (config as Record<string, unknown>).allowPrivateIps = true;
      const backend = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req, srv) {
          return srv.upgrade(req) ? undefined : new Response("no");
        },
        websocket: { message() {} },
      });
      const targetName = "svc-wspa-disc-live";
      try {
        const createRes = await createTarget(baseUrl, targetName, {
          backendWsUrl: `ws://127.0.0.1:${backend.port}`,
        });
        expect(createRes.status).toBe(201);

        const wsUrl = baseUrl.replace(/^http/, "ws") + `/ws-proxy/${targetName}`;
        const ws = new WebSocket(wsUrl);
        await new Promise<void>((resolve, reject) => {
          ws.addEventListener("open", () => resolve());
          ws.addEventListener("error", reject);
          setTimeout(() => reject(new Error("timed out opening ws")), 4000);
        });

        const closedPromise = new Promise<boolean>((resolve) => {
          ws.addEventListener("close", () => resolve(true));
          setTimeout(() => resolve(false), 4000);
        });

        const res = await fetch(`${baseUrl}/admin-api/ws-proxy-targets/${targetName}/disconnect-all`, {
          method: "POST",
          headers: bearer(),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; closed: number };
        expect(body).toEqual({ status: "disconnected", closed: 1 });
        expect(await closedPromise).toBe(true);
      } finally {
        backend.stop(true);
        removeCircuitBreaker(targetName);
        (config as Record<string, unknown>).allowPrivateIps = originalAllowPrivate;
      }
    });
  });
});
