/**
 * Stryker mutation-testing backstop for src/routes/admin/lb.ts — domain 8.
 * Baseline: 123 mutants, 0 killed / 123 survived — zero test coverage of any
 * kind existed before this (confirmed via grep across every __tests__ dir).
 * All line:col citations below were read directly from
 * reports/mutation/result.json.
 */
import { describe, test, expect, spyOn } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { createUser } from "../../security/user-store.js";
import { createSession } from "../../security/session-store.js";
import { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } from "../../security/cookies.js";
import { createTeam, setUserTeam, setClientTeam } from "../../admin/entities/teams.js";
import * as auditMod from "../../admin/audit/audit.js";

const ADMIN_KEY = "test-admin-key-lb-mut";

async function startApp(): Promise<{ baseUrl: string; server: Server }> {
  __resetDbForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  const { adminRoutes } = await import("../../routes/admin.js");
  const app = express();
  app.use(express.json());
  adminRoutes(app);
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

function teamSessionHeaders(username: string): Record<string, string> {
  const team = createTeam(`team-${username}`, "test");
  if (typeof team === "string") throw new Error(`createTeam failed: ${team}`);
  const user = createUser(username, "irrelevant-hash", "admin", null);
  setUserTeam(user.username, team.id);
  const session = createSession(user.id, "127.0.0.1", "test-agent");
  return {
    "Content-Type": "application/json",
    Cookie: `${SESSION_COOKIE_NAME}=${session.token}; ${CSRF_COOKIE_NAME}=${session.csrfToken}`,
    "X-CSRF-Token": session.csrfToken,
  };
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

describe("GET /admin-api/clients/:name/lb", () => {
  // Kills 2/3/4 (the ensureClientAccess guard's forced/negation-removed
  // directions).
  test("a session caller from a different team gets the exact CLIENT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-lb-get-denied");
      const otherTeam = createTeam("team-lb-get-denied", "test");
      if (typeof otherTeam === "string") throw new Error("createTeam failed");
      setClientTeam("svc-lb-get-denied", otherTeam.id);
      const headers = teamSessionHeaders("lb-get-denied-user");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-lb-get-denied/lb`, { headers });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
    });
  });

  // Kills 5 (the `{ lb: ... }` response wrapper emptied).
  test("returns null lb for a client with no pool configured", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-lb-get-empty");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-lb-get-empty/lb`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { lb: unknown };
      expect(body.lb).toBeNull();
    });
  });
});

