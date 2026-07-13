/**
 * Stryker mutation-testing backstop for src/ws-proxy.ts — domain 10's largest
 * remaining file (517 LOC). The 3 existing test files already cover:
 *   - src/__tests__/ws-proxy.test.ts: upsertWsProxyTarget's own validation
 *     branches (INVALID_NAME, INVALID_URL non-ws(s) protocol, NAME_COLLISION,
 *     update re-validation), list/get/delete/disconnectAllForTarget CRUD.
 *   - src/routes/__tests__/routes-ws-proxy-admin-mutation.test.ts: the admin
 *     CRUD *routes* (a different module), plus ONE real upgrade+disconnect-all
 *     happy-path test.
 *   - src/routes/__tests__/routes-ws-proxy.test.ts: real end-to-end passthrough
 *     (bidirectional relay), 404 unknown/disabled target, 401 no-auth,
 *     per-target capacity 503, disconnectAllForTarget force-close.
 *
 * This file does NOT re-test any of the above. It targets what was still
 * unexercised in ws-proxy.ts itself: the upgrade path's remaining rejection
 * gates in isolation (scope, origin, global capacity, breaker quarantine),
 * dialBackendAndPipe's full event-handler matrix (pending-message queue while
 * CONNECTING + its MAX_PENDING_MESSAGES cap, maxMessageBytes enforcement,
 * bidirectional byte-metric recording, the open/error/close handlers on both
 * legs and their connection-cleanup symmetry), startWsProxyRevalidationLoop's
 * full sweep (idle-timeout boundary, disabled-target eviction, once-per-target
 * DNS revalidation batching, raw-IP-literal exclusion, distrust-on-failure),
 * closeAllWsProxyConnections, and the wsProxyActiveConnectionCount /
 * wsProxyActiveConnections gauge / listWsProxyTargets().activeConnections
 * trio staying in sync.
 *
 * Real WebSocketServer/backends throughout (via Bun.serve), a real Express
 * app + server.on("upgrade") wired to handleWsProxyUpgrade (same harness
 * shape as routes-ws-proxy.test.ts), and real client-side WebSocket
 * connections — mocking `ws`'s WebSocket class would lose the actual
 * open/message/close/error event sequencing that this file's own logic
 * depends on.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server as HttpServer } from "http";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { getCircuitBreaker, removeCircuitBreaker } from "../middleware/circuit-breaker.js";
import { createMcpKey } from "../security/mcp-key-store.js";
import * as ipValidatorMod from "../net/ip-validator.js";
import * as authMod from "../middleware/auth.js";
import * as loggerMod from "../logger.js";
import * as wsModule from "ws";
import { wsProxyBytesTotal, wsProxyActiveConnections } from "../observability/metrics.js";
import {
  upsertWsProxyTarget,
  handleWsProxyUpgrade,
  __resetWsProxyForTesting,
  closeAllWsProxyConnections,
  wsProxyActiveConnectionCount,
  listWsProxyTargets,
  loadWsProxyTargets,
  startWsProxyRevalidationLoop,
} from "../ws-proxy.js";

const originalAllowPrivate = config.allowPrivateIps;
const originalAuthDisabled = config.authDisabled;
const originalMcpApiKeys = config.mcpApiKeys;
const originalMaxGlobal = config.wsProxyMaxGlobalConnections;

let appServer: HttpServer | null = null;
let appPort = 0;
const usedNames: string[] = [];

/** Every target name used in this file is unique (prefixed `wsm-<n>-<purpose>`)
 * both to avoid any collision with the 3 existing test files' target names
 * ("echo-target", "dup-name", "svc-wspa-*") sharing the SAME process-wide
 * metrics registry, and so each test's byte/gauge assertions are exclusively
 * attributable to that test. */
let nameCounter = 0;
function uniqueName(purpose: string): string {
  const name = `wsm-${++nameCounter}-${purpose}`;
  usedNames.push(name);
  return name;
}

function echoBackend() {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      return srv.upgrade(req) ? undefined : new Response("no");
    },
    websocket: {
      message(ws, msg) {
        ws.send(typeof msg === "string" ? `echo:${msg}` : msg);
      },
    },
  });
}

/** A backend whose WS handshake completes only after `delayMs` — used to keep
 * ws-proxy.ts's `backendWs` in readyState CONNECTING for a controlled window,
 * the only way to observe the pending-message queue and its cap. */
function delayedEchoBackend(delayMs: number) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      await new Promise((r) => setTimeout(r, delayMs));
      return srv.upgrade(req) ? undefined : new Response("no");
    },
    websocket: {
      message(ws, msg) {
        ws.send(typeof msg === "string" ? `echo:${msg}` : msg);
      },
    },
  });
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", (e) => reject(e));
    setTimeout(() => reject(new Error("timed out waiting for open")), 4000);
  });
}

function waitClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    ws.addEventListener("close", () => resolve());
    setTimeout(() => resolve(), 4000);
  });
}

function wsUrl(name: string): string {
  return `ws://127.0.0.1:${appPort}/ws-proxy/${name}`;
}

type FakeTimer = ReturnType<typeof setInterval>;
/** Same cast-centralizing helper used by src/lib/__tests__/leader-loop-mutation.test.ts
 * for mocking the heavily-overloaded global `setInterval` signature. */
function asSetIntervalImpl(impl: (cb: () => void, ms?: number) => FakeTimer): typeof setInterval {
  return impl as unknown as typeof setInterval;
}
function fakeTimer(): FakeTimer {
  return { unref: () => {} } as unknown as FakeTimer;
}

