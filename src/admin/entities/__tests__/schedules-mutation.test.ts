/**
 * Stryker mutation-testing backstop for src/admin/entities/schedules.ts.
 * Gap-fills the existing hand-written schedules.test.ts (co-located in this
 * same directory, left untouched) which already covers: happy-path cron
 * matching (wildcard/specific/step+range/invalid-field-count), the fire-once
 * evaluator (client + tool targets, disabled schedules, non-matching cron,
 * unknown client / bad cron rejection), and the admin route's POST/PATCH/
 * DELETE + invalid-cron-400 path.
 *
 * This file focuses on what that one doesn't touch: parseField's individual
 * guard clauses and every field's min/max boundary, createSchedule's other
 * INVALID_TARGET branches (bad enum values, missing/unknown tool), the full
 * Schedule shape returned by createSchedule, setScheduleEnabled/deleteSchedule
 * success+failure return values, recordAudit's exact call arguments (both
 * target-string shapes), the runDueSchedules try/catch failure path, and
 * startScheduleLoop's leader-gated immediate tick.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { __resetDbForTesting, getDb } from "../../../db/connection.js";
import { __resetLeaderFlagForTesting, refreshLeaderStatus } from "../../../db/leader-lease.js";
import { registry } from "../../../mcp/registry.js";
import * as auditMod from "../../audit/audit.js";
import * as loggerMod from "../../../logger.js";
import {
  parseCron,
  cronMatches,
  createSchedule,
  listSchedules,
  setScheduleEnabled,
  deleteSchedule,
  runDueSchedules,
  startScheduleLoop,
  type Schedule,
  type ScheduleTarget,
  type ScheduleAction,
} from "../../../admin/entities/schedules.js";
import type { RestToolDefinition } from "../../../mcp/types.js";

function makeTool(name = "get-x"): RestToolDefinition {
  return {
    name,
    method: "GET",
    endpoint: "/x",
    description: "x",
    inputSchema: { type: "object", properties: {} },
  };
}
async function reg(name: string, toolName = "get-x"): Promise<void> {
  await registry.register(name, [makeTool(toolName)], "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}

beforeEach(async () => {
  __resetDbForTesting();
  __resetLeaderFlagForTesting();
  for (const c of registry.listClients()) await registry.unregister(c.name);
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
  __resetLeaderFlagForTesting();
});

describe("parseCron / cronMatches — field boundaries & malformed input", () => {
  test("comma-separated list matches only the listed minutes", () => {
    expect(cronMatches("0,30 * * * *", new Date(Date.UTC(2026, 0, 5, 10, 0)))).toBe(true);
    expect(cronMatches("0,30 * * * *", new Date(Date.UTC(2026, 0, 5, 10, 30)))).toBe(true);
    expect(cronMatches("0,30 * * * *", new Date(Date.UTC(2026, 0, 5, 10, 15)))).toBe(false);
  });

  test("a range with an explicit step matches only step-aligned values inside the range", () => {
    expect(cronMatches("0-30/10 * * * *", new Date(Date.UTC(2026, 0, 5, 10, 10)))).toBe(true);
    expect(cronMatches("0-30/10 * * * *", new Date(Date.UTC(2026, 0, 5, 10, 5)))).toBe(false);
    expect(cronMatches("0-30/10 * * * *", new Date(Date.UTC(2026, 0, 5, 10, 40)))).toBe(false);
  });

  test("rejects a non-integer step", () => {
    expect(parseCron("*/2.5 * * * *")).toBeNull();
  });

  test("rejects a zero step", () => {
    expect(parseCron("*/0 * * * *")).toBeNull();
  });

  test("rejects a three-part range (a-b-c)", () => {
    expect(parseCron("1-2-3 * * * *")).toBeNull();
  });

  test("rejects a non-integer lower bound in a range", () => {
    expect(parseCron("1.5-10 * * * *")).toBeNull();
  });

  test("rejects a non-integer upper bound in a range", () => {
    expect(parseCron("5-10.5 * * * *")).toBeNull();
  });

  test("rejects an inverted range (lo > hi)", () => {
    expect(parseCron("10-5 * * * *")).toBeNull();
  });

  // Kills the `lo > hi` guard's forced-false direction: an isolated
  // inverted range alone can't distinguish it (the loop simply adds
  // nothing either way, and the trailing `out.size > 0` fallback returns
  // null regardless of which path got there). A comma-list combining one
  // VALID part with one inverted part is the only input where bypassing
  // this guard changes the final boolean outcome -- the valid part's
  // entry survives in `out`, so the fallback's size check no longer
  // catches the invalid part's silent omission.
  test("rejects a comma-list combining a valid part with an inverted range", () => {
    expect(parseCron("5,10-5 * * * *")).toBeNull();
  });

  test("cronMatches returns false (not a throw) for a malformed cron expression", () => {
    expect(cronMatches("not a cron", new Date())).toBe(false);
  });

  test("rejects a day-of-month below its minimum (0)", () => {
    expect(parseCron("* * 0 * *")).toBeNull();
  });

  test("rejects a day-of-month above its maximum (32)", () => {
    expect(parseCron("* * 32 * *")).toBeNull();
  });

  test("rejects a month below its minimum (0)", () => {
    expect(parseCron("* * * 0 *")).toBeNull();
  });

  test("rejects a month above its maximum (13)", () => {
    expect(parseCron("* * * 13 *")).toBeNull();
  });

  test("rejects an hour above its maximum (24)", () => {
    expect(parseCron("* 24 * * *")).toBeNull();
  });

  test("accepts every field at its lower bound simultaneously (minute/hour/dom/month = 0/0/1/1)", () => {
    // Jan 1 2026 00:00 UTC.
    expect(cronMatches("0 0 1 1 *", new Date(Date.UTC(2026, 0, 1, 0, 0)))).toBe(true);
  });

  test("accepts every field at its upper bound simultaneously (minute/hour/dom/month = 59/23/31/12)", () => {
    // Dec 31 2026 23:59 UTC.
    expect(cronMatches("59 23 31 12 *", new Date(Date.UTC(2026, 11, 31, 23, 59)))).toBe(true);
  });

  test("day-of-week accepts both its lower bound (Sunday=0) and upper bound (Saturday=6)", () => {
    // Jan 4 2026 is a Sunday, Jan 3 2026 is a Saturday (both UTC).
    expect(cronMatches("* * * * 0", new Date(Date.UTC(2026, 0, 4, 12, 0)))).toBe(true);
    expect(cronMatches("* * * * 6", new Date(Date.UTC(2026, 0, 3, 12, 0)))).toBe(true);
  });

  test("tolerates surrounding and repeated internal whitespace between fields", () => {
    expect(cronMatches("  30   14  *  *  *  ", new Date(Date.UTC(2026, 0, 5, 14, 30)))).toBe(true);
  });
});

