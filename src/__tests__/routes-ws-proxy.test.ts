/**
 * End-to-end WS passthrough tests: a real Express app with server.on("upgrade")
 * wired to handleWsProxyUpgrade, a Bun.serve WS echo backend (same pattern as
 * backends.test.ts's tool_ws tests), and a real WebSocket client.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server as HttpServer } from "http";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { removeCircuitBreaker } from "../middleware/circuit-breaker.js";
import {
  upsertWsProxyTarget,
  handleWsProxyUpgrade,
  __resetWsProxyForTesting,
  disconnectAllForTarget,
} from "../ws-proxy.js";

const originalAllowPrivate = config.allowPrivateIps;
const originalMcpApiKeys = config.mcpApiKeys;
const originalAuthDisabled = config.authDisabled;

let appServer: HttpServer | null = null;
let appPort = 0;
let backend: ReturnType<typeof echoBackend> | null = null;

function echoBackend() {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      return srv.upgrade(req) ? undefined : new Response("no");
    },
    websocket: {
      message(ws, msg) {
        ws.send(`echo:${msg}`);
      },
    },
  });
}

async function startApp(): Promise<void> {
  __resetDbForTesting();
  __resetWsProxyForTesting();
  (config as Record<string, unknown>).allowPrivateIps = true;
  (config as Record<string, unknown>).authDisabled = true;

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
}

beforeEach(() => {
  backend = echoBackend();
});

afterEach(async () => {
  (config as Record<string, unknown>).allowPrivateIps = originalAllowPrivate;
  (config as Record<string, unknown>).mcpApiKeys = originalMcpApiKeys;
  (config as Record<string, unknown>).authDisabled = originalAuthDisabled;
  backend?.stop(true);
  removeCircuitBreaker("echo-target");
  await new Promise<void>((resolve) => {
    if (!appServer) {
      resolve();
      return;
    }
    const srv = appServer;
    appServer = null;
    // Bun's http.Server.close() callback does not reliably fire once a
    // socket has gone through the "upgrade" event (it's handed off to `ws`
    // and no longer tracked as a normal request/connection) — same
    // defense-in-depth as index.ts's own gracefulShutdown force-exit timer:
    // race close() against a short timeout so a real Bun quirk here never
    // hangs the suite.
    srv.close(() => resolve());
    srv.closeAllConnections();
    setTimeout(resolve, 500);
  });
});

function connect(name: string, headers?: Record<string, string>): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${appPort}/ws-proxy/${name}`, headers ? ({ headers } as never) : undefined);
}

describe("WS proxy passthrough", () => {
  test("relays messages bidirectionally through to the backend and back", async () => {
    await startApp();
    await upsertWsProxyTarget("echo-target", { backendWsUrl: `ws://127.0.0.1:${backend!.port}` });

    const received = await new Promise<string>((resolve, reject) => {
      const ws = connect("echo-target");
      ws.addEventListener("open", () => ws.send("hello"));
      ws.addEventListener("message", (e) => {
        resolve(String(e.data));
        ws.close();
      });
      ws.addEventListener("error", reject);
      setTimeout(() => reject(new Error("timed out")), 4000);
    });
    expect(received).toBe("echo:hello");
  });

  test("404 for an unknown target", async () => {
    await startApp();
    const closeCode = await new Promise<number>((resolve) => {
      const ws = connect("does-not-exist");
      ws.addEventListener("close", (e) => resolve(e.code));
      ws.addEventListener("error", () => {});
      setTimeout(() => resolve(-1), 4000);
    });
    // A rejected upgrade never completes the WS handshake — the browser-style
    // WebSocket surfaces this as an error/close, never an "open".
    expect(closeCode).not.toBe(1000);
  });

  test("404 for a disabled target", async () => {
    await startApp();
    await upsertWsProxyTarget("echo-target", { backendWsUrl: `ws://127.0.0.1:${backend!.port}`, enabled: false });
    const opened = await new Promise<boolean>((resolve) => {
      const ws = connect("echo-target");
      ws.addEventListener("open", () => resolve(true));
      ws.addEventListener("close", () => resolve(false));
      ws.addEventListener("error", () => {});
      setTimeout(() => resolve(false), 4000);
    });
    expect(opened).toBe(false);
  });

  test("requires auth when MCP keys are configured", async () => {
    await startApp();
    (config as Record<string, unknown>).authDisabled = false;
    (config as Record<string, unknown>).mcpApiKeys = ["required-key"];
    await upsertWsProxyTarget("echo-target", { backendWsUrl: `ws://127.0.0.1:${backend!.port}` });

    const opened = await new Promise<boolean>((resolve) => {
      const ws = connect("echo-target");
      ws.addEventListener("open", () => resolve(true));
      ws.addEventListener("close", () => resolve(false));
      ws.addEventListener("error", () => {});
      setTimeout(() => resolve(false), 4000);
    });
    expect(opened).toBe(false);
  });

  test("enforces the per-target connection cap", async () => {
    await startApp();
    await upsertWsProxyTarget("echo-target", { backendWsUrl: `ws://127.0.0.1:${backend!.port}`, maxConnections: 1 });

    const first = connect("echo-target");
    await new Promise<void>((resolve, reject) => {
      first.addEventListener("open", () => resolve());
      first.addEventListener("error", reject);
      setTimeout(() => reject(new Error("timed out")), 4000);
    });

    const secondRejected = await new Promise<boolean>((resolve) => {
      const second = connect("echo-target");
      second.addEventListener("open", () => resolve(false));
      second.addEventListener("close", () => resolve(true));
      second.addEventListener("error", () => {});
      setTimeout(() => resolve(false), 4000);
    });
    expect(secondRejected).toBe(true);
    first.close();
  });

  test("disconnectAllForTarget force-closes a live connection", async () => {
    await startApp();
    await upsertWsProxyTarget("echo-target", { backendWsUrl: `ws://127.0.0.1:${backend!.port}` });

    const ws = connect("echo-target");
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", reject);
      setTimeout(() => reject(new Error("timed out")), 4000);
    });

    const closed = await new Promise<boolean>((resolve) => {
      ws.addEventListener("close", () => resolve(true));
      disconnectAllForTarget("echo-target");
      setTimeout(() => resolve(false), 4000);
    });
    expect(closed).toBe(true);
  });
});