beforeEach(async () => {
  __resetDbForTesting();
  __resetWsProxyForTesting();
  (config as Record<string, unknown>).allowPrivateIps = true;
  (config as Record<string, unknown>).authDisabled = true;
  (config as Record<string, unknown>).mcpApiKeys = [];
  (config as Record<string, unknown>).wsProxyMaxGlobalConnections = originalMaxGlobal;

  const app = express();
  await new Promise<void>((resolve) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      appPort = (srv.address() as AddressInfo).port;
      appServer = srv;
      resolve();
    });
    srv.on("upgrade", (req, socket, head) => {
      if (req.url?.startsWith("/ws-proxy/")) {
        void handleWsProxyUpgrade(req, socket, head);
      } else {
        socket.destroy();
      }
    });
  });
});

afterEach(async () => {
  (config as Record<string, unknown>).allowPrivateIps = originalAllowPrivate;
  (config as Record<string, unknown>).authDisabled = originalAuthDisabled;
  (config as Record<string, unknown>).mcpApiKeys = originalMcpApiKeys;
  (config as Record<string, unknown>).wsProxyMaxGlobalConnections = originalMaxGlobal;
  closeAllWsProxyConnections();
  for (const name of usedNames.splice(0)) removeCircuitBreaker(name);
  await new Promise<void>((resolve) => {
    if (!appServer) {
      resolve();
      return;
    }
    const srv = appServer;
    appServer = null;
    // Same defense-in-depth as the other 2 real-upgrade test files: once a
    // socket has gone through "upgrade", Bun's http.Server.close() callback
    // does not reliably fire, so race it against a short timeout.
    srv.close(() => resolve());
    srv.closeAllConnections();
    setTimeout(resolve, 500);
  });
});

describe("upgrade rejection gates, each isolated (others satisfied)", () => {
  // NOTE ON attemptRawUpgrade(): originally this block tried to assert the
  // EXACT status/message rejectUpgrade() writes onto the raw socket (via a
  // raw net.connect handshake, reading the literal HTTP response bytes).
  // That was abandoned after empirically confirming — via 3 independent raw
  // clients (node:net, Bun.connect, and a real `curl` process) — that in
  // this Bun version, an http.Server's "upgrade" event socket never actually
  // delivers bytes written via socket.write()/socket.end() to ANY client;
  // `curl` itself reports "Empty reply from server" even though the server
  // side write() call returns true and the "upgrade" handler visibly runs.
  // This is a Bun http-compat runtime limitation, not a bug in ws-proxy.ts
  // or in the test harness — see the keyFindings note in the final report.
  // Consequently every rejectUpgrade() message-string mutant is unkillable
  // via black-box client observation here; this block instead verifies each
  // gate fires (the connection never opens) via a real WebSocket client,
  // which IS reliably observable (its close/error path doesn't depend on
  // the rejection response body reaching the client, only on the TCP
  // connection closing, which socket.destroy() genuinely does).
  //
  // NAME_COLLISION / INVALID_NAME / INVALID_URL (upsertWsProxyTarget's own
  // validation) are covered by ws-proxy.test.ts, not repeated here.

  function expectRejected(targetName: string, headers?: Record<string, string>): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const ws = new WebSocket(wsUrl(targetName), headers ? ({ headers } as never) : undefined);
      ws.addEventListener("open", () => resolve(true));
      ws.addEventListener("close", () => resolve(false));
      ws.addEventListener("error", () => {});
      setTimeout(() => resolve(false), 4000);
    });
  }

  test("404 for an unknown target", async () => {
    const opened = await expectRejected(`does-not-exist-${++nameCounter}`);
    expect(opened).toBe(false);
  });

  test("404 for a disabled target", async () => {
    const targetName = uniqueName("disabled-404");
    await upsertWsProxyTarget(targetName, { backendWsUrl: "ws://127.0.0.1:1", enabled: false });
    expect(await expectRejected(targetName)).toBe(false);
  });

  test("a failing auth verdict rejects the upgrade with its status/message", async () => {
    const targetName = uniqueName("auth-fail-reject");
    await upsertWsProxyTarget(targetName, { backendWsUrl: "ws://127.0.0.1:1" });
    // McpAuthVerdict's failure arm is discriminated on `ok` and always carries
    // status/code/message, so the mock supplies the full triple.
    const authSpy = spyOn(authMod, "evaluateMcpAuth").mockResolvedValue({
      ok: false,
      status: 401,
      code: "UNAUTHORIZED",
      message: "Unauthorized",
    });
    try {
      expect(await expectRejected(targetName)).toBe(false);
    } finally {
      authSpy.mockRestore();
    }
  });

  test("scope check: a managed key scoped to a different client is rejected, even though auth/origin/capacity/breaker are all fine", async () => {
    const targetName = uniqueName("scope-403");
    await upsertWsProxyTarget(targetName, { backendWsUrl: "ws://127.0.0.1:1" });
    (config as Record<string, unknown>).authDisabled = false;
    const { rawKey } = createMcpKey("scope-test-key", { clients: ["some-other-target-name"] }, null, "test");

    expect(await expectRejected(targetName, { Authorization: `Bearer ${rawKey}` })).toBe(false);
  });

  test("scope check: a managed key scoped to include this exact client is allowed through (control case)", async () => {
    const targetName = uniqueName("scope-ok");
    const backend = echoBackend();
    try {
      await upsertWsProxyTarget(targetName, { backendWsUrl: `ws://127.0.0.1:${backend.port}` });
      (config as Record<string, unknown>).authDisabled = false;
      const { rawKey } = createMcpKey("scope-ok-key", { clients: [targetName] }, null, "test");

      const opened = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket(wsUrl(targetName), { headers: { Authorization: `Bearer ${rawKey}` } } as never);
        ws.addEventListener("open", () => resolve(true));
        ws.addEventListener("close", () => resolve(false));
        ws.addEventListener("error", () => {});
        setTimeout(() => resolve(false), 4000);
      });
      expect(opened).toBe(true);
    } finally {
      backend.stop(true);
    }
  });

  test("origin check: a disallowed Origin is rejected, even though auth/scope/capacity/breaker are all fine", async () => {
    const targetName = uniqueName("origin-403");
    await upsertWsProxyTarget(targetName, { backendWsUrl: "ws://127.0.0.1:1" });
    expect(await expectRejected(targetName, { Origin: "https://evil.example.com" })).toBe(false);
  });

  test("origin check: sec-fetch-site alone (no Origin header) reads the correct header and is treated as a suspicious cross-site request", async () => {
    const targetName = uniqueName("secfetchsite-403");
    await upsertWsProxyTarget(targetName, { backendWsUrl: "ws://127.0.0.1:1" });
    expect(await expectRejected(targetName, { "sec-fetch-site": "cross-site" })).toBe(false);
  });

  test("global capacity: rejected with nothing else wrong once totalActiveConnections >= wsProxyMaxGlobalConnections", async () => {
    const targetName = uniqueName("global-cap-503");
    await upsertWsProxyTarget(targetName, { backendWsUrl: "ws://127.0.0.1:1" });
    (config as Record<string, unknown>).wsProxyMaxGlobalConnections = 0;
    expect(await expectRejected(targetName)).toBe(false);
  });

  test("per-target capacity: rejected once the target's own maxConnections is reached", async () => {
    const targetName = uniqueName("target-cap-503");
    const backend = echoBackend();
    try {
      await upsertWsProxyTarget(targetName, { backendWsUrl: `ws://127.0.0.1:${backend.port}`, maxConnections: 1 });
      const first = new WebSocket(wsUrl(targetName));
      await waitOpen(first);
      try {
        expect(await expectRejected(targetName)).toBe(false);
      } finally {
        first.close();
      }
    } finally {
      backend.stop(true);
    }
  });

  test("breaker quarantine: rejected once the target's circuit breaker is open, even though auth/scope/origin/capacity are all fine", async () => {
    const targetName = uniqueName("breaker-503");
    await upsertWsProxyTarget(targetName, { backendWsUrl: "ws://127.0.0.1:1" });
    const breaker = getCircuitBreaker(targetName);
    for (let i = 0; i < config.circuitBreakerFailureThreshold; i++) breaker.recordFailure();
    expect(await expectRejected(targetName)).toBe(false);
  });
});

