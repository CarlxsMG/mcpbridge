import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { registry } from "../mcp/registry.js";
import { removeCircuitBreaker } from "../middleware/circuit-breaker.js";
import {
  upsertWsProxyTarget,
  listWsProxyTargets,
  getWsProxyTargetDetail,
  deleteWsProxyTarget,
  disconnectAllForTarget,
  loadWsProxyTargets,
  __resetWsProxyForTesting,
} from "../ws-proxy.js";
import type { RestToolDefinition } from "../mcp/types.js";

const originalAllowPrivate = config.allowPrivateIps;

function makeTool(): RestToolDefinition {
  return {
    name: "get-x",
    method: "GET",
    endpoint: "/x",
    description: "x",
    inputSchema: { type: "object", properties: {} },
  };
}

beforeEach(async () => {
  __resetDbForTesting();
  __resetWsProxyForTesting();
  for (const c of registry.listClients()) await registry.unregister(c.name);
  (config as Record<string, unknown>).allowPrivateIps = true;
});
afterEach(async () => {
  (config as Record<string, unknown>).allowPrivateIps = originalAllowPrivate;
  for (const c of registry.listClients()) await registry.unregister(c.name);
  removeCircuitBreaker("echo-target");
  removeCircuitBreaker("dup-name");
});

describe("upsertWsProxyTarget", () => {
  test("creates a target with defaults, persists, and round-trips via loadWsProxyTargets", async () => {
    const result = await upsertWsProxyTarget("echo-target", { backendWsUrl: "ws://127.0.0.1:9" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.maxConnections).toBe(config.wsProxyDefaultMaxConnectionsPerTarget);
    expect(result.target.enabled).toBe(true);

    __resetWsProxyForTesting();
    loadWsProxyTargets();
    expect(getWsProxyTargetDetail("echo-target")?.backendWsUrl).toBe("ws://127.0.0.1:9");
  });

  test("rejects an invalid name", async () => {
    const result = await upsertWsProxyTarget("Not Valid!", { backendWsUrl: "ws://127.0.0.1:9" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_NAME");
  });

  test("rejects a non-ws(s) URL", async () => {
    const result = await upsertWsProxyTarget("echo-target", { backendWsUrl: "http://127.0.0.1:9" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_URL");
  });

  test("rejects a name that collides with an existing MCP/REST client", async () => {
    await registry.register("dup-name", [makeTool()], "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
    const result = await upsertWsProxyTarget("dup-name", { backendWsUrl: "ws://127.0.0.1:9" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NAME_COLLISION");
  });

  test("update re-validates the URL and overwrites fields", async () => {
    await upsertWsProxyTarget("echo-target", { backendWsUrl: "ws://127.0.0.1:9" });
    const updated = await upsertWsProxyTarget("echo-target", { backendWsUrl: "ws://127.0.0.1:10", maxConnections: 3 });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.target.backendWsUrl).toBe("ws://127.0.0.1:10");
      expect(updated.target.maxConnections).toBe(3);
    }
  });
});

describe("listWsProxyTargets / getWsProxyTargetDetail / deleteWsProxyTarget", () => {
  test("list and get reflect activeConnections (0 with nothing connected)", async () => {
    await upsertWsProxyTarget("echo-target", { backendWsUrl: "ws://127.0.0.1:9" });
    expect(listWsProxyTargets().find((t) => t.name === "echo-target")?.activeConnections).toBe(0);
    expect(getWsProxyTargetDetail("echo-target")?.activeConnections).toBe(0);
  });

  test("delete removes the target and is idempotent-false on a second call", async () => {
    await upsertWsProxyTarget("echo-target", { backendWsUrl: "ws://127.0.0.1:9" });
    expect(deleteWsProxyTarget("echo-target")).toBe(true);
    expect(getWsProxyTargetDetail("echo-target")).toBeUndefined();
    expect(deleteWsProxyTarget("echo-target")).toBe(false);
  });

  test("disconnectAllForTarget on a target with no connections returns 0", async () => {
    await upsertWsProxyTarget("echo-target", { backendWsUrl: "ws://127.0.0.1:9" });
    expect(disconnectAllForTarget("echo-target")).toBe(0);
  });
});