describe("createSchedule — validation branches the hand-written test doesn't exercise", () => {
  // The client MUST be registered for these two: otherwise the later,
  // unrelated "client not found" guard also returns INVALID_TARGET (since
  // "svc" wouldn't exist), masking whether the targetType/action checks
  // themselves are doing any work at all. The schedules table's own
  // `CHECK (target_type IN (...))`/`CHECK (action IN (...))` constraints
  // mean a bypassed app-level check surfaces as a thrown SQLite
  // constraint violation on INSERT, not a silent success -- so isolating
  // the guard is what actually makes this observable.
  test("rejects an invalid targetType enum value (client exists)", async () => {
    await reg("svc");
    const result = createSchedule({
      targetType: "bogus" as unknown as ScheduleTarget,
      clientName: "svc",
      action: "disable",
      cron: "* * * * *",
      actor: "t",
    });
    expect(result).toBe("INVALID_TARGET");
    expect(listSchedules()).toHaveLength(0);
  });

  test("rejects an invalid action enum value (client exists)", async () => {
    await reg("svc");
    const result = createSchedule({
      targetType: "client",
      clientName: "svc",
      action: "bogus" as unknown as ScheduleAction,
      cron: "* * * * *",
      actor: "t",
    });
    expect(result).toBe("INVALID_TARGET");
    expect(listSchedules()).toHaveLength(0);
  });

  test("rejects an invalid targetType enum value", () => {
    const result = createSchedule({
      targetType: "bogus" as unknown as ScheduleTarget,
      clientName: "svc",
      action: "disable",
      cron: "* * * * *",
      actor: "t",
    });
    expect(result).toBe("INVALID_TARGET");
  });

  test("rejects an invalid action enum value", () => {
    const result = createSchedule({
      targetType: "client",
      clientName: "svc",
      action: "bogus" as unknown as ScheduleAction,
      cron: "* * * * *",
      actor: "t",
    });
    expect(result).toBe("INVALID_TARGET");
  });

  // The client MUST be registered here too: otherwise the later, unrelated
  // "client not found" guard also returns INVALID_TARGET, masking whether
  // this specific `targetType === "tool" && !toolName` check (and its
  // "tool" string-literal comparison) is doing any work at all.
  test("rejects a tool-type schedule with no toolName", async () => {
    await reg("svc");
    const result = createSchedule({
      targetType: "tool",
      clientName: "svc",
      action: "enable",
      cron: "* * * * *",
      actor: "t",
    });
    expect(result).toBe("INVALID_TARGET");
    expect(listSchedules()).toHaveLength(0);
  });

  test("rejects a tool-type schedule for a tool that doesn't exist on the client", async () => {
    await reg("svc");
    const result = createSchedule({
      targetType: "tool",
      clientName: "svc",
      toolName: "does-not-exist",
      action: "enable",
      cron: "* * * * *",
      actor: "t",
    });
    expect(result).toBe("INVALID_TARGET");
  });

  test("creates a well-formed client-type schedule with the expected shape", async () => {
    await reg("svc");
    const before = Date.now();
    const result = createSchedule({
      targetType: "client",
      clientName: "svc",
      action: "enable",
      cron: "5 4 * * *",
      actor: "alice",
    });
    const s = result as Schedule;
    expect(s.id).toBeGreaterThan(0);
    expect(s.targetType).toBe("client");
    expect(s.clientName).toBe("svc");
    expect(s.toolName).toBeNull();
    expect(s.action).toBe("enable");
    expect(s.cron).toBe("5 4 * * *");
    expect(s.enabled).toBe(true);
    expect(s.lastRunMinute).toBeNull();
    expect(s.createdAt).toBeGreaterThanOrEqual(before);
    expect(s.createdBy).toBe("alice");
  });

  // Kills the `input.targetType === "tool"` ternary's forced-true
  // direction on the toolName assignment: a "client"-type schedule that
  // ALSO happens to be given a toolName must still persist tool_name as
  // null (the value is only ever consulted for "tool"-type schedules).
  // Passing toolName with no toolName at all is NOT enough to catch this
  // -- bun:sqlite silently binds `undefined` the same as `null`, so the
  // divergence only appears when a real, non-null toolName is supplied.
  test("a client-type schedule ignores a supplied toolName", async () => {
    await reg("svc");
    const result = createSchedule({
      targetType: "client",
      clientName: "svc",
      toolName: "get-x",
      action: "enable",
      cron: "* * * * *",
      actor: "t",
    });
    expect((result as Schedule).toolName).toBeNull();
  });

  test("persists a null actor as a null createdBy", async () => {
    await reg("svc");
    const result = createSchedule({
      targetType: "client",
      clientName: "svc",
      action: "disable",
      cron: "* * * * *",
      actor: null,
    });
    expect((result as Schedule).createdBy).toBeNull();
  });
});