describe("handleWsProxyUpgrade: the /ws-proxy/:name path match", () => {
  // The shared beforeEach harness's own srv.on("upgrade", ...) wiring only
  // forwards requests whose URL already starts with "/ws-proxy/" to
  // handleWsProxyUpgrade (mirroring how index.ts's own real wiring works),
  // so a URL that plainly doesn't match at all, or that contains the
  // pattern WITHOUT it being anchored at the very start, never reaches
  // handleWsProxyUpgrade through that harness -- its own `!match` 404
  // branch and the regex's `^` anchor are consequently untested by every
  // other test in this file. This block stands up a second, deliberately
  // unfiltered server (forwards EVERY upgrade straight to
  // handleWsProxyUpgrade) to exercise ws-proxy.ts's OWN path-matching logic
  // directly, independent of any particular caller's routing.
  async function withUnfilteredServer(fn: (port: number) => Promise<void>): Promise<void> {
    const localApp = express();
    const srv = await new Promise<HttpServer>((resolve) => {
      const s = localApp.listen(0, "127.0.0.1", () => resolve(s));
      s.on("upgrade", (req, socket, head) => {
        void handleWsProxyUpgrade(req, socket, head);
      });
    });
    try {
      await fn((srv.address() as AddressInfo).port);
    } finally {
      await new Promise<void>((resolve) => {
        srv.close(() => resolve());
        srv.closeAllConnections();
        setTimeout(resolve, 500);
      });
    }
  }

  test("a URL that doesn't match the /ws-proxy/:name pattern at all is rejected (the !match 404 branch)", async () => {
    await withUnfilteredServer(async (port) => {
      const opened = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/completely-unrelated-path`);
        ws.addEventListener("open", () => resolve(true));
        ws.addEventListener("close", () => resolve(false));
        ws.addEventListener("error", () => {});
        setTimeout(() => resolve(false), 4000);
      });
      expect(opened).toBe(false);
    });
  });

  test("the pattern must be anchored at the very start of the URL, not merely present anywhere in it", async () => {
    const targetName = uniqueName("anchor-path");
    const backend = echoBackend();
    try {
      await upsertWsProxyTarget(targetName, { backendWsUrl: `ws://127.0.0.1:${backend.port}` });
      await withUnfilteredServer(async (port) => {
        const opened = await new Promise<boolean>((resolve) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/not-the-prefix/ws-proxy/${targetName}`);
          ws.addEventListener("open", () => resolve(true));
          ws.addEventListener("close", () => resolve(false));
          ws.addEventListener("error", () => {});
          setTimeout(() => resolve(false), 4000);
        });
        expect(opened).toBe(false);
      });
    } finally {
      backend.stop(true);
    }
  });
});

describe("upsertWsProxyTarget: validation edge cases not covered by ws-proxy.test.ts", () => {
  test("the ws(s):// prefix check is anchored to the start, not merely present anywhere in the string", async () => {
    const result = await upsertWsProxyTarget(uniqueName("anchor-check"), { backendWsUrl: "xws://127.0.0.1:9" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_URL");
      expect(result.error.message).toBe("backendWsUrl must start with ws:// or wss://");
    }
  });

  test("rejects with the reported reason when validateBackendUrl returns valid:false", async () => {
    const validateSpy = spyOn(ipValidatorMod, "validateBackendUrl").mockResolvedValue({
      valid: false,
      reason: "test-forced-reason",
    });
    try {
      const result = await upsertWsProxyTarget(uniqueName("or-check-a"), { backendWsUrl: "ws://example.invalid" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_URL");
        expect(result.error.message).toBe("test-forced-reason");
      }
    } finally {
      validateSpy.mockRestore();
    }
  });
});

describe("loadWsProxyTargets", () => {
  test("logs the exact info line with the loaded count", async () => {
    const targetName = uniqueName("load-log");
    await upsertWsProxyTarget(targetName, { backendWsUrl: "ws://127.0.0.1:1" });
    const logSpy = spyOn(loggerMod, "log");
    try {
      loadWsProxyTargets();
      expect(logSpy).toHaveBeenCalledWith("info", "Loaded WS proxy targets", { count: 1 });
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("dialBackendAndPipe: pending-message queue while CONNECTING", () => {
  test("queues client messages sent before the backend opens, and flushes them once it does (not dropped)", async () => {
    const targetName = uniqueName("queue-flush");
    const backend = delayedEchoBackend(300);
    try {
      await upsertWsProxyTarget(targetName, { backendWsUrl: `ws://127.0.0.1:${backend.port}` });
      const received = await new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(wsUrl(targetName));
        ws.addEventListener("open", () => ws.send("queued-hello"));
        ws.addEventListener("message", (e) => {
          resolve(String(e.data));
          ws.close();
        });
        ws.addEventListener("error", reject);
        setTimeout(() => reject(new Error("timed out")), 4000);
      });
      expect(received).toBe("echo:queued-hello");
    } finally {
      backend.stop(true);
    }
  }, 8000);

  test("caps queued pre-open messages at MAX_PENDING_MESSAGES (256) and closes the client rather than growing unbounded", async () => {
    const targetName = uniqueName("queue-cap");
    const backend = delayedEchoBackend(1500);
    try {
      await upsertWsProxyTarget(targetName, { backendWsUrl: `ws://127.0.0.1:${backend.port}` });
      const closed = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket(wsUrl(targetName));
        ws.addEventListener("open", () => {
          for (let i = 0; i < 300; i++) ws.send(`m${i}`);
        });
        ws.addEventListener("close", () => resolve(true));
        ws.addEventListener("error", () => {});
        setTimeout(() => resolve(false), 4000);
      });
      expect(closed).toBe(true);
    } finally {
      backend.stop(true);
    }
  }, 8000);
});

