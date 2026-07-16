/**
 * Stryker mutation-testing backstop for src/routes/schedules.ts — domain 8.
 * Baseline: 98 mutants, 0 killed / 98 survived — zero test coverage of any
 * kind existed before this. All line:col citations below were read directly
 * from reports/mutation/result.json.
 */
import { describe, test, expect, spyOn } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { requestIdMiddleware } from "../../middleware/request-id.js";
import { createSchedule, getSchedule } from "../../admin/entities/schedules.js";
import * as auditMod from "../../admin/audit/audit.js";
import { createTeam, setUserTeam, setClientTeam } from "../../admin/entities/teams.js";
import { createUser } from "../../security/user-store.js";
import { createSession } from "../../security/session-store.js";
import { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } from "../../security/cookies.js";

const ADMIN_KEY = "test-admin-key-schedules-mut";

async function startApp(): Promise<{ baseUrl: string; server: Server }> {
  __resetDbForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  const { scheduleRoutes } = await import("../../routes/schedules.js");
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  scheduleRoutes(app);
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      resolve({ baseUrl: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, server: srv });
    });
    srv.on("error", reject);
  });
}

function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" };
}

/** Creates a fresh team + operator user in it, and returns both the team id and its session headers. */
function createTeamSession(username: string): { teamId: number; headers: Record<string, string> } {
  const team = createTeam(`team-${username}`, "test");
  if (typeof team === "string") throw new Error(`createTeam failed: ${team}`);
  const user = createUser(username, "irrelevant-hash", "operator", null);
  setUserTeam(user.username, team.id);
  const session = createSession(user.id, "127.0.0.1", "test-agent");
  return {
    teamId: team.id,
    headers: {
      "Content-Type": "application/json",
      Cookie: `${SESSION_COOKIE_NAME}=${session.token}; ${CSRF_COOKIE_NAME}=${session.csrfToken}`,
      "X-CSRF-Token": session.csrfToken,
    },
  };
}

/** Session headers for a team-scoped operator — mirrors the pattern in routes-approvals-mutation.test.ts. */
function teamSessionHeaders(username: string): Record<string, string> {
  return createTeamSession(username).headers;
}

async function reg(name: string, tools: string[] = ["t"]): Promise<void> {
  await registry.register(
    name,
    tools.map((toolName) => ({
      name: toolName,
      method: "GET",
      endpoint: `/${toolName}`,
      description: "d",
      inputSchema: { type: "object", properties: {} },
    })),
    "http://example.com/health",
    "1.2.3.4",
    "http://example.com",
    "1.2.3.4",
  );
}

function seedSchedule(clientName: string, overrides: Partial<Parameters<typeof createSchedule>[0]> = {}) {
  const result = createSchedule({
    targetType: "client",
    clientName,
    toolName: null,
    action: "enable",
    cron: "* * * * *",
    actor: "seed",
    ...overrides,
  });
  if (typeof result === "string") throw new Error(`seedSchedule failed: ${result}`);
  return result;
}

async function withApp(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const { baseUrl, server } = await startApp();
  try {
    await fn(baseUrl);
  } finally {
    for (const c of registry.listClients()) await registry.unregister(c.name);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("GET /admin-api/schedules", () => {
  // Kills 0 BlockStatement (whole scheduleRoutes body emptied), 1
  // StringLiteral (route path emptied), 2 BlockStatement (handler body
  // emptied), and 3 ObjectLiteral (the { items } wrapper emptied).
  test("lists every recorded schedule", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-schedules-list");
      seedSchedule("svc-schedules-list");
      const res = await fetch(`${baseUrl}/admin-api/schedules`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[] };
      expect(body.items.length).toBeGreaterThan(0);
    });
  });

  // Regression coverage for the P1 tenancy fix in commit 2036715: the
  // teamId branch of listSchedules (admin/entities/schedules.ts) must
  // actually filter results for a team-scoped caller, not just exist.
  test("a team-scoped caller only sees schedules for clients their own team owns", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-schedules-own");
      await reg("svc-schedules-foreign");
      const caller = createTeamSession("schedules-list-caller");
      setClientTeam("svc-schedules-own", caller.teamId);
      const otherTeam = createTeam("team-schedules-list-other", "test");
      if (typeof otherTeam === "string") throw new Error("createTeam failed");
      setClientTeam("svc-schedules-foreign", otherTeam.id);

      const ownSchedule = seedSchedule("svc-schedules-own");
      seedSchedule("svc-schedules-foreign");

      const res = await fetch(`${baseUrl}/admin-api/schedules`, { headers: caller.headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: { id: number; clientName: string }[] };
      expect(body.items.map((i) => i.clientName)).toEqual(["svc-schedules-own"]);
      expect(body.items.some((i) => i.id === ownSchedule.id)).toBe(true);
    });
  });
});

