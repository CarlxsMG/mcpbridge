/**
 * Mutation backstop for proxy.ts's dispatchWsToolCall (L1199-1266): the
 * WS-backed tool-call path (non-persistent + persistent), reached end-to-end
 * through the public proxyToolCall entry point — breaker success/failure
 * recording, usage/metrics recording, and the WS-failure error-message
 * format. See src/proxy/__tests__/backends.test.ts for the base WS
 * round-trip/persistent-mode coverage this file builds on (that file does
 * not exercise breaker/metrics recording, which is this cluster's focus).
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { registry } from "../../mcp/registry.js";
import { removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import { config } from "../../config.js";
import { __resetDbForTesting, getDb } from "../../db/connection.js";
import { proxyToolCall } from "../../proxy/proxy.js";
import { setToolWs } from "../../proxy/backends.js";
import { proxyRequestDuration, getLegacyMetricsSnapshot } from "../../observability/metrics.js";
import { createMcpKey } from "../../security/mcp-key-store.js";
import type { RestToolDefinition } from "../../mcp/types.js";

// Registry client names must match /^[a-z0-9][a-z0-9_-]{0,62}$/ (lowercase only),
// so the assigned "mutC12ws" prefix is used here in its lowercase form.
const CLIENT = "mutc12ws";

function makeWsTool(name = "wst"): RestToolDefinition {
  return {
    name,
    method: "POST",
    endpoint: "/ws",
    description: "ws tool",
    inputSchema: { type: "object", properties: { msg: { type: "string" } } },
  };
}

const usedClients = new Set<string>();
async function reg(name: string, tools: RestToolDefinition[] = [makeWsTool()]): Promise<void> {
  usedClients.add(name);
  await registry.register(name, tools, "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}

interface LogRow {
  status_class: string;
  is_error: number;
  key_id: number | null;
  duration_ms: number;
}
function lastLogRow(clientName: string): LogRow | null {
  return getDb()
    .query(
      `SELECT status_class, is_error, key_id, duration_ms FROM tool_call_log WHERE client_name = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(clientName) as LogRow | null;
}

const origAllowPrivateIps = config.allowPrivateIps;
function resetAll(): void {
  (config as Record<string, unknown>).retryMaxAttempts = 0;
  (config as Record<string, unknown>).retryBaseDelayMs = 1;
  (config as Record<string, unknown>).allowPrivateIps = origAllowPrivateIps;
  __resetDbForTesting();
  for (const name of usedClients) removeCircuitBreaker(name);
  usedClients.clear();
}
beforeEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  resetAll();
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  resetAll();
});

describe("dispatchWsToolCall — success path", () => {
  test("round-trip records success metrics/usage with real values (kills L1234, L1235, L1236, L1239, L1240, L1241, L1244)", async () => {
    const name = `${CLIENT}-ok`;
    await reg(name);
    (config as Record<string, unknown>).allowPrivateIps = true;
    const { record, rawKey } = createMcpKey("ws-ok", null, null, null);

    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        return srv.upgrade(req) ? undefined : new Response("no");
      },
      websocket: {
        message(ws, msg) {
          ws.send(`pong:${msg}`);
        },
      },
    });
    try {
      const setRes = await setToolWs(name, "wst", { enabled: true, wsUrl: `ws://localhost:${server.port}` });
      expect(setRes.ok).toBe(true);

      const before = getLegacyMetricsSnapshot();
      const obsSpy = spyOn(proxyRequestDuration, "observe");
      const r = await proxyToolCall(`${name}__wst`, { msg: "hi" }, rawKey);
      const after = getLegacyMetricsSnapshot();

      expect(r.isError).toBeUndefined();
      expect(r.content[0].text).toBe('pong:{"msg":"hi"}');

      // Kills L1235 (recordToolCall isError arg: mutant 'true' would bump errorToolCalls on success).
      expect(after.totalToolCalls - before.totalToolCalls).toBe(1);
      expect(after.errorToolCalls - before.errorToolCalls).toBe(0);

      const row = lastLogRow(name);
      expect(row).not.toBeNull();
      // Kills L1236 (recordUsage args replaced by `{}`: required fields become undefined,
      // the STRICT-table insert throws inside recordUsage's own try/catch, and no row lands
      // — `row` would be null instead of matching the assertions below).
      // Kills L1240 (statusClass StringLiteral '') and L1241 (isError BooleanLiteral 'true').
      expect(row?.status_class).toBe("2xx");
      expect(row?.is_error).toBe(0);
      // Kills L1239 (`callerKey?.id ?? null` -> `callerKey?.id && null`): with a real,
      // truthy key id the mutant collapses the stored keyId to null instead of the real id.
      expect(row?.key_id).toBe(record.id);
      // Kills L1234 (`Date.now() + startTime` instead of `- startTime`): the mutant produces
      // a duration around 2x the current epoch ms (trillions), astronomically over this bound.
      expect(row!.duration_ms).toBeGreaterThanOrEqual(0);
      expect(row!.duration_ms).toBeLessThan(10_000);

      // Kills L1244 (proxyRequestDuration.observe: ObjectLiteral '{}', StringLiterals '',
      // and ArithmeticOperator '*1000' instead of '/1000' on the success observe call).
      expect(obsSpy).toHaveBeenCalledTimes(1);
      const [labels, value] = obsSpy.mock.calls[0] as [Record<string, string>, number];
      expect(labels).toEqual({ client: name, method: "WS", status_class: "2xx" });
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(5); // seconds; a `*1000` mutant would push this into the thousands
      obsSpy.mockRestore();
    } finally {
      server.stop(true);
    }
  });
});

describe("dispatchWsToolCall — persistent mode onProgress forwarding", () => {
  test("forwards every intermediate message via onProgress, then resolves with the last one (kills L1230)", async () => {
    const name = `${CLIENT}-persist`;
    await reg(name);
    (config as Record<string, unknown>).allowPrivateIps = true;

    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        return srv.upgrade(req) ? undefined : new Response("no");
      },
      websocket: {
        message(ws, msg) {
          ws.send(`first:${msg}`);
          setTimeout(() => ws.send(`second:${msg}`), 10);
          setTimeout(() => {
            ws.send(`third:${msg}`);
            ws.close();
          }, 20);
        },
      },
    });
    try {
      const setRes = await setToolWs(name, "wst", {
        enabled: true,
        wsUrl: `ws://localhost:${server.port}`,
        persistent: true,
      });
      expect(setRes.ok).toBe(true);

      const captured: string[] = [];
      const r = await proxyToolCall(`${name}__wst`, { msg: "hi" }, undefined, {
        onProgress: (_progress, _total, message) => {
          if (message !== undefined) captured.push(message);
        },
      });

      expect(r.isError).toBeUndefined();
      expect(r.content[0].text).toBe('third:{"msg":"hi"}');
      // Kills L1230 (the forwarding callback replaced by `() => undefined`): without real
      // forwarding to wsRequestPersistent's onMessage, `captured` would stay empty.
      expect(captured).toEqual(['first:{"msg":"hi"}', 'second:{"msg":"hi"}', 'third:{"msg":"hi"}']);
    } finally {
      server.stop(true);
    }
  });
});

describe("dispatchWsToolCall — failure path", () => {
  test("connection closed before a message: exact error text, usage row, and breaker opens (kills L1246, L1248, L1249, L1250, L1253, L1254, L1255, L1258, L1260, L1261)", async () => {
    const name = `${CLIENT}-fail`;
    await reg(name);
    (config as Record<string, unknown>).allowPrivateIps = true;
    await registry.setClientGuards(name, { circuitBreaker: { failureThreshold: 1 } });

    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        return srv.upgrade(req) ? undefined : new Response("no");
      },
      websocket: {
        message() {
          /* never sends — the connection is closed on open */
        },
        open(ws) {
          ws.close();
        },
      },
    });
    try {
      const setRes = await setToolWs(name, "wst", { enabled: true, wsUrl: `ws://localhost:${server.port}` });
      expect(setRes.ok).toBe(true);

      const before = getLegacyMetricsSnapshot();
      const obsSpy = spyOn(proxyRequestDuration, "observe");
      // No caller token -> callerKey resolves to null inside dispatchToolCall/dispatchWsToolCall.
      // This also proves L1253's `?.` is load-bearing: a mutant that drops it would throw
      // accessing `.id` on null instead of resolving normally with a `true` isError result.
      const r = await proxyToolCall(`${name}__wst`, { msg: "hi" });
      const after = getLegacyMetricsSnapshot();

      // Kills L1261 (final toolResult opts replaced by `{}` or `isError: false`).
      expect(r.isError).toBe(true);
      // Kills L1260 (template literal replaced by an empty string): exact message shape.
      expect(r.content[0].text).toBe(`WebSocket call failed for '${name}': WebSocket closed before a response`);

      // Kills L1249 (recordToolCall isError arg: mutant 'false' would NOT bump errorToolCalls).
      expect(after.totalToolCalls - before.totalToolCalls).toBe(1);
      expect(after.errorToolCalls - before.errorToolCalls).toBe(1);

      const row = lastLogRow(name);
      expect(row).not.toBeNull();
      // Kills L1250 (recordUsage args replaced by `{}`: STRICT-table insert throws and is
      // swallowed by recordUsage's own try/catch, so `row` would be null instead).
      // Kills L1254 (statusClass StringLiteral '') and L1255 (isError BooleanLiteral 'false').
      expect(row?.status_class).toBe("error");
      expect(row?.is_error).toBe(1);
      // Kills L1253 (`callerKey?.id ?? null` -> dropped `?.` [would throw before this point]
      // or -> `&& null` [with callerKey null, `undefined && null` binds `undefined`, which the
      // STRICT table rejects, so recordUsage silently drops the row and `row` would be null]).
      expect(row?.key_id).toBeNull();
      // Kills L1248 (`Date.now() + startTime` instead of `- startTime`).
      expect(row!.duration_ms).toBeGreaterThanOrEqual(0);
      expect(row!.duration_ms).toBeLessThan(10_000);

      // Kills L1258 (proxyRequestDuration.observe: ObjectLiteral '{}', StringLiterals '',
      // and ArithmeticOperator '*1000' instead of '/1000' on the failure observe call).
      expect(obsSpy).toHaveBeenCalledTimes(1);
      const [labels, value] = obsSpy.mock.calls[0] as [Record<string, string>, number];
      expect(labels).toEqual({ client: name, method: "WS", status_class: "error" });
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(5);
      obsSpy.mockRestore();

      // Kills L1246 (catch block body replaced by `{}`, so breaker.recordFailure() never
      // runs): with failureThreshold=1, a second call must now be short-circuited by the
      // OPEN breaker before it ever reaches the WS dispatch path again.
      const second = await proxyToolCall(`${name}__wst`, { msg: "hi" });
      expect(second.isError).toBe(true);
      expect(second.content[0].text).toMatch(/circuit breaker open/i);
    } finally {
      server.stop(true);
    }
  });
});
