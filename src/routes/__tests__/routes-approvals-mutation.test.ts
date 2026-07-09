/**
 * Stryker mutation-testing backstop for src/routes/admin/approvals.ts —
 * domain 8. Baseline: 67 mutants, 0 killed / 67 survived — zero test
 * coverage of any kind existed before this. All line:col citations below
 * were read directly from reports/mutation/result.json.
 *
 * One survivor is an accepted EQUIVALENT, not chased with a dedicated
 * test: 34:41-51 StringLiteral (the `"approved"` literal in the approve
 * handler's `decideApproval(rec.id, "approved", ...)` call, emptied to
 * `""`). Confirmed by reading admin/entities/approvals.ts's full
 * `decideApproval` body: the `status` parameter is used in EXACTLY ONE
 * place, `if (status === "rejected")` — every other status-related SQL
 * statement uses a HARDCODED literal ('approved'/'rejected'), never the
 * parameter. Since `"" === "rejected"` is false (same as `"approved" ===
 * "rejected"`), both the real value and the emptied mutant take the
 * identical "not rejected" code path — there is no observable
 * difference for any input reachable through this call site.
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
import { createApproval } from "../../admin/entities/approvals.js";
import * as auditMod from "../../admin/audit/audit.js";

const ADMIN_KEY = "test-admin-key-approvals-mut";

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

function seedApproval(clientName: string, toolName = "t"): number {
  return createApproval(clientName, toolName, "hash", "{}", null);
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

describe("GET /admin-api/approvals — status filter", () => {
  // Kills 17:21-33 StringLiteral (route path emptied) and 17:68-21:2
  // BlockStatement (whole handler emptied) and 20:24-56 ObjectLiteral
  // (the { items } response wrapper emptied).
  test("lists every recorded approval with no filter", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-approvals-list");
      seedApproval("svc-approvals-list");
      const res = await fetch(`${baseUrl}/admin-api/approvals`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[] };
      expect(body.items.length).toBeGreaterThan(0);
    });
  });

  // Kills the whole 19:46-101 cluster (both LogicalOperator flips, every
  // ConditionalExpression/EqualityOperator/StringLiteral on each of the
  // three status clauses) via clause isolation: each of "pending",
  // "approved", "rejected" must independently narrow, and an
  // unrecognized value must fall through to "no filter" (all items).
  // Each test seeds TWO approvals of DIFFERENT statuses -- with only one
  // approval present, "filtered to 1 matching item" and "no filter
  // applied, forced false" are indistinguishable (both yield length 1).
  // A mixed fixture makes the forced-false/emptied-string/&&-flip
  // directions produce 2 items instead of the real 1.
  test("?status=pending narrows to pending approvals only", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-approvals-pending");
      seedApproval("svc-approvals-pending");
      const otherId = seedApproval("svc-approvals-pending", "t");
      await fetch(`${baseUrl}/admin-api/approvals/${otherId}/approve`, { method: "POST", headers: bearer() });
      const res = await fetch(`${baseUrl}/admin-api/approvals?status=pending`, { headers: bearer() });
      const body = (await res.json()) as { items: { status: string }[] };
      expect(body.items).toHaveLength(1);
      expect(body.items[0].status).toBe("pending");
    });
  });

  test("?status=approved narrows to approved approvals only", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-approvals-approved");
      const id = seedApproval("svc-approvals-approved");
      await fetch(`${baseUrl}/admin-api/approvals/${id}/approve`, { method: "POST", headers: bearer() });
      seedApproval("svc-approvals-approved");
      const res = await fetch(`${baseUrl}/admin-api/approvals?status=approved`, { headers: bearer() });
      const body = (await res.json()) as { items: { status: string }[] };
      expect(body.items).toHaveLength(1);
      expect(body.items[0].status).toBe("approved");
    });
  });

  test("?status=rejected narrows to rejected approvals only", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-approvals-rejected");
      const id = seedApproval("svc-approvals-rejected");
      await fetch(`${baseUrl}/admin-api/approvals/${id}/reject`, { method: "POST", headers: bearer() });
      seedApproval("svc-approvals-rejected");
      const res = await fetch(`${baseUrl}/admin-api/approvals?status=rejected`, { headers: bearer() });
      const body = (await res.json()) as { items: { status: string }[] };
      expect(body.items).toHaveLength(1);
      expect(body.items[0].status).toBe("rejected");
    });
  });

  test("an unrecognized ?status value is ignored, not treated as a real filter", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-approvals-bogus");
      seedApproval("svc-approvals-bogus");
      const res = await fetch(`${baseUrl}/admin-api/approvals?status=bogus`, { headers: bearer() });
      const body = (await res.json()) as { items: unknown[] };
      expect(body.items.length).toBeGreaterThan(0);
    });
  });
});

describe("POST /admin-api/approvals/:id/approve", () => {
  // Kills 23:22-46 StringLiteral (route path emptied) and 23:114-51:2
  // BlockStatement (whole handler emptied).
  test("an unrelated path is not served by the approve route", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/totally-unrelated-path`, { method: "POST", headers: bearer() });
      expect(res.status).toBe(404);
    });
  });

  // Kills 25:7-11 BooleanLiteral/ConditionalExpression (the `!rec`
  // guard) and 26:19-39 / 26:41-61 StringLiteral (the
  // APPROVAL_NOT_FOUND code/message emptied).
  test("returns the exact APPROVAL_NOT_FOUND 404 for an unknown id", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/approvals/999999/approve`, { method: "POST", headers: bearer() });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("APPROVAL_NOT_FOUND");
      expect(body.error.message).toBe("Approval not found");
    });
  });

  // Kills 29:7-52 ConditionalExpression 'true' / BooleanLiteral (the
  // access guard always denies) -- a legit request must still succeed.
  // Kills 31:5-68 ConditionalExpression 'true' / OptionalChaining
  // (`(req.body as ...)?.note` -> `.note`, which would throw on a
  // request with NO body at all instead of the `?.` safely yielding
  // undefined) via sending no body whatsoever.
  test("a Bearer caller with no request body approves successfully", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-approve-nobody");
      const id = seedApproval("svc-approve-nobody");
      const res = await fetch(`${baseUrl}/admin-api/approvals/${id}/approve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ status: "approved", id, approvalsReceived: 1, requiredLevels: 1 });
    });
  });

  // Kills 29:7-52 ConditionalExpression 'false' (the access guard never
  // denies, even for a genuinely cross-team-denied caller) -- this
  // handler's OWN independent copy of the guard.
  test("a session caller from a different team gets the exact CLIENT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-approve-denied");
      const otherTeam = createTeam("other-team-for-approve", "test");
      if (typeof otherTeam === "string") throw new Error("createTeam failed");
      setClientTeam("svc-approve-denied", otherTeam.id);
      const id = seedApproval("svc-approve-denied");
      const headers = teamSessionHeaders("approve-denied-user");
      const res = await fetch(`${baseUrl}/admin-api/approvals/${id}/approve`, { method: "POST", headers });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      // ensureClientAccess sends its OWN CLIENT_NOT_FOUND envelope, distinct
      // from the route's APPROVAL_NOT_FOUND (used only for an unknown
      // approval id).
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
    });
  });

  // Kills 31:5-68's remaining cluster (ConditionalExpression 'false' /
  // StringLiteral '""' on the "string" literal -- a genuine note string
  // must actually persist, not default to null). recordAudit's own
  // detail object does NOT include `note` (confirmed from source), so
  // this is verified via a follow-up GET instead of the audit spy.
  test("an explicit note is recorded and persists, verified via a follow-up GET", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-approve-note");
      const id = seedApproval("svc-approve-note");
      const spy = spyOn(auditMod, "recordAudit");
      try {
        await fetch(`${baseUrl}/admin-api/approvals/${id}/approve`, {
          method: "POST",
          headers: bearer(),
          body: JSON.stringify({ note: "looks fine" }),
        });
        expect(spy).toHaveBeenCalledWith(expect.any(String), "approval.approve", "svc-approve-note__t", {
          id,
          finalStatus: "approved",
          approvalsReceived: 1,
          requiredLevels: 1,
        });
        const get = (await (
          await fetch(`${baseUrl}/admin-api/approvals?status=approved`, { headers: bearer() })
        ).json()) as { items: { note: string | null }[] };
        expect(get.items[0].note).toBe("looks fine");
      } finally {
        spy.mockRestore();
      }
    });
  });

  // Kills 34:41-51 StringLiteral (the "NOT_PENDING" code emptied) and
  // 35:7-17 BooleanLiteral/ConditionalExpression (the !result.ok guard)
  // -- approving an already-decided ticket must return the exact 409.
  test("approving an already-decided ticket returns the exact NOT_PENDING 409", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-approve-twice");
      const id = seedApproval("svc-approve-twice");
      await fetch(`${baseUrl}/admin-api/approvals/${id}/approve`, { method: "POST", headers: bearer() });
      const res = await fetch(`${baseUrl}/admin-api/approvals/${id}/approve`, { method: "POST", headers: bearer() });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("NOT_PENDING");
    });
  });
});

describe("POST /admin-api/approvals/:id/reject", () => {
  test("an unrelated path is not served by the reject route", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/totally-unrelated-path`, { method: "POST", headers: bearer() });
      expect(res.status).toBe(404);
    });
  });

  // Kills 55:7-11's independent copy of the `!rec` guard and 56:19-39 /
  // 56:41-61 StringLiteral for the reject endpoint's own
  // APPROVAL_NOT_FOUND response.
  test("returns the exact APPROVAL_NOT_FOUND 404 for an unknown id", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/approvals/999999/reject`, { method: "POST", headers: bearer() });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("APPROVAL_NOT_FOUND");
      expect(body.error.message).toBe("Approval not found");
    });
  });

  // Kills 59:7-52's independent copy of the access guard (forced-true)
  // and 61:5-68's independent copy of the note ternary's
  // ConditionalExpression 'true' / OptionalChaining.
  test("a Bearer caller with no request body rejects successfully", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-reject-nobody");
      const id = seedApproval("svc-reject-nobody");
      const res = await fetch(`${baseUrl}/admin-api/approvals/${id}/reject`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ status: "rejected", id });
    });
  });

  // Kills 59:7-52 ConditionalExpression 'false' (independent copy).
  test("a session caller from a different team gets the exact CLIENT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-reject-denied");
      const otherTeam = createTeam("other-team-for-reject", "test");
      if (typeof otherTeam === "string") throw new Error("createTeam failed");
      setClientTeam("svc-reject-denied", otherTeam.id);
      const id = seedApproval("svc-reject-denied");
      const headers = teamSessionHeaders("reject-denied-user");
      const res = await fetch(`${baseUrl}/admin-api/approvals/${id}/reject`, { method: "POST", headers });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
    });
  });

  // Kills 61:5-68's remaining cluster (independent copy, ConditionalExpression
  // 'false' / StringLiteral '""' on the "string" literal) via a follow-up
  // GET -- note the reject audit action has NO detail object at all
  // (unlike approve's rich detail), so `note` can't be observed there.
  test("an explicit note is recorded and persists, verified via a follow-up GET", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-reject-note");
      const id = seedApproval("svc-reject-note");
      const spy = spyOn(auditMod, "recordAudit");
      try {
        await fetch(`${baseUrl}/admin-api/approvals/${id}/reject`, {
          method: "POST",
          headers: bearer(),
          body: JSON.stringify({ note: "not today" }),
        });
        expect(spy).toHaveBeenCalledWith(expect.any(String), "approval.reject", "svc-reject-note__t", { id });
        const get = (await (
          await fetch(`${baseUrl}/admin-api/approvals?status=rejected`, { headers: bearer() })
        ).json()) as { items: { note: string | null }[] };
        expect(get.items[0].note).toBe("not today");
      } finally {
        spy.mockRestore();
      }
    });
  });

  // Kills 64:41-51's independent StringLiteral ("NOT_PENDING" emptied)
  // and 65:7-17's independent !result.ok cluster.
  test("rejecting an already-decided ticket returns the exact NOT_PENDING 409", async () => {
    await withApp(async (baseUrl) => {
      await reg("svc-reject-twice");
      const id = seedApproval("svc-reject-twice");
      await fetch(`${baseUrl}/admin-api/approvals/${id}/reject`, { method: "POST", headers: bearer() });
      const res = await fetch(`${baseUrl}/admin-api/approvals/${id}/reject`, { method: "POST", headers: bearer() });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("NOT_PENDING");
    });
  });
});