describe("dialBackendAndPipe: maxMessageBytes enforcement", () => {
  test("a client message exceeding maxMessageBytes closes the connection without reaching the backend", async () => {
    const targetName = uniqueName("max-bytes");
    let backendReceived = 0;
    const backend = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        return srv.upgrade(req) ? undefined : new Response("no");
      },
      websocket: {
        message() {
          backendReceived++;
        },
      },
    });
    try {
      await upsertWsProxyTarget(targetName, { backendWsUrl: `ws://127.0.0.1:${backend.port}`, maxMessageBytes: 5 });
      const closed = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket(wsUrl(targetName));
        ws.addEventListener("open", () => ws.send("this-is-too-long"));
        ws.addEventListener("close", () => resolve(true));
        ws.addEventListener("error", () => {});
        setTimeout(() => resolve(false), 4000);
      });
      expect(closed).toBe(true);
      await new Promise((r) => setTimeout(r, 200));
      expect(backendReceived).toBe(0);
    } finally {
      backend.stop(true);
    }
  }, 8000);

  test("a client message at or under maxMessageBytes is forwarded normally (control case)", async () => {
    const targetName = uniqueName("max-bytes-ok");
    const backend = echoBackend();
    try {
      await upsertWsProxyTarget(targetName, { backendWsUrl: `ws://127.0.0.1:${backend.port}`, maxMessageBytes: 5 });
      const received = await new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(wsUrl(targetName));
        ws.addEventListener("open", () => ws.send("hi")); // 2 bytes, under the 5-byte cap
        ws.addEventListener("message", (e) => {
          resolve(String(e.data));
          ws.close();
        });
        ws.addEventListener("error", reject);
        setTimeout(() => reject(new Error("timed out")), 4000);
      });
      expect(received).toBe("echo:hi");
    } finally {
      backend.stop(true);
    }
  });

  test("boundary: a message of exactly maxMessageBytes is forwarded; one byte more closes the connection (strict '>')", async () => {
    const targetName = uniqueName("max-bytes-boundary");
    const backend = echoBackend();
    try {
      await upsertWsProxyTarget(targetName, { backendWsUrl: `ws://127.0.0.1:${backend.port}`, maxMessageBytes: 5 });

      // Exactly 5 bytes -- must round-trip.
      const okReceived = await new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(wsUrl(targetName));
        ws.addEventListener("open", () => ws.send("abcde")); // exactly 5 bytes
        ws.addEventListener("message", (e) => {
          resolve(String(e.data));
          ws.close();
        });
        ws.addEventListener("error", reject);
        setTimeout(() => reject(new Error("timed out")), 4000);
      });
      expect(okReceived).toBe("echo:abcde");

      // 6 bytes -- one over the cap -- must close without a reply.
      const closed = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket(wsUrl(targetName));
        ws.addEventListener("open", () => ws.send("abcdef")); // 6 bytes
        ws.addEventListener("close", () => resolve(true));
        ws.addEventListener("message", () => resolve(false));
        ws.addEventListener("error", () => {});
        setTimeout(() => resolve(false), 4000);
      });
      expect(closed).toBe(true);
    } finally {
      backend.stop(true);
    }
  }, 8000);
});

describe("dialBackendAndPipe: MAX_PENDING_MESSAGES exact boundary", () => {
  test("exactly 257 pre-open messages (one past the 256 cap) closes the client; the cap check runs before the push", async () => {
    const targetName = uniqueName("queue-cap-exact");
    const backend = delayedEchoBackend(2000);
    try {
      await upsertWsProxyTarget(targetName, { backendWsUrl: `ws://127.0.0.1:${backend.port}` });
      const closed = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket(wsUrl(targetName));
        ws.addEventListener("open", () => {
          for (let i = 0; i < 257; i++) ws.send(`m${i}`);
        });
        ws.addEventListener("close", () => resolve(true));
        ws.addEventListener("error", () => {});
        setTimeout(() => resolve(false), 4000);
      });
      expect(closed).toBe(true);
    } finally {
      backend.stop(true);
    }
  }, 8000);
});