describe("POST /admin-api/schedules — validation", () => {
  // Kills 6 LogicalOperator (?? -> &&): with no Content-Type/body at all,
  // req.body is undefined; `??` falls back to {} and validation fails
  // gracefully, while `&&` would leave body undefined and crash on
  // `body.targetType`.
  test("no request body at all is a graceful validation error, not a crash", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/schedules`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // Kills 21-29's whole compound-OR cluster (mutants 21-45) via clause
  // isolation: each of targetType/clientName/action/cron independently
  // fails validation while the other three are valid, and 47 (the
  // validation message emptied) via an exact-message assertion.
  test("an invalid targetType fails validation", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-schedules-badtarget");
      const res = await fetch(`${baseUrl}/admin-api/schedules`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          targetType: "bogus",
          clientName: "svc-schedules-badtarget",
          action: "enable",
          cron: "* * * * *",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe(
        "targetType (client|tool), clientName, action (enable|disable) and cron are required",
      );
    });
  });

  // A truthy NON-STRING clientName (not merely a missing one) is required
  // to distinguish real code (coerces to "" -> validation fails) from the
  // 7/8/9/10 ternary mutants (which would keep a truthy non-string value,
  // passing this clause and reaching createSchedule with garbage).
  test("a non-string clientName fails validation (coerced to empty, not passed through)", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/schedules`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ targetType: "client", clientName: 123, action: "enable", cron: "* * * * *" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe(
        "targetType (client|tool), clientName, action (enable|disable) and cron are required",
      );
    });
  });

  test("an invalid action fails validation", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-schedules-badaction");
      const res = await fetch(`${baseUrl}/admin-api/schedules`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          targetType: "client",
          clientName: "svc-schedules-badaction",
          action: "bogus",
          cron: "* * * * *",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe(
        "targetType (client|tool), clientName, action (enable|disable) and cron are required",
      );
    });
  });

  // Same "truthy non-string" reasoning as clientName, for cron's own
  // ternary cluster (16-20).
  test("a non-string cron fails validation (coerced to empty, not passed through)", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-schedules-badcron");
      const res = await fetch(`${baseUrl}/admin-api/schedules`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          targetType: "client",
          clientName: "svc-schedules-badcron",
          action: "enable",
          cron: 123456,
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe(
        "targetType (client|tool), clientName, action (enable|disable) and cron are required",
      );
    });
  });
});

