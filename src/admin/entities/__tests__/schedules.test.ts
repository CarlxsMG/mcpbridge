/**
 * Maintenance schedules — cron matcher, the leader-run evaluator (fire once /
 * minute, no double-fire), and the admin routes.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../../config.js";
import { __resetDbForTesting } from "../../../db/connection.js";
import { registry } from "../../../mcp/registry.js";
import { requestIdMiddleware } from "../../../middleware/request-id.js";
import {
  parseCron,
  cronMatches,
  createSchedule,
  listSchedules,
  setScheduleEnabled,
  deleteSchedule,
  runDueSchedules,
} from "../../../admin/entities/schedules.js";
import type { RestToolDefinition } from "../../../mcp/types.js";

function makeTool(): RestToolDefinition {
  return {
    name: "get-x",
    method: "GET",
    endpoint: "/x",
    description: "x",
    inputSchema: { type: "object", properties: {} },
  };
}
async function reg(): Promise<void> {
  await registry.register("svc", [makeTool()], "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}

beforeEach(async () => {
  __resetDbForTesting();
  for (const c of registry.listClients()) await registry.unregister(c.name);
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
});

describe("cron matcher", () => {
  test("wildcard matches anything", () => {
    expect(cronMatches("* * * * *", new Date(Date.UTC(2026, 0, 5, 14, 30)))).toBe(true);
  });
  test("specific minute/hour", () => {
    expect(cronMatches("30 14 * * *", new Date(Date.UTC(2026, 0, 5, 14, 30)))).toBe(true);
    expect(cronMatches("30 14 * * *", new Date(Date.UTC(2026, 0, 5, 14, 31)))).toBe(false);
  });
  test("step and range", () => {
    expect(cronMatches("*/15 * * * *", new Date(Date.UTC(2026, 0, 5, 0, 45)))).toBe(true);
    expect(cronMatches("*/15 * * * *", new Date(Date.UTC(2026, 0, 5, 0, 46)))).toBe(false);
    expect(cronMatches("0 9-17 * * *", new Date(Date.UTC(2026, 0, 5, 12, 0)))).toBe(true);
    expect(cronMatches("0 9-17 * * *", new Date(Date.UTC(2026, 0, 5, 18, 0)))).toBe(false);
  });
  test("invalid expressions parse to null", () => {
    expect(parseCron("* * * *")).toBeNull();
    expect(parseCron("99 * * * *")).toBeNull();
    expect(parseCron("* * * * 8")).toBeNull();
  });
});

describe("schedule evaluator", () => {
  const AT_1430 = new Date(Date.UTC(2026, 0, 5, 14, 30));

  test("fires a matching client-disable once, then de-dupes within the minute", async () => {
    await reg();
    createSchedule({ targetType: "client", clientName: "svc", action: "disable", cron: "30 14 * * *", actor: "t" });

    expect(await runDueSchedules(AT_1430)).toBe(1);
    expect(registry.getClient("svc")?.enabled).toBe(false);

    // Same minute — must not fire again.
    expect(await runDueSchedules(AT_1430)).toBe(0);
  });

  test("does not fire when the cron doesn't match", async () => {
    await reg();
    createSchedule({ targetType: "client", clientName: "svc", action: "disable", cron: "0 3 * * *", actor: "t" });
    expect(await runDueSchedules(AT_1430)).toBe(0);
    expect(registry.getClient("svc")?.enabled).toBe(true);
  });

  test("a disabled schedule never fires", async () => {
    await reg();
    const s = createSchedule({
      targetType: "client",
      clientName: "svc",
      action: "disable",
      cron: "30 14 * * *",
      actor: "t",
    });
    setScheduleEnabled((s as { id: number }).id, false);
    expect(await runDueSchedules(AT_1430)).toBe(0);
  });

  test("tool-scoped enable schedule flips just that tool", async () => {
    await reg();
    await registry.setToolEnabled("svc", "get-x", false);
    createSchedule({
      targetType: "tool",
      clientName: "svc",
      toolName: "get-x",
      action: "enable",
      cron: "30 14 * * *",
      actor: "t",
    });
    expect(await runDueSchedules(AT_1430)).toBe(1);
    expect(registry.getClientDetail("svc")?.tools[0].enabled).toBe(true);
  });

  test("rejects an unknown client and a bad cron", async () => {
    await reg();
    expect(
      createSchedule({ targetType: "client", clientName: "ghost", action: "disable", cron: "* * * * *", actor: "t" }),
    ).toBe("INVALID_TARGET");
    expect(
      createSchedule({ targetType: "client", clientName: "svc", action: "disable", cron: "nope", actor: "t" }),
    ).toBe("INVALID_CRON");
  });
});

describe("schedules — admin route", () => {
  const ADMIN_KEY = "test-admin-key";
  let baseUrl = "";
  let server: Server | null = null;
  async function startApp(): Promise<void> {
    (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
    (config as Record<string, unknown>).authDisabled = false;
    const { scheduleRoutes } = await import("../../../routes/schedules.js");
    const app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);
    scheduleRoutes(app);
    await new Promise<void>((resolve) => {
      const srv = app.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
        server = srv;
        resolve();
      });
    });
  }
  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (server)
        server.close(() => {
          server = null;
          resolve();
        });
      else resolve();
    });
  });
  function bearer(): Record<string, string> {
    return { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" };
  }

  test("POST valid, list, PATCH, DELETE", async () => {
    await reg();
    await startApp();
    const create = await fetch(`${baseUrl}/admin-api/schedules`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ targetType: "client", clientName: "svc", action: "disable", cron: "0 3 * * *" }),
    });
    expect(create.status).toBe(201);
    const { id } = (await create.json()) as { id: number };
    expect(listSchedules()).toHaveLength(1);
    const patch = await fetch(`${baseUrl}/admin-api/schedules/${id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ enabled: false }),
    });
    expect(patch.status).toBe(200);
    const del = await fetch(`${baseUrl}/admin-api/schedules/${id}`, { method: "DELETE", headers: bearer() });
    expect(del.status).toBe(200);
    expect(deleteSchedule(999)).toBe(false);
  });

  test("POST invalid cron -> 400", async () => {
    await reg();
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/schedules`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ targetType: "client", clientName: "svc", action: "disable", cron: "not a cron" }),
    });
    expect(res.status).toBe(400);
  });
});