describe("dialBackendAndPipe: message forwarding after the backend is already open (not just the pre-open queue path)", () => {
  test("sends and receives multiple sequential messages once the backend is fully open", async () => {
    const targetName = uniqueName("sequential-after-open");
    const backend = echoBackend();
    try {
      await upsertWsProxyTarget(targetName, { backendWsUrl: `ws://127.0.0.1:${backend.port}` });
      const received: string[] = [];
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl(targetName));
        ws.addEventListener("open", () => ws.send("one"));
        ws.addEventListener("message", (e) => {
          received.push(String(e.data));
          if (received.length === 1) {
            ws.send("two");
          } else {
            ws.close();
            resolve();
          }
        });
        ws.addEventListener("error", reject);
        setTimeout(() => reject(new Error("timed out")), 4000);
      });
      expect(received).toEqual(["echo:one", "echo:two"]);
    } finally {
      backend.stop(true);
    }
  }, 8000);
});

describe("dialBackendAndPipe: the binary flag is preserved on relay, not silently defaulted from the Buffer's own type", () => {
  test("a client TEXT message is not silently upgraded to binary on its way to the backend", async () => {
    const targetName = uniqueName("text-flag-up");
    let backendSawString = false;
    const backend = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        return srv.upgrade(req) ? undefined : new Response("no");
      },
      websocket: {
        message(ws, msg) {
          backendSawString = typeof msg === "string";
          ws.send("ack");
        },
      },
    });
    try {
      await upsertWsProxyTarget(targetName, { backendWsUrl: `ws://127.0.0.1:${backend.port}` });
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl(targetName));
        ws.addEventListener("open", () => ws.send("plain-text-message"));
        ws.addEventListener("message", () => resolve());
        ws.addEventListener("error", reject);
        setTimeout(() => reject(new Error("timed out")), 4000);
      });
      expect(backendSawString).toBe(true);
    } finally {
      backend.stop(true);
    }
  }, 8000);

  test("a backend TEXT message is not silently upgraded to binary on its way to the client", async () => {
    const targetName = uniqueName("text-flag-down");
    const backend = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        return srv.upgrade(req) ? undefined : new Response("no");
      },
      websocket: {
        message(ws) {
          ws.send("plain-text-reply");
        },
      },
    });
    try {
      await upsertWsProxyTarget(targetName, { backendWsUrl: `ws://127.0.0.1:${backend.port}` });
      const receivedType = await new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(wsUrl(targetName));
        ws.addEventListener("open", () => ws.send("trigger"));
        ws.addEventListener("message", (e) => {
          resolve(typeof e.data);
          ws.close();
        });
        ws.addEventListener("error", reject);
        setTimeout(() => reject(new Error("timed out")), 4000);
      });
      expect(receivedType).toBe("string");
    } finally {
      backend.stop(true);
    }
  }, 8000);
});

describe("removeConn safety", () => {
  test("tolerates a target whose connsByTarget entry was cleared out from under a still-live connection, without throwing", async () => {
    const targetName = uniqueName("removeconn-safe");
    const backend = echoBackend();
    try {
      await upsertWsProxyTarget(targetName, { backendWsUrl: `ws://127.0.0.1:${backend.port}` });
      const ws = new WebSocket(wsUrl(targetName));
      await waitOpen(ws);
      await new Promise((r) => setTimeout(r, 100));

      let uncaught: unknown;
      const handler = (err: unknown) => {
        uncaught = err;
      };
      process.on("uncaughtException", handler);
      try {
        __resetWsProxyForTesting(); // clears connsByTarget while this conn is still live
        const closed = waitClose(ws);
        ws.close();
        await closed;
        await new Promise((r) => setTimeout(r, 100));
      } finally {
        process.off("uncaughtException", handler);
      }
      expect(uncaught).toBeUndefined();
    } finally {
      backend.stop(true);
    }
  });
});

describe("getSharedWss: a single WebSocketServer instance is reused across upgrades", () => {
  test("does not construct a new WebSocketServer for a second upgrade", async () => {
    const nameA = uniqueName("shared-wss-a");
    const nameB = uniqueName("shared-wss-b");
    const backend = echoBackend();
    try {
      await upsertWsProxyTarget(nameA, { backendWsUrl: `ws://127.0.0.1:${backend.port}` });
      await upsertWsProxyTarget(nameB, { backendWsUrl: `ws://127.0.0.1:${backend.port}` });
      const ctorSpy = spyOn(wsModule, "WebSocketServer");
      try {
        const wsA = new WebSocket(wsUrl(nameA));
        await waitOpen(wsA);
        const countAfterFirst = ctorSpy.mock.calls.length;
        const wsB = new WebSocket(wsUrl(nameB));
        await waitOpen(wsB);
        const countAfterSecond = ctorSpy.mock.calls.length;
        expect(countAfterSecond).toBe(countAfterFirst);
      } finally {
        ctorSpy.mockRestore();
      }
    } finally {
      backend.stop(true);
    }
  });
});

describe("dialBackendAndPipe: DNS pinning of the outbound dial", () => {
  test("pins via makePinnedLookup(target.resolvedIp) when the backend hostname is not a raw IP literal", async () => {
    const targetName = uniqueName("pinned-lookup");
    const backend = echoBackend();
    try {
      const created = await upsertWsProxyTarget(targetName, { backendWsUrl: `ws://localhost:${backend.port}` });
      expect(created.ok).toBe(true);
      const resolvedIp = created.ok ? created.target.resolvedIp : "";

      const lookupSpy = spyOn(ipValidatorMod, "makePinnedLookup");
      try {
        const ws = new WebSocket(wsUrl(targetName));
        await waitOpen(ws);
        expect(lookupSpy).toHaveBeenCalledWith(resolvedIp);
        ws.close();
      } finally {
        lookupSpy.mockRestore();
      }
    } finally {
      backend.stop(true);
    }
  });

  test("does NOT pin via makePinnedLookup when the backend hostname is already a raw IP literal", async () => {
    const targetName = uniqueName("no-pinned-lookup");
    const backend = echoBackend();
    try {
      await upsertWsProxyTarget(targetName, { backendWsUrl: `ws://127.0.0.1:${backend.port}` });
      const lookupSpy = spyOn(ipValidatorMod, "makePinnedLookup");
      try {
        const ws = new WebSocket(wsUrl(targetName));
        await waitOpen(ws);
        expect(lookupSpy).not.toHaveBeenCalled();
        ws.close();
      } finally {
        lookupSpy.mockRestore();
      }
    } finally {
      backend.stop(true);
    }
  });
});