describe("POST /admin-api/schedules — downstream (createSchedule) errors", () => {
  // Kills 49/50/51 (result === "INVALID_CRON" true/false/EqualityOperator)
  // and 52/54/55 (the code/message string literals emptied) via an exact
  // 400 + code + message assertion. A syntactically-valid-string but
  // unparseable cron reaches this branch (validation's `!cron` check
  // alone can't catch it).
  test("a malformed (but present) cron string returns the exact INVALID_CRON 400", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-schedules-cronbad");
      const res = await fetch(`${baseUrl}/admin-api/schedules`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          targetType: "client",
          clientName: "svc-schedules-cronbad",
          action: "enable",
          cron: "not a cron",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("INVALID_CRON");
      expect(body.error.message).toBe("cron must be a valid 5-field expression (min hour dom month dow)");
    });
  });

  // Kills 56/57/58 (result === "INVALID_TARGET" true/false/EqualityOperator)
  // and 59/61/62 (the code/message string literals emptied) for the
  // "client doesn't exist" branch of INVALID_TARGET.
  test("an unregistered clientName returns the exact INVALID_TARGET 400", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/schedules`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          targetType: "client",
          clientName: "svc-schedules-never-registered",
          action: "enable",
          cron: "* * * * *",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("INVALID_TARGET");
      expect(body.error.message).toBe("a tool schedule requires toolName");
    });
  });

  // A tool-target schedule with no toolName hits createSchedule's OWN
  // `targetType === "tool" && !toolName` check -- this is the toolName
  // ternary (12-15) forced to null, which is also the REAL behavior when
  // toolName is absent, so this test alone can't distinguish the forced
  // mutants from real code; it exists to prove this specific
  // INVALID_TARGET branch fires at all.
  test("a tool-target schedule with no toolName returns the exact INVALID_TARGET 400", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-schedules-notool");
      const res = await fetch(`${baseUrl}/admin-api/schedules`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          targetType: "tool",
          clientName: "svc-schedules-notool",
          action: "enable",
          cron: "* * * * *",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("INVALID_TARGET");
    });
  });

  // A tool-target schedule naming a tool that doesn't exist on the client
  // hits the OTHER INVALID_TARGET branch (the `db.query(...tools...)`
  // check).
  test("a tool-target schedule naming a nonexistent tool returns the exact INVALID_TARGET 400", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-schedules-badtool");
      const res = await fetch(`${baseUrl}/admin-api/schedules`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          targetType: "tool",
          clientName: "svc-schedules-badtool",
          toolName: "does-not-exist",
          action: "enable",
          cron: "* * * * *",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("INVALID_TARGET");
    });
  });
});

describe("POST /admin-api/schedules — success", () => {
  // Kills 5 (whole POST handler body emptied), 48 (the createSchedule
  // input object emptied), 21/24/26/30/33/36/39/42 (the validation
  // cluster's "always false" directions, which would wrongly reject a
  // fully valid request), 49/56 (the INVALID_CRON/INVALID_TARGET "always
  // true" directions, which would wrongly reject it too), and 63/64/65
  // (the recordAudit action/target/detail literals emptied) via an exact
  // audit-spy assertion.
  test("a fully valid client-target schedule is created, audited, and returned", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-schedules-create-ok");
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/schedules`, {
          method: "POST",
          headers: bearer(),
          body: JSON.stringify({
            targetType: "client",
            clientName: "svc-schedules-create-ok",
            action: "enable",
            cron: "* * * * *",
          }),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { id: number; clientName: string; action: string; cron: string };
        expect(body.clientName).toBe("svc-schedules-create-ok");
        expect(body.action).toBe("enable");
        expect(body.cron).toBe("* * * * *");
        expect(spy).toHaveBeenCalledWith(expect.any(String), "schedule.create", `schedule:${body.id}`, {
          targetType: "client",
          clientName: "svc-schedules-create-ok",
          toolName: null,
          action: "enable",
          cron: "* * * * *",
        });
      } finally {
        spy.mockRestore();
      }
    });
  });

  // Kills 12/13/14/15 (the toolName ternary forced-null / EqualityOperator
  // directions): a genuinely valid tool-target schedule must actually
  // persist and audit the real toolName, not null.
  test("a fully valid tool-target schedule preserves the real toolName", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-schedules-create-tool", ["realtool"]);
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/schedules`, {
          method: "POST",
          headers: bearer(),
          body: JSON.stringify({
            targetType: "tool",
            clientName: "svc-schedules-create-tool",
            toolName: "realtool",
            action: "disable",
            cron: "* * * * *",
          }),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { id: number; toolName: string | null };
        expect(body.toolName).toBe("realtool");
        expect(spy).toHaveBeenCalledWith(
          expect.any(String),
          "schedule.create",
          `schedule:${body.id}`,
          expect.objectContaining({ toolName: "realtool" }),
        );
      } finally {
        spy.mockRestore();
      }
    });
  });

  // Kills 11 (the toolName ternary's else-branch "" replaced with
  // "Stryker was here!") and 12 (forced true): a client-target schedule
  // with a non-string toolName in the request body must record toolName
  // as null in the audit detail, not the raw non-string value.
  test("a non-string toolName on a client-target schedule is recorded as null, not passed through", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-schedules-badtoolname-type");
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/schedules`, {
          method: "POST",
          headers: bearer(),
          body: JSON.stringify({
            targetType: "client",
            clientName: "svc-schedules-badtoolname-type",
            toolName: 42,
            action: "enable",
            cron: "* * * * *",
          }),
        });
        expect(res.status).toBe(201);
        expect(spy).toHaveBeenCalledWith(
          expect.any(String),
          "schedule.create",
          expect.any(String),
          expect.objectContaining({ toolName: null }),
        );
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("PATCH /admin-api/schedules/:id", () => {
  // Kills 66 (route path emptied), 67 (handler body emptied), 68
  // (?? -> &&): with no Content-Type/body, req.body is undefined and `??`
  // falls back to {}, failing gracefully instead of crashing on
  // `body.enabled`.
  test("no request body at all is a graceful validation error, not a crash", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-schedules-patch-nobody");
      const s = seedSchedule("svc-schedules-patch-nobody");
      const res = await fetch(`${baseUrl}/admin-api/schedules/${s.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // Kills 69/70/71 (the typeof-boolean check true/false/EqualityOperator),
  // 72 (the "boolean" literal emptied), 73 (the validation-error branch
  // body emptied), and 74 (the exact message emptied).
  test("a non-boolean enabled value fails validation with the exact message", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-schedules-patch-badtype");
      const s = seedSchedule("svc-schedules-patch-badtype");
      const res = await fetch(`${baseUrl}/admin-api/schedules/${s.id}`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ enabled: "true" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("enabled (boolean) is required");
    });
  });

  // Kills 75/76/77 (the !ok guard's negation-removed/forced true/false
  // directions), 78 (the not-found branch body emptied), 79/80 (the exact
  // code/message emptied) via an unknown schedule id.
  test("an unknown schedule id returns the exact SCHEDULE_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/schedules/999999`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("SCHEDULE_NOT_FOUND");
      expect(body.error.message).toBe("Schedule not found");
    });
  });

  // Kills the success-path complement of 75/76/77 (the schedule genuinely
  // exists and must be updated, not 404'd), 81/82 (the audit action/target
  // literals emptied), 83 (the audit detail object emptied), 84/85 (the
  // response object / "updated" literal emptied) -- verified both via the
  // response body AND a follow-up GET proving the DB row actually changed.
  test("a known schedule id is toggled, audited, and reflected in a follow-up GET", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-schedules-patch-ok");
      const s = seedSchedule("svc-schedules-patch-ok");
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/schedules/${s.id}`, {
          method: "PATCH",
          headers: bearer(),
          body: JSON.stringify({ enabled: false }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; id: number };
        expect(body).toEqual({ status: "updated", id: s.id });
        expect(spy).toHaveBeenCalledWith(expect.any(String), "schedule.update", `schedule:${s.id}`, {
          enabled: false,
        });
        const get = (await (await fetch(`${baseUrl}/admin-api/schedules`, { headers: bearer() })).json()) as {
          items: { id: number; enabled: boolean }[];
        };
        expect(get.items.find((i) => i.id === s.id)?.enabled).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });
  });

  // Regression coverage for the P1 tenancy fix in commit 2036715:
  // ensureClientAccess must actually block a team-scoped caller from
  // toggling a schedule targeting another team's client. ensureClientAccess
  // writes its OWN CLIENT_NOT_FOUND envelope (same uniform-404 convention as
  // routes-approvals-mutation.test.ts), distinct from this route's own
  // SCHEDULE_NOT_FOUND (used only for a genuinely unknown schedule id).
  test("a team-scoped caller PATCHing another team's schedule gets the exact CLIENT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-schedules-patch-foreign");
      const otherTeam = createTeam("team-schedules-patch-other", "test");
      if (typeof otherTeam === "string") throw new Error("createTeam failed");
      setClientTeam("svc-schedules-patch-foreign", otherTeam.id);
      const s = seedSchedule("svc-schedules-patch-foreign");

      const headers = teamSessionHeaders("schedules-patch-caller");
      const res = await fetch(`${baseUrl}/admin-api/schedules/${s.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
      // Untouched — proves the mutation never actually ran.
      expect(getSchedule(s.id)?.enabled).toBe(true);
    });
  });
});