describe("listSchedules / setScheduleEnabled / deleteSchedule", () => {
  test("lists multiple schedules across distinct clients in ascending id order", async () => {
    await reg("svc-a");
    await reg("svc-b");
    const first = createSchedule({
      targetType: "client",
      clientName: "svc-a",
      action: "disable",
      cron: "* * * * *",
      actor: "t",
    }) as Schedule;
    const second = createSchedule({
      targetType: "client",
      clientName: "svc-b",
      action: "enable",
      cron: "* * * * *",
      actor: "t",
    }) as Schedule;
    const all = listSchedules();
    expect(all).toHaveLength(2);
    expect(all[0].id).toBeLessThan(all[1].id);
    expect(all.map((s) => s.clientName)).toEqual([first.clientName, second.clientName]);
  });

  test("setScheduleEnabled can flip a schedule back on, and reports false for an unknown id", async () => {
    await reg("svc");
    const s = createSchedule({
      targetType: "client",
      clientName: "svc",
      action: "disable",
      cron: "* * * * *",
      actor: "t",
    }) as Schedule;
    expect(setScheduleEnabled(s.id, false)).toBe(true);
    expect(listSchedules()[0].enabled).toBe(false);
    expect(setScheduleEnabled(s.id, true)).toBe(true);
    expect(listSchedules()[0].enabled).toBe(true);
    expect(setScheduleEnabled(999999, true)).toBe(false);
  });

  test("deleteSchedule removes the row and reports false for an unknown id", async () => {
    await reg("svc");
    const s = createSchedule({
      targetType: "client",
      clientName: "svc",
      action: "disable",
      cron: "* * * * *",
      actor: "t",
    }) as Schedule;
    expect(deleteSchedule(s.id)).toBe(true);
    expect(listSchedules()).toHaveLength(0);
    expect(deleteSchedule(s.id)).toBe(false);
  });
});