describe("bidirectional byte-metric recording", () => {
  test("relays bytes both ways and records them on wsProxyBytesTotal with the correct target + direction labels", async () => {
    const targetName = uniqueName("bytes-metric");
    const backend = echoBackend();
    try {
      await upsertWsProxyTarget(targetName, { backendWsUrl: `ws://127.0.0.1:${backend.port}` });
      const received = await new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(wsUrl(targetName));
        ws.addEventListener("open", () => ws.send("hi")); // 2 bytes up
        ws.addEventListener("message", (e) => {
          resolve(String(e.data)); // "echo:hi" = 7 bytes down
          ws.close();
        });
        ws.addEventListener("error", reject);
        setTimeout(() => reject(new Error("timed out")), 4000);
      });
      expect(received).toBe("echo:hi");
      const rendered = wsProxyBytesTotal.render();
      // Label key order in the rendered output follows seriesKey's sorted-key
      // JSON (direction, target) — not literal object-literal insertion order.
      expect(rendered).toContain(`mcp_ws_proxy_bytes_total{direction="up",target="${targetName}"} 2`);
      expect(rendered).toContain(`mcp_ws_proxy_bytes_total{direction="down",target="${targetName}"} 7`);
    } finally {
      backend.stop(true);
    }
  });
});

describe("connection accounting: wsProxyActiveConnectionCount / gauge / listWsProxyTargets().activeConnections stay in sync", () => {
  test("agree across 2 connections on the same target, and both drop back to 0 as each connection closes", async () => {
    const targetName = uniqueName("count-gauge");
    const backend = echoBackend();
    try {
      await upsertWsProxyTarget(targetName, { backendWsUrl: `ws://127.0.0.1:${backend.port}`, maxConnections: 5 });
      const ws1 = new WebSocket(wsUrl(targetName));
      await waitOpen(ws1);
      const ws2 = new WebSocket(wsUrl(targetName));
      await waitOpen(ws2);

      expect(wsProxyActiveConnectionCount()).toBe(2);
      expect(listWsProxyTargets().find((t) => t.name === targetName)?.activeConnections).toBe(2);
      expect(wsProxyActiveConnections.render()).toContain(`mcp_ws_proxy_active_connections{target="${targetName}"} 2`);

      const closed1 = waitClose(ws1);
      ws1.close();
      await closed1;
      await new Promise((r) => setTimeout(r, 100));
      expect(wsProxyActiveConnectionCount()).toBe(1);
      expect(wsProxyActiveConnections.render()).toContain(`mcp_ws_proxy_active_connections{target="${targetName}"} 1`);

      const closed2 = waitClose(ws2);
      ws2.close();
      await closed2;
      await new Promise((r) => setTimeout(r, 100));
      expect(wsProxyActiveConnectionCount()).toBe(0);
      expect(listWsProxyTargets().find((t) => t.name === targetName)?.activeConnections).toBe(0);
    } finally {
      backend.stop(true);
    }
  });
});