describe("DELETE /admin-api/schedules/:id", () => {
  // Kills 86 (route path emptied), 87 (handler body emptied), 88/89/90
  // (the !ok guard's negation-removed/forced true/false directions), 91
  // (the not-found branch body emptied), 92/93 (the exact code/message
  // emptied) via an unknown schedule id.
  test("an unknown schedule id returns the exact SCHEDULE_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/schedules/999999`, { method: "DELETE", headers: bearer() });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("SCHEDULE_NOT_FOUND");
      expect(body.error.message).toBe("Schedule not found");
    });
  });

  // Kills the success-path complement of 88/89/90, 94/95 (the audit
  // action/target literals emptied), 96 (the response object emptied),
  // and 97 ("deleted" emptied) -- verified both via the response body AND
  // a follow-up GET proving the row was genuinely removed, not just
  // echoed back.
  test("a known schedule id is deleted, audited, and absent from a follow-up GET", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-schedules-delete-ok");
      const s = seedSchedule("svc-schedules-delete-ok");
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/schedules/${s.id}`, { method: "DELETE", headers: bearer() });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; id: number };
        expect(body).toEqual({ status: "deleted", id: s.id });
        expect(spy).toHaveBeenCalledWith(expect.any(String), "schedule.delete", `schedule:${s.id}`);
        const get = (await (await fetch(`${baseUrl}/admin-api/schedules`, { headers: bearer() })).json()) as {
          items: { id: number }[];
        };
        expect(get.items.some((i) => i.id === s.id)).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });
  });

  // Regression coverage for the P1 tenancy fix in commit 2036715:
  // ensureClientAccess must actually block a team-scoped caller from
  // deleting a schedule targeting another team's client (its own
  // CLIENT_NOT_FOUND envelope, distinct from this route's SCHEDULE_NOT_FOUND).
  test("a team-scoped caller DELETEing another team's schedule gets the exact CLIENT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-schedules-delete-foreign");
      const otherTeam = createTeam("team-schedules-delete-other", "test");
      if (typeof otherTeam === "string") throw new Error("createTeam failed");
      setClientTeam("svc-schedules-delete-foreign", otherTeam.id);
      const s = seedSchedule("svc-schedules-delete-foreign");

      const headers = teamSessionHeaders("schedules-delete-caller");
      const res = await fetch(`${baseUrl}/admin-api/schedules/${s.id}`, { method: "DELETE", headers });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
      // Still present — proves the delete never actually ran.
      expect(getSchedule(s.id)).not.toBeNull();
    });
  });
});