describe("runDueSchedules — recordAudit target shape + failure isolation", () => {
  const AT_1430 = new Date(Date.UTC(2026, 0, 5, 14, 30));

  test("records a client-type audit entry keyed by clientName alone", async () => {
    await reg("svc");
    const s = createSchedule({
      targetType: "client",
      clientName: "svc",
      action: "disable",
      cron: "30 14 * * *",
      actor: "t",
    }) as Schedule;
    const auditSpy = spyOn(auditMod, "recordAudit");
    try {
      expect(await runDueSchedules(AT_1430)).toBe(1);
      expect(auditSpy).toHaveBeenCalledWith("scheduler", "schedule.disable", "svc", { scheduleId: s.id });
    } finally {
      auditSpy.mockRestore();
    }
  });

  test("records a tool-type audit entry keyed by client__tool", async () => {
    await reg("svc");
    const s = createSchedule({
      targetType: "tool",
      clientName: "svc",
      toolName: "get-x",
      action: "enable",
      cron: "30 14 * * *",
      actor: "t",
    }) as Schedule;
    const auditSpy = spyOn(auditMod, "recordAudit");
    try {
      expect(await runDueSchedules(AT_1430)).toBe(1);
      expect(auditSpy).toHaveBeenCalledWith("scheduler", "schedule.enable", "svc__get-x", { scheduleId: s.id });
    } finally {
      auditSpy.mockRestore();
    }
  });

  test("a failure inside applySchedule is caught, logged, and leaves last_run_minute unset", async () => {
    await reg("svc");
    const s = createSchedule({
      targetType: "client",
      clientName: "svc",
      action: "disable",
      cron: "30 14 * * *",
      actor: "t",
    }) as Schedule;
    const registrySpy = spyOn(registry, "setClientEnabled").mockRejectedValue(new Error("boom"));
    const logSpy = spyOn(loggerMod, "log");
    try {
      expect(await runDueSchedules(AT_1430)).toBe(0);
      expect(logSpy).toHaveBeenCalledWith("error", "Schedule application failed", {
        scheduleId: s.id,
        error: "boom",
      });
      expect(listSchedules()[0].lastRunMinute).toBeNull();
    } finally {
      registrySpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  // Kills the `s.toolName` guard's forced-true direction in applySchedule's
  // else-if branch. createSchedule itself can never produce a "tool"-type
  // row with a null tool_name (it requires toolName up front), so this
  // constructs the otherwise-unreachable malformed row directly via SQL --
  // the tool_name column has no NOT NULL/CHECK constraint of its own,
  // only target_type/action do.
  test("a malformed tool-type row with a null tool_name never calls setToolEnabled", async () => {
    await reg("svc");
    const now = Date.now();
    getDb()
      .query(
        `INSERT INTO schedules (target_type, client_name, tool_name, action, cron, enabled, created_at, created_by)
         VALUES ('tool', 'svc', NULL, 'enable', '30 14 * * *', 1, ?, 't')`,
      )
      .run(now);
    const setToolSpy = spyOn(registry, "setToolEnabled");
    try {
      expect(await runDueSchedules(AT_1430)).toBe(1);
      expect(setToolSpy).not.toHaveBeenCalled();
    } finally {
      setToolSpy.mockRestore();
    }
  });

  // Kills the `now.getTime() / 60_000` arithmetic mutant (`/` -> `*`):
  // asserts the EXACT stored last_run_minute value, not just that
  // dedup/audit behavior looks right.
  test("stores the exact currentMinute (getTime() / 60_000, not * 60_000)", async () => {
    await reg("svc");
    const s = createSchedule({
      targetType: "client",
      clientName: "svc",
      action: "disable",
      cron: "30 14 * * *",
      actor: "t",
    }) as Schedule;
    await runDueSchedules(AT_1430);
    const row = getDb().query(`SELECT last_run_minute FROM schedules WHERE id = ?`).get(s.id) as {
      last_run_minute: number;
    };
    expect(row.last_run_minute).toBe(Math.floor(AT_1430.getTime() / 60_000));
  });
});

describe("startScheduleLoop", () => {
  test("returns a callable stop function", () => {
    const stop = startScheduleLoop();
    try {
      expect(typeof stop).toBe("function");
    } finally {
      stop();
    }
  });

  test("fires a due schedule immediately when this instance is the leader", async () => {
    refreshLeaderStatus();
    await reg("svc");
    createSchedule({
      targetType: "client",
      clientName: "svc",
      action: "disable",
      cron: "* * * * *",
      actor: "t",
    });
    let stop: (() => void) | undefined;
    try {
      stop = startScheduleLoop();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(registry.getClient("svc")?.enabled).toBe(false);
    } finally {
      stop?.();
    }
  });
});