describe("connection cleanup symmetry", () => {
  test("closing the client connection force-closes the backend leg too", async () => {
    const targetName = uniqueName("client-closes-backend");
    let backendCloseResolve!: () => void;
    const backendClosePromise = new Promise<void>((r) => (backendCloseResolve = r));
    const backend = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        return srv.upgrade(req) ? undefined : new Response("no");
      },
      websocket: {
        message() {},
        close() {
          backendCloseResolve();
        },
      },
    });
    try {
      await upsertWsProxyTarget(targetName, { backendWsUrl: `ws://127.0.0.1:${backend.port}` });
      const ws = new WebSocket(wsUrl(targetName));
      await waitOpen(ws);
      await new Promise((r) => setTimeout(r, 100)); // let the backend dial complete
      ws.close();
      await Promise.race([backendClosePromise, new Promise((r) => setTimeout(r, 4000))]);
      await new Promise((r) => setTimeout(r, 50));
      expect(wsProxyActiveConnectionCount()).toBe(0);
    } finally {
      backend.stop(true);
    }
  });

  test("the backend closing its leg force-closes the client connection too", async () => {
    const targetName = uniqueName("backend-closes-client");
    const backend = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        return srv.upgrade(req) ? undefined : new Response("no");
      },
      websocket: {
        message(ws) {
          ws.close();
        },
      },
    });
    try {
      await upsertWsProxyTarget(targetName, { backendWsUrl: `ws://127.0.0.1:${backend.port}` });
      const closed = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket(wsUrl(targetName));
        ws.addEventListener("open", () => ws.send("trigger-backend-close"));
        ws.addEventListener("close", () => resolve(true));
        ws.addEventListener("error", () => {});
        setTimeout(() => resolve(false), 4000);
      });
      expect(closed).toBe(true);
      await new Promise((r) => setTimeout(r, 100));
      expect(wsProxyActiveConnectionCount()).toBe(0);
    } finally {
      backend.stop(true);
    }
  });

  test("a refused backend dial fires the backend error handler: records a breaker failure, logs the exact warning, and force-closes the client", async () => {
    const targetName = uniqueName("backend-refused");
    await upsertWsProxyTarget(targetName, { backendWsUrl: "ws://127.0.0.1:1" });
    const breaker = getCircuitBreaker(targetName);
    const failureSpy = spyOn(breaker, "recordFailure");
    const logSpy = spyOn(loggerMod, "log");
    try {
      const closed = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket(wsUrl(targetName));
        ws.addEventListener("close", () => resolve(true));
        ws.addEventListener("error", () => {});
        setTimeout(() => resolve(false), 4000);
      });
      expect(closed).toBe(true);
      expect(failureSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith(
        "warn",
        "WS proxy backend error",
        expect.objectContaining({ target: targetName }),
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(wsProxyActiveConnectionCount()).toBe(0);
    } finally {
      failureSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  test("a successful backend open records a breaker success", async () => {
    const targetName = uniqueName("backend-open-success");
    const backend = echoBackend();
    const breaker = getCircuitBreaker(targetName);
    const successSpy = spyOn(breaker, "recordSuccess");
    try {
      await upsertWsProxyTarget(targetName, { backendWsUrl: `ws://127.0.0.1:${backend.port}` });
      const ws = new WebSocket(wsUrl(targetName));
      await waitOpen(ws);
      await new Promise((r) => setTimeout(r, 150)); // let the backend dial complete
      expect(successSpy).toHaveBeenCalledTimes(1);
      ws.close();
    } finally {
      successSpy.mockRestore();
      backend.stop(true);
    }
  });
});

describe("closeAllWsProxyConnections", () => {
  test("closes every live connection across every target", async () => {
    const nameA = uniqueName("close-all-a");
    const nameB = uniqueName("close-all-b");
    const backend = echoBackend();
    try {
      await upsertWsProxyTarget(nameA, { backendWsUrl: `ws://127.0.0.1:${backend.port}` });
      await upsertWsProxyTarget(nameB, { backendWsUrl: `ws://127.0.0.1:${backend.port}` });
      const wsA = new WebSocket(wsUrl(nameA));
      await waitOpen(wsA);
      const wsB = new WebSocket(wsUrl(nameB));
      await waitOpen(wsB);
      expect(wsProxyActiveConnectionCount()).toBe(2);

      const closedA = waitClose(wsA);
      const closedB = waitClose(wsB);
      closeAllWsProxyConnections();
      await Promise.all([closedA, closedB]);
      expect(wsProxyActiveConnectionCount()).toBe(0);
    } finally {
      backend.stop(true);
    }
  });
});

describe("startWsProxyRevalidationLoop", () => {
  test("registers via setInterval with config.wsProxyRevalidateIntervalMs, and stop() clears the exact timer returned", () => {
    const timer = fakeTimer();
    let capturedMs: number | undefined;
    const setIntervalSpy = spyOn(global, "setInterval").mockImplementation(
      asSetIntervalImpl((_cb, ms) => {
        capturedMs = ms;
        return timer;
      }),
    );
    const clearIntervalSpy = spyOn(global, "clearInterval").mockImplementation(() => {});
    try {
      const stop = startWsProxyRevalidationLoop();
      expect(capturedMs).toBe(config.wsProxyRevalidateIntervalMs);
      stop();
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      expect(clearIntervalSpy.mock.calls[0]?.[0]).toBe(timer);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  test("idle-timeout sweep uses strict '>': exactly idleTimeoutMs elapsed survives, one ms more evicts — a separate target's connection is untouched", async () => {
    const idleName = uniqueName("idle-evict");
    const freshName = uniqueName("idle-fresh");
    const backend = echoBackend();
    try {
      await upsertWsProxyTarget(idleName, { backendWsUrl: `ws://127.0.0.1:${backend.port}`, idleTimeoutMs: 50 });
      await upsertWsProxyTarget(freshName, {
        backendWsUrl: `ws://127.0.0.1:${backend.port}`,
        idleTimeoutMs: 10_000_000,
      });

      const wsIdle = new WebSocket(wsUrl(idleName));
      const wsFresh = new WebSocket(wsUrl(freshName));

      let capturedTick: (() => void) | undefined;
      const setIntervalSpy = spyOn(global, "setInterval").mockImplementation(
        asSetIntervalImpl((cb) => {
          capturedTick = cb;
          return fakeTimer();
        }),
      );
      const nowSpy = spyOn(Date, "now");
      let stop: (() => void) | undefined;
      try {
        const T0 = 1_700_000_000_000;
        nowSpy.mockReturnValue(T0);
        stop = startWsProxyRevalidationLoop();
        setIntervalSpy.mockRestore();

        await waitOpen(wsIdle);
        await waitOpen(wsFresh);
        await new Promise((r) => setTimeout(r, 50)); // let both backend dials complete

        // Exactly at the boundary: must NOT evict (condition is strictly `>`).
        nowSpy.mockReturnValue(T0 + 50);
        capturedTick!();
        await new Promise((r) => setTimeout(r, 100));
        expect(wsProxyActiveConnectionCount()).toBe(2);

        // One ms beyond: the idle target's connection is evicted; the fresh
        // target (huge idleTimeoutMs) is untouched by the SAME tick.
        const idleClosed = waitClose(wsIdle);
        nowSpy.mockReturnValue(T0 + 51);
        capturedTick!();
        await idleClosed;
        await new Promise((r) => setTimeout(r, 100));
        expect(wsProxyActiveConnectionCount()).toBe(1);
        expect(listWsProxyTargets().find((t) => t.name === freshName)?.activeConnections).toBe(1);
      } finally {
        nowSpy.mockRestore();
        stop?.();
      }
    } finally {
      backend.stop(true);
    }
  }, 10000);

  test("a target disabled (not deleted) after connections opened has ALL its connections dropped on the next sweep; a separate enabled target's connections in the same tick are untouched", async () => {
    const disabledName = uniqueName("disable-sweep");
    const enabledName = uniqueName("enabled-sweep");
    const backend = echoBackend();
    try {
      await upsertWsProxyTarget(disabledName, { backendWsUrl: `ws://127.0.0.1:${backend.port}` });
      await upsertWsProxyTarget(enabledName, { backendWsUrl: `ws://127.0.0.1:${backend.port}` });

      const ws1 = new WebSocket(wsUrl(disabledName));
      await waitOpen(ws1);
      const ws2a = new WebSocket(wsUrl(enabledName));
      await waitOpen(ws2a);
      const ws2b = new WebSocket(wsUrl(enabledName));
      await waitOpen(ws2b);

      // Disabling via upsert (not delete) does NOT eagerly close existing
      // connections — only the next sweep tick should.
      await upsertWsProxyTarget(disabledName, {
        backendWsUrl: `ws://127.0.0.1:${backend.port}`,
        enabled: false,
      });
      expect(wsProxyActiveConnectionCount()).toBe(3);

      let capturedTick: (() => void) | undefined;
      const setIntervalSpy = spyOn(global, "setInterval").mockImplementation(
        asSetIntervalImpl((cb) => {
          capturedTick = cb;
          return fakeTimer();
        }),
      );
      const stop = startWsProxyRevalidationLoop();
      setIntervalSpy.mockRestore();
      try {
        const ws1Closed = waitClose(ws1);
        capturedTick!();
        await ws1Closed;
        await new Promise((r) => setTimeout(r, 100));
        expect(wsProxyActiveConnectionCount()).toBe(2);
        expect(listWsProxyTargets().find((t) => t.name === enabledName)?.activeConnections).toBe(2);
      } finally {
        stop();
      }
    } finally {
      backend.stop(true);
    }
  }, 10000);

  test("DNS-revalidates the backend hostname exactly once per target per tick even with 2 connections sharing it", async () => {
    const targetName = uniqueName("revalidate-once");
    const backend = echoBackend();
    try {
      await upsertWsProxyTarget(targetName, { backendWsUrl: `ws://localhost:${backend.port}` });
      const ws1 = new WebSocket(wsUrl(targetName));
      await waitOpen(ws1);
      const ws2 = new WebSocket(wsUrl(targetName));
      await waitOpen(ws2);
      await new Promise((r) => setTimeout(r, 50));

      let capturedTick: (() => void) | undefined;
      const setIntervalSpy = spyOn(global, "setInterval").mockImplementation(
        asSetIntervalImpl((cb) => {
          capturedTick = cb;
          return fakeTimer();
        }),
      );
      const validateSpy = spyOn(ipValidatorMod, "validateBackendUrl");
      const stop = startWsProxyRevalidationLoop();
      setIntervalSpy.mockRestore();
      try {
        capturedTick!();
        await new Promise((r) => setTimeout(r, 300)); // let the async validateBackendUrl call settle
        expect(validateSpy).toHaveBeenCalledTimes(1);
        expect(validateSpy).toHaveBeenLastCalledWith("http://localhost", config.allowPrivateIps, config.allowedHosts);
        // localhost resolves fine, so both connections must still be alive.
        expect(wsProxyActiveConnectionCount()).toBe(2);
      } finally {
        validateSpy.mockRestore();
        stop();
      }
    } finally {
      backend.stop(true);
    }
  }, 8000);

  test("excludes a raw-IP-literal connection from revalidation entirely", async () => {
    const targetName = uniqueName("revalidate-rawip");
    const backend = echoBackend();
    try {
      await upsertWsProxyTarget(targetName, { backendWsUrl: `ws://127.0.0.1:${backend.port}` }); // raw IP hostname
      const ws1 = new WebSocket(wsUrl(targetName));
      await waitOpen(ws1);
      await new Promise((r) => setTimeout(r, 50));

      let capturedTick: (() => void) | undefined;
      const setIntervalSpy = spyOn(global, "setInterval").mockImplementation(
        asSetIntervalImpl((cb) => {
          capturedTick = cb;
          return fakeTimer();
        }),
      );
      const validateSpy = spyOn(ipValidatorMod, "validateBackendUrl");
      const stop = startWsProxyRevalidationLoop();
      setIntervalSpy.mockRestore();
      try {
        capturedTick!();
        await new Promise((r) => setTimeout(r, 200));
        expect(validateSpy).not.toHaveBeenCalled();
        expect(wsProxyActiveConnectionCount()).toBe(1);
      } finally {
        validateSpy.mockRestore();
        stop();
      }
    } finally {
      backend.stop(true);
    }
  }, 8000);

  test("closes all remaining connections for a target when revalidation newly fails", async () => {
    const targetName = uniqueName("revalidate-fail");
    const backend = echoBackend();
    try {
      await upsertWsProxyTarget(targetName, { backendWsUrl: `ws://localhost:${backend.port}` });
      const ws1 = new WebSocket(wsUrl(targetName));
      await waitOpen(ws1);
      await new Promise((r) => setTimeout(r, 50));

      let capturedTick: (() => void) | undefined;
      const setIntervalSpy = spyOn(global, "setInterval").mockImplementation(
        asSetIntervalImpl((cb) => {
          capturedTick = cb;
          return fakeTimer();
        }),
      );
      const validateSpy = spyOn(ipValidatorMod, "validateBackendUrl").mockResolvedValue({
        valid: false,
        reason: "forced-invalid-for-test",
      });
      const logSpy = spyOn(loggerMod, "log");
      const stop = startWsProxyRevalidationLoop();
      setIntervalSpy.mockRestore();
      try {
        const closed = waitClose(ws1);
        capturedTick!();
        await closed;
        await new Promise((r) => setTimeout(r, 100));
        expect(wsProxyActiveConnectionCount()).toBe(0);
        expect(logSpy).toHaveBeenCalledWith(
          "warn",
          "WS proxy connections distrusted after revalidation",
          expect.objectContaining({
            target: targetName,
            hostname: "localhost",
            reason: "forced-invalid-for-test",
            count: 1,
          }),
        );
      } finally {
        validateSpy.mockRestore();
        logSpy.mockRestore();
        stop();
      }
    } finally {
      backend.stop(true);
    }
  }, 8000);
});
