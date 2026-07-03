/**
 * Usage-spike anomaly detection + its wiring into the alert machinery.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../config.js";
import { __resetDbForTesting, getDb } from "../db/connection.js";
import { detectUsageSpike } from "../observability/anomaly.js";
import { createAlertRule, evaluateAlerts, __resetAlertStateForTesting } from "../alerts.js";
import { __clearUsageForTesting } from "../observability/usage.js";

function seed(count: number, createdAt: number): void {
  const db = getDb();
  const stmt = db.query(
    `INSERT INTO tool_call_log (client_name, tool_name, key_id, status_class, is_error, duration_ms, created_at) VALUES ('svc','t',NULL,'2xx',0,5,?)`,
  );
  for (let i = 0; i < count; i++) stmt.run(createdAt);
}

const MIN = 60_000;

beforeEach(() => {
  __resetDbForTesting();
  __clearUsageForTesting();
  __resetAlertStateForTesting();
});
afterEach(() => {
  __resetDbForTesting();
  __resetAlertStateForTesting();
});

describe("detectUsageSpike", () => {
  test("quiet baseline + recent burst is a spike", () => {
    const now = Date.now();
    seed(30, now - 1 * MIN); // recent (within 5-min window)
    const r = detectUsageSpike({ factor: 3, minCalls: 20, now });
    expect(r.spike).toBe(true);
    expect(r.recentCalls).toBe(30);
    expect(r.baselineRate).toBe(0);
  });

  test("recent below minCalls is never a spike", () => {
    const now = Date.now();
    seed(5, now - 1 * MIN);
    expect(detectUsageSpike({ factor: 3, minCalls: 20, now }).spike).toBe(false);
  });

  test("busy baseline + proportionate recent traffic is not a spike", () => {
    const now = Date.now();
    seed(600, now - 30 * MIN); // baseline: 600 over 60 min = 10/min
    seed(40, now - 1 * MIN); // recent: 40 over 5 min = 8/min  (< 10*3)
    expect(detectUsageSpike({ factor: 3, minCalls: 20, now }).spike).toBe(false);
  });

  test("recent traffic clearing factor x baseline is a spike", () => {
    const now = Date.now();
    seed(60, now - 30 * MIN); // baseline: 60 over 60 min = 1/min
    seed(40, now - 1 * MIN); // recent: 8/min >= 1*3
    expect(detectUsageSpike({ factor: 3, minCalls: 20, now }).spike).toBe(true);
  });
});

describe("usage_spike alert integration", () => {
  let server: Server | null = null;
  const originalAllowPrivate = config.allowPrivateIps;
  afterEach(async () => {
    (config as Record<string, unknown>).allowPrivateIps = originalAllowPrivate;
    await new Promise<void>((resolve) => {
      if (server)
        server.close(() => {
          server = null;
          resolve();
        });
      else resolve();
    });
  });

  test("fires the webhook when a spike is detected", async () => {
    (config as Record<string, unknown>).allowPrivateIps = true; // allow the 127.0.0.1 capture webhook
    let received: Record<string, unknown> | null = null;
    let resolveGot!: () => void;
    const got = new Promise<void>((r) => {
      resolveGot = r;
    });

    const app = express();
    app.use(express.json());
    app.post("/hook", (req, res) => {
      received = req.body as Record<string, unknown>;
      res.status(200).end();
      resolveGot();
    });
    await new Promise<void>((resolve) => {
      const srv = app.listen(0, "127.0.0.1", () => {
        server = srv;
        resolve();
      });
    });
    const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/hook`;

    createAlertRule({
      name: "spike",
      eventType: "usage_spike",
      webhookUrl: url,
      threshold: 3,
      minCalls: 20,
      actor: "t",
    });
    seed(40, Date.now() - 1 * MIN); // burst against a silent baseline

    await evaluateAlerts();
    await Promise.race([got, new Promise((_r, rej) => setTimeout(() => rej(new Error("webhook not called")), 3000))]);

    expect(received).not.toBeNull();
    expect(received!.event).toBe("usage_spike");
  });
});