describe("PUT /admin-api/clients/:name/lb", () => {
  // Kills 8/9/10 (PUT's OWN independent copy of the ensureClientAccess
  // guard).
  test("a session caller from a different team gets the exact CLIENT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-lb-put-denied");
      const otherTeam = createTeam("team-lb-put-denied", "test");
      if (typeof otherTeam === "string") throw new Error("createTeam failed");
      setClientTeam("svc-lb-put-denied", otherTeam.id);
      const headers = teamSessionHeaders("lb-put-denied-user");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-lb-put-denied/lb`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ strategy: "round-robin" }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
    });
  });

  // Kills 11 (the `?? {}` body fallback flipped to `&&`): with no
  // Content-Type/body at all, req.body is undefined; `??` falls back to
  // {} and the route resolves a graceful INVALID_STRATEGY 400 (strategy
  // ends up undefined, which isn't a valid strategy), while `&&` would
  // leave body undefined and crash on `body.lb`.
  test("no request body at all is a graceful validation error, not a crash", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-lb-put-nobody");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-lb-put-nobody/lb`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_STRATEGY");
    });
  });

  // Kills 30/31/32/33 (the CLIENT_NOT_FOUND-vs-400 ternary's "always 404"
  // direction and the exact code/message -- `sendError` uses
  // `result.error` as BOTH code and message here).
  test("an unknown client returns the exact CLIENT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-lb-never-registered/lb`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ strategy: "round-robin" }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
      expect(body.error.message).toBe("CLIENT_NOT_FOUND");
    });
  });

  // Kills the complementary "always 400" direction of 30/31/32 via a
  // DIFFERENT failure mode (an invalid strategy on a REAL client), plus
  // 26/27/28/29 (the !result.ok guard).
  test("an invalid strategy on a real client returns the exact INVALID_STRATEGY 400", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-lb-badstrategy");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-lb-badstrategy/lb`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ strategy: "not-a-real-strategy" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_STRATEGY");
    });
  });

  // Kills 12/13/14/15/16 (the `body.lb === null` cluster) and 17/18/19/20
  // (the primaryWeight ternary) and 21/22/23/24/25 (the enabled cluster
  // and the whole input object) via an exact follow-up-read assertion --
  // 3 distinct `enabled` fixtures (omitted, explicit false, explicit
  // true) are needed since the guard is `!== false`, not `=== true`.
  test("a fully valid strategy config with explicit values is stored exactly", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-lb-set-ok");
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/clients/svc-lb-set-ok/lb`, {
          method: "PUT",
          headers: bearer(),
          body: JSON.stringify({ strategy: "weighted", primaryWeight: 7, enabled: false }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; name: string };
        expect(body).toEqual({ status: "updated", name: "svc-lb-set-ok" });
        const get = (await (
          await fetch(`${baseUrl}/admin-api/clients/svc-lb-set-ok/lb`, { headers: bearer() })
        ).json()) as { lb: { strategy: string; primaryWeight: number; enabled: boolean; targets: unknown[] } };
        expect(get.lb).toEqual({ strategy: "weighted", primaryWeight: 7, enabled: false, targets: [] });
        expect(spy).toHaveBeenCalledWith(expect.any(String), "client.lb.set", "svc-lb-set-ok", {
          strategy: "weighted",
          primaryWeight: 7,
          enabled: false,
        });
      } finally {
        spy.mockRestore();
      }
    });
  });

  // Kills the "always true"/"always false" complements of 21/22/23 and 24
  // (the BooleanLiteral `false` -> `true` flip, which would invert
  // `!== false` to `!== true`): with `enabled: true` explicitly, real
  // code keeps it true; the flipped mutant would wrongly compute false.
  test("enabled defaults to true when omitted, and true is preserved when explicit", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-lb-enabled-default");
      await fetch(`${baseUrl}/admin-api/clients/svc-lb-enabled-default/lb`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ strategy: "round-robin" }),
      });
      const get1 = (await (
        await fetch(`${baseUrl}/admin-api/clients/svc-lb-enabled-default/lb`, { headers: bearer() })
      ).json()) as { lb: { enabled: boolean } };
      expect(get1.lb.enabled).toBe(true);

      await reg("svc-lb-enabled-explicit-true");
      await fetch(`${baseUrl}/admin-api/clients/svc-lb-enabled-explicit-true/lb`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ strategy: "round-robin", enabled: true }),
      });
      const get2 = (await (
        await fetch(`${baseUrl}/admin-api/clients/svc-lb-enabled-explicit-true/lb`, { headers: bearer() })
      ).json()) as { lb: { enabled: boolean } };
      expect(get2.lb.enabled).toBe(true);
    });
  });

  // Kills 34/35 (the "client.lb.clear" action literal / the whole
  // `{lb: null}` clearing path) via a genuine clear after a real set.
  test("clearing an existing lb config is audited with the exact client.lb.clear action", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-lb-clear");
      await fetch(`${baseUrl}/admin-api/clients/svc-lb-clear/lb`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ strategy: "round-robin" }),
      });
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/clients/svc-lb-clear/lb`, {
          method: "PUT",
          headers: bearer(),
          body: JSON.stringify({ lb: null }),
        });
        expect(res.status).toBe(200);
        expect(spy).toHaveBeenCalledWith(expect.any(String), "client.lb.clear", "svc-lb-clear", undefined);
        const get = (await (
          await fetch(`${baseUrl}/admin-api/clients/svc-lb-clear/lb`, { headers: bearer() })
        ).json()) as { lb: unknown };
        expect(get.lb).toBeNull();
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("POST /admin-api/clients/:name/lb/upstreams", () => {
  // Kills 41/42/43 (POST's OWN independent copy of the ensureClientAccess
  // guard).
  test("a session caller from a different team gets the exact CLIENT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-lb-upstream-post-denied");
      const otherTeam = createTeam("team-lb-upstream-post-denied", "test");
      if (typeof otherTeam === "string") throw new Error("createTeam failed");
      setClientTeam("svc-lb-upstream-post-denied", otherTeam.id);
      const headers = teamSessionHeaders("lb-upstream-post-denied-user");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-lb-upstream-post-denied/lb/upstreams`, {
        method: "POST",
        headers,
        body: JSON.stringify({ baseUrl: "http://5.6.7.8" }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
    });
  });

  // Kills 44 (the `?? {}` body fallback flipped to `&&`).
  test("no request body at all is a graceful validation error, not a crash", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-lb-upstream-nobody");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-lb-upstream-nobody/lb/upstreams`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("baseUrl is required");
    });
  });

  // Kills 45/46/47/48/49 (the baseUrl typeof-ternary cluster: forced-true
  // would pass a non-string through, and downstream URL validation would
  // reject it or throw rather than gracefully 400 "required").
  test("a non-string baseUrl fails validation with the exact message", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-lb-upstream-badtype");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-lb-upstream-badtype/lb/upstreams`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ baseUrl: 12345 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("baseUrl is required");
    });
  });

  // Kills 62/63/64/65/66 (the CLIENT_NOT_FOUND-vs-400 ternary's "always
  // 404" direction) via an unknown client.
  test("an unknown client returns the exact CLIENT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-lb-upstream-never-registered/lb/upstreams`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ baseUrl: "http://5.6.7.8" }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
      expect(body.error.message).toBe("CLIENT_NOT_FOUND");
    });
  });

  // Kills the complementary "always 400" direction via a DIFFERENT
  // failure mode (an invalid weight on a real client) and 67 (the
  // `result.reason ?? result.error` fallback flipped to `&&`, which would
  // yield a literal `undefined` message instead of falling back to the
  // error code when no reason is present).
  test("an invalid weight on a real client returns the exact INVALID_WEIGHT 400", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-lb-upstream-badweight");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-lb-upstream-badweight/lb/upstreams`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ baseUrl: "http://5.6.7.8", weight: -5 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("INVALID_WEIGHT");
      expect(body.error.message).toBe("INVALID_WEIGHT");
    });
  });

  // Kills 50/51/52/53 (the weight typeof-ternary cluster) via an explicit
  // weight, verified through a follow-up read, and 68/69 (the recordAudit
  // detail literal) plus 70/71 (the response object/"added" literal).
  test("a fully valid upstream is added with the exact weight, audited, and returned", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-lb-upstream-ok");
      // getLb() returns null (no targets visible) unless a client_lb row
      // exists, independent of whether client_upstreams has entries.
      await fetch(`${baseUrl}/admin-api/clients/svc-lb-upstream-ok/lb`, {
        method: "PUT",
        headers: bearer(),
        body: JSON.stringify({ strategy: "round-robin" }),
      });
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/clients/svc-lb-upstream-ok/lb/upstreams`, {
          method: "POST",
          headers: bearer(),
          body: JSON.stringify({ baseUrl: "http://5.6.7.8", weight: 42 }),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { status: string; id: number };
        expect(body.status).toBe("added");
        expect(spy).toHaveBeenCalledWith(expect.any(String), "client.lb.upstream.add", "svc-lb-upstream-ok", {
          id: body.id,
          baseUrl: "http://5.6.7.8",
          weight: 42,
        });
        const get = (await (
          await fetch(`${baseUrl}/admin-api/clients/svc-lb-upstream-ok/lb`, { headers: bearer() })
        ).json()) as { lb: { targets: { id: number; weight: number }[] } | null };
        expect(get.lb?.targets.find((t) => t.id === body.id)?.weight).toBe(42);
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("PATCH /admin-api/clients/:name/lb/upstreams/:id", () => {
  async function seedUpstream(baseUrl: string, clientName: string): Promise<number> {
    await reg(clientName);
    // getLb() returns null (no targets visible) unless a client_lb row
    // exists, independent of whether client_upstreams has entries.
    await fetch(`${baseUrl}/admin-api/clients/${clientName}/lb`, {
      method: "PUT",
      headers: bearer(),
      body: JSON.stringify({ strategy: "round-robin" }),
    });
    await fetch(`${baseUrl}/admin-api/clients/${clientName}/lb/upstreams`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ baseUrl: "http://5.6.7.8" }),
    });
    const get = (await (
      await fetch(`${baseUrl}/admin-api/clients/${clientName}/lb`, { headers: bearer() })
    ).json()) as { lb: { targets: { id: number }[] } };
    return get.lb.targets[0].id;
  }

  // Kills 74/75/76 (PATCH's OWN independent copy of the
  // ensureClientAccess guard).
  test("a session caller from a different team gets the exact CLIENT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      const targetId = await seedUpstream(baseUrl, "svc-lb-upstream-patch-denied");
      const otherTeam = createTeam("team-lb-upstream-patch-denied", "test");
      if (typeof otherTeam === "string") throw new Error("createTeam failed");
      setClientTeam("svc-lb-upstream-patch-denied", otherTeam.id);
      const headers = teamSessionHeaders("lb-upstream-patch-denied-user");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-lb-upstream-patch-denied/lb/upstreams/${targetId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
    });
  });

  // Kills 77 (the `?? {}` body fallback flipped to `&&`).
  test("no request body at all does not crash and reports no changes", async () => {
    await withApp(async (baseUrl) => {
      const targetId = await seedUpstream(baseUrl, "svc-lb-upstream-patch-nobody");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-lb-upstream-patch-nobody/lb/upstreams/${targetId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(res.status).toBe(200);
    });
  });

  // Kills 82/83/84/85/86/87 (the enabled typeof-boolean cluster + exact
  // message).
  test("a non-boolean enabled fails validation with the exact message", async () => {
    await withApp(async (baseUrl) => {
      const targetId = await seedUpstream(baseUrl, "svc-lb-upstream-patch-badenabled");
      const res = await fetch(
        `${baseUrl}/admin-api/clients/svc-lb-upstream-patch-badenabled/lb/upstreams/${targetId}`,
        { method: "PATCH", headers: bearer(), body: JSON.stringify({ enabled: "true" }) },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("enabled must be a boolean");
    });
  });

  // Kills 92/93/94/95/96/97 (the weight typeof-number cluster + exact
  // message) -- distinct call site from POST's own copy.
  test("a non-number weight fails validation with the exact message", async () => {
    await withApp(async (baseUrl) => {
      const targetId = await seedUpstream(baseUrl, "svc-lb-upstream-patch-badweighttype");
      const res = await fetch(
        `${baseUrl}/admin-api/clients/svc-lb-upstream-patch-badweighttype/lb/upstreams/${targetId}`,
        { method: "PATCH", headers: bearer(), body: JSON.stringify({ weight: "5" }) },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("weight must be a number");
    });
  });

  // Kills 98/99/100/101/102/103/104/105 (the !result.ok guard and the
  // TARGET_NOT_FOUND-vs-400 ternary's "always 404" direction) via an
  // unknown upstream id.
  test("an unknown upstream id returns the exact TARGET_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-lb-upstream-patch-unknown");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-lb-upstream-patch-unknown/lb/upstreams/999999`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("TARGET_NOT_FOUND");
      expect(body.error.message).toBe("TARGET_NOT_FOUND");
    });
  });

  // Kills the complementary "always 400" direction via a DIFFERENT
  // failure mode: a syntactically-valid number that fails updateUpstream's
  // OWN stricter range check.
  test("a non-integer weight on a real target returns the exact INVALID_WEIGHT 400", async () => {
    await withApp(async (baseUrl) => {
      const targetId = await seedUpstream(baseUrl, "svc-lb-upstream-patch-rangebad");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-lb-upstream-patch-rangebad/lb/upstreams/${targetId}`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ weight: 1.5 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_WEIGHT");
    });
  });

  // Kills 78/79/80/81 and 88/89/90/91 (the `!== undefined` guards for
  // enabled/weight -- both must be independently skippable) and 106/107
  // (the recordAudit detail spread) plus 108/109 (the response
  // object/"updated" literal).
  test("a fully valid patch (both fields) is applied, audited, and returned", async () => {
    await withApp(async (baseUrl) => {
      const targetId = await seedUpstream(baseUrl, "svc-lb-upstream-patch-ok");
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/clients/svc-lb-upstream-patch-ok/lb/upstreams/${targetId}`, {
          method: "PATCH",
          headers: bearer(),
          body: JSON.stringify({ enabled: false, weight: 99 }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; id: number };
        expect(body).toEqual({ status: "updated", id: targetId });
        expect(spy).toHaveBeenCalledWith(expect.any(String), "client.lb.upstream.update", "svc-lb-upstream-patch-ok", {
          id: targetId,
          enabled: false,
          weight: 99,
        });
        const get = (await (
          await fetch(`${baseUrl}/admin-api/clients/svc-lb-upstream-patch-ok/lb`, { headers: bearer() })
        ).json()) as { lb: { targets: { id: number; enabled: boolean; weight: number }[] } };
        const target = get.lb.targets.find((t) => t.id === targetId);
        expect(target?.enabled).toBe(false);
        expect(target?.weight).toBe(99);
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("DELETE /admin-api/clients/:name/lb/upstreams/:id", () => {
  async function seedUpstream(baseUrl: string, clientName: string): Promise<number> {
    await reg(clientName);
    // getLb() returns null (no targets visible) unless a client_lb row
    // exists, independent of whether client_upstreams has entries.
    await fetch(`${baseUrl}/admin-api/clients/${clientName}/lb`, {
      method: "PUT",
      headers: bearer(),
      body: JSON.stringify({ strategy: "round-robin" }),
    });
    await fetch(`${baseUrl}/admin-api/clients/${clientName}/lb/upstreams`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ baseUrl: "http://5.6.7.8" }),
    });
    const get = (await (
      await fetch(`${baseUrl}/admin-api/clients/${clientName}/lb`, { headers: bearer() })
    ).json()) as { lb: { targets: { id: number }[] } };
    return get.lb.targets[0].id;
  }

  // Kills 112/113/114 (DELETE's OWN independent copy of the
  // ensureClientAccess guard).
  test("a session caller from a different team gets the exact CLIENT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      const targetId = await seedUpstream(baseUrl, "svc-lb-upstream-delete-denied");
      const otherTeam = createTeam("team-lb-upstream-delete-denied", "test");
      if (typeof otherTeam === "string") throw new Error("createTeam failed");
      setClientTeam("svc-lb-upstream-delete-denied", otherTeam.id);
      const headers = teamSessionHeaders("lb-upstream-delete-denied-user");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-lb-upstream-delete-denied/lb/upstreams/${targetId}`, {
        method: "DELETE",
        headers,
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
    });
  });

  // Kills 115/116/117/118/119 (the !result.ok guard) and the exact
  // code/message (`result.error` used as both).
  test("an unknown upstream id returns the exact TARGET_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-lb-upstream-delete-unknown");
      const res = await fetch(`${baseUrl}/admin-api/clients/svc-lb-upstream-delete-unknown/lb/upstreams/999999`, {
        method: "DELETE",
        headers: bearer(),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("TARGET_NOT_FOUND");
      expect(body.error.message).toBe("TARGET_NOT_FOUND");
    });
  });

  // Kills 119 (the recordAudit action string emptied) and 120/121 (the
  // response object/"removed" literal emptied) -- verified both via the
  // response body and a follow-up read proving genuine removal.
  test("a successful removal is audited and returns the exact response shape", async () => {
    await withApp(async (baseUrl) => {
      const targetId = await seedUpstream(baseUrl, "svc-lb-upstream-delete-ok");
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/clients/svc-lb-upstream-delete-ok/lb/upstreams/${targetId}`, {
          method: "DELETE",
          headers: bearer(),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; id: number };
        expect(body).toEqual({ status: "removed", id: targetId });
        expect(spy).toHaveBeenCalledWith(expect.any(String), "client.lb.upstream.remove", "svc-lb-upstream-delete-ok", {
          id: targetId,
        });
        const get = (await (
          await fetch(`${baseUrl}/admin-api/clients/svc-lb-upstream-delete-ok/lb`, { headers: bearer() })
        ).json()) as { lb: { targets: { id: number }[] } };
        expect(get.lb.targets.some((t) => t.id === targetId)).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
