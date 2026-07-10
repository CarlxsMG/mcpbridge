/**
 * Stryker mutation-testing backstop for src/routes/admin/users.ts — domain 8.
 * Baseline: 114 mutants, 54 killed / 60 survived — existing coverage (in
 * routes-admin.test.ts, left untouched here) covers the create/list/delete
 * happy path, duplicate-username 409, last-admin-protected on delete,
 * last-admin-protected on demote-to-viewer via PATCH, and CAN-delete-when-
 * another-admin-exists, but never asserts exact codes/messages/audit
 * details, never exercises PATCH's is_active branch or its own last-admin
 * guard, never tests an unknown username on PATCH, and never verifies the
 * username-trim/role-default/type-coercion ternaries. All line:col
 * citations below were read directly from reports/mutation/result.json.
 */
import { describe, test, expect, spyOn } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { createUser, updateUser, findUserByUsername } from "../../security/user-store.js";
import * as sessionStoreMod from "../../security/session-store.js";
import * as auditMod from "../../admin/audit/audit.js";

const ADMIN_KEY = "test-admin-key-users-mut";

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

async function withApp(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const { baseUrl, server } = await startApp();
  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("POST /admin-api/users — validation", () => {
  // Kills 8 (forced-true would call `.trim()` on a non-string, throwing),
  // 14 (the "" fallback replaced with a truthy placeholder that would
  // wrongly pass validation).
  test("a non-string username fails validation gracefully (not a crash)", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/users`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ username: 12345, password: "correct-horse-battery-staple" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // Kills 15 (forced-true would let a non-string password's raw value
  // through, whose `.length` on e.g. a number is `undefined`, silently
  // bypassing the length check) and 19 (the "" fallback replaced with a
  // truthy 18-char placeholder that would wrongly pass the length check).
  test("a non-string password fails validation (not coerced to a valid length)", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/users`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ username: "users-mut-badpass", password: 123456789012 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("username and password (min 12 chars) are required");
    });
  });

  // Kills 22/23 (the whole `!username || ...` condition forced-false /
  // &&-flip, which would never validate) and 28/29 (the validation branch
  // body and exact message emptied).
  test("a missing username fails validation with the exact message", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/users`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ password: "correct-horse-battery-staple" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("username and password (min 12 chars) are required");
    });
  });

  // Kills 25 (forced-false on `password.length < 12`, which would never
  // reject a short password) via an 11-char password.
  test("an 11-character password fails validation", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/users`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ username: "users-mut-shortpass", password: "12345678901" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // Kills 26 (`<` flipped to `<=`, which would wrongly reject an
  // exactly-12-char password) via the boundary itself.
  test("an exactly-12-character password passes validation", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/users`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ username: "users-mut-boundarypass", password: "123456789012" }),
      });
      expect(res.status).toBe(201);
    });
  });

  // Kills 33/34 (the USER_EXISTS code/message emptied) -- the existing
  // duplicate-username test in routes-admin.test.ts only checks the
  // status code, not the exact envelope.
  test("a duplicate username returns the exact USER_EXISTS 409", async () => {
    await withApp(async (baseUrl) => {
      createUser("users-mut-dup", "irrelevant-hash", "viewer", null);
      const res = await fetch(`${baseUrl}/admin-api/users`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ username: "users-mut-dup", password: "correct-horse-battery-staple" }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("USER_EXISTS");
      expect(body.error.message).toBe("A user with that username already exists");
    });
  });
});

describe("POST /admin-api/users — success", () => {
  // Kills 13 (the `.trim().toLowerCase()` chain dropped entirely) via a
  // mixed-case, whitespace-padded username.
  test("a username is trimmed and lowercased before storage", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/users`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ username: "  UsersMutCaseTest  ", password: "correct-horse-battery-staple" }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { username: string };
      expect(body.username).toBe("usersmutcasetest");
    });
  });

  // Kills 20 (the "admin" role default emptied to "") via omitting `role`
  // entirely.
  test("an omitted role defaults to admin", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/users`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ username: "users-mut-defaultrole", password: "correct-horse-battery-staple" }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { role: string };
      expect(body.role).toBe("admin");
    });
  });

  // Kills 35/36 (the recordAudit action string and detail object emptied)
  // and 37 (the response object emptied).
  test("a fully valid creation is audited and returns the exact response shape", async () => {
    await withApp(async (baseUrl) => {
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/users`, {
          method: "POST",
          headers: bearer(),
          body: JSON.stringify({
            username: "users-mut-create-ok",
            password: "correct-horse-battery-staple",
            role: "operator",
          }),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { username: string; role: string; is_active: boolean };
        expect(body).toEqual({ username: "users-mut-create-ok", role: "operator", is_active: true });
        expect(spy).toHaveBeenCalledWith(expect.any(String), "user.create", "users-mut-create-ok", {
          role: "operator",
        });
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("PATCH /admin-api/users/:username", () => {
  // Kills 43/44/45/46 (the !existing guard's forced-false/block/exact
  // code+message) -- unlike routes-admin.test.ts's PATCH tests, which all
  // operate on a pre-existing user.
  test("an unknown username returns the exact USER_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/users/users-mut-never-created`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ role: "viewer" }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("USER_NOT_FOUND");
      expect(body.error.message).toBe("User not found");
    });
  });

  // Kills 47/48/49/50 (the typeof-boolean ternary's forced directions).
  // Forced-true is the tricky direction: it passes body.is_active's RAW
  // value through to `updateUser`, where `isActive ? 1 : 0` coerces ANY
  // truthy string (including "true") to active=1 -- the SAME outcome as
  // an already-active user being correctly left alone. A FALSY non-string
  // value (empty string) is required to distinguish: real code ignores it
  // (stays active), the mutant's raw "" coerces to active=0 (deactivated).
  test("a non-boolean, falsy is_active is ignored, leaving the current state untouched", async () => {
    await withApp(async (baseUrl) => {
      createUser("users-mut-badactive", "irrelevant-hash", "viewer", null);
      const res = await fetch(`${baseUrl}/admin-api/users/users-mut-badactive`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ is_active: "" }),
      });
      expect(res.status).toBe(200);
      const stored = findUserByUsername("users-mut-badactive");
      expect(stored?.isActive).toBe(true);
    });
  });

  // Kills 51/53/54/55/56/59/62/63/65/67/71/73/74/78/79 (the
  // wouldLoseAdminStatus compound + outer guard's role-demotion branch)
  // with an exact message, complementing routes-admin.test.ts's
  // status-only assertion.
  test("demoting the sole active admin returns the exact LAST_ADMIN_PROTECTED 409", async () => {
    await withApp(async (baseUrl) => {
      createUser("users-mut-soleadmin-role", "irrelevant-hash", "admin", null);
      const res = await fetch(`${baseUrl}/admin-api/users/users-mut-soleadmin-role`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ role: "viewer" }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("LAST_ADMIN_PROTECTED");
      expect(body.error.message).toBe("Cannot demote or deactivate the last active admin");
    });
  });

  // Kills 68/69/70 (the `nextActive === false` sub-clause's forced/equality
  // directions) -- the OTHER OR-branch of wouldLoseAdminStatus, never
  // exercised by the existing role-demotion-only test.
  test("deactivating the sole active admin returns the exact LAST_ADMIN_PROTECTED 409", async () => {
    await withApp(async (baseUrl) => {
      createUser("users-mut-soleadmin-active", "irrelevant-hash", "admin", null);
      const res = await fetch(`${baseUrl}/admin-api/users/users-mut-soleadmin-active`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ is_active: false }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("LAST_ADMIN_PROTECTED");
    });
  });

  // Kills 65/67 (the `nextRole !== "admin"` sub-clause's forced-true
  // direction, which would treat a no-op "admin"->"admin" PATCH as a
  // demotion) and complements 74 (a genuine `countActiveAdmins() <= 1`
  // scenario that must NOT be blocked when the "new" role isn't actually
  // a demotion).
  test('PATCHing the sole admin\'s role to "admin" (a no-op) succeeds', async () => {
    await withApp(async (baseUrl) => {
      createUser("users-mut-soleadmin-noop", "irrelevant-hash", "admin", null);
      const res = await fetch(`${baseUrl}/admin-api/users/users-mut-soleadmin-noop`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ role: "admin" }),
      });
      expect(res.status).toBe(200);
    });
  });

  // Kills 63 (the `nextRole !== undefined` sub-check forced-true, which
  // would treat an OMITTED role -- `undefined !== "admin"` is true -- as a
  // demotion all by itself). Sends only `is_active: true` (a genuine no-op
  // reactivation that never sets `nextActive === false`), on the sole
  // active admin, with no `role` field at all: real code never enters
  // either OR-branch and succeeds; the mutant's forced-true role-branch
  // fires anyway and wrongly returns 409.
  test("reactivating the sole admin with no role field succeeds", async () => {
    await withApp(async (baseUrl) => {
      createUser("users-mut-soleadmin-reactivate", "irrelevant-hash", "admin", null);
      const res = await fetch(`${baseUrl}/admin-api/users/users-mut-soleadmin-reactivate`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ is_active: true }),
      });
      expect(res.status).toBe(200);
    });
  });

  // Kills the complementary "always false" direction of 71/73/74 (the
  // `&& countActiveAdmins() <= 1` guard) via a SECOND active admin present
  // -- PATCH's own version of the "CAN delete when another admin exists"
  // scenario, verified with a follow-up read proving the role genuinely
  // changed (kills 80's ObjectLiteral emptied on updateUser's patch arg).
  test("demoting an admin succeeds when another active admin still exists", async () => {
    await withApp(async (baseUrl) => {
      createUser("users-mut-multi-admin-a", "irrelevant-hash", "admin", null);
      createUser("users-mut-multi-admin-b", "irrelevant-hash", "admin", null);
      const res = await fetch(`${baseUrl}/admin-api/users/users-mut-multi-admin-a`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ role: "viewer" }),
      });
      expect(res.status).toBe(200);
      const stored = findUserByUsername("users-mut-multi-admin-a");
      expect(stored?.role).toBe("viewer");
    });
  });

  // Kills 56 (the `existing.role === "admin"` conjunct's forced-true
  // direction): a NON-admin user's is_active change must never be gated
  // by the last-admin protection, even when only one real admin exists
  // elsewhere.
  test("deactivating a non-admin user succeeds even with only one admin in the system", async () => {
    await withApp(async (baseUrl) => {
      createUser("users-mut-onlyadmin-elsewhere", "irrelevant-hash", "admin", null);
      createUser("users-mut-nonadmin-target", "irrelevant-hash", "viewer", null);
      const res = await fetch(`${baseUrl}/admin-api/users/users-mut-nonadmin-target`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ is_active: false }),
      });
      expect(res.status).toBe(200);
    });
  });

  // Kills the `existing.isActive` conjunct's forced-true direction
  // (part of the 55 LogicalOperator cluster): an ALREADY-inactive admin's
  // role change must never be gated by the last-admin protection.
  test("changing an already-inactive admin's role succeeds even as the only admin", async () => {
    await withApp(async (baseUrl) => {
      createUser("users-mut-inactive-admin", "irrelevant-hash", "admin", null);
      updateUser("users-mut-inactive-admin", { isActive: false });
      const res = await fetch(`${baseUrl}/admin-api/users/users-mut-inactive-admin`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ role: "viewer" }),
      });
      expect(res.status).toBe(200);
    });
  });

  // Kills 81/82/83/84 (the `nextActive === false` cluster gating
  // revokeAllSessionsForUser) via both directions: deactivating calls it,
  // any other update does not.
  test("deactivating a user revokes their sessions; other updates do not", async () => {
    await withApp(async (baseUrl) => {
      createUser("users-mut-revoke-a", "irrelevant-hash", "viewer", null);
      createUser("users-mut-revoke-b", "irrelevant-hash", "viewer", null);
      const spy = spyOn(sessionStoreMod, "revokeAllSessionsForUser");
      try {
        await fetch(`${baseUrl}/admin-api/users/users-mut-revoke-a`, {
          method: "PATCH",
          headers: bearer(),
          body: JSON.stringify({ role: "operator" }),
        });
        expect(spy).not.toHaveBeenCalled();

        await fetch(`${baseUrl}/admin-api/users/users-mut-revoke-b`, {
          method: "PATCH",
          headers: bearer(),
          body: JSON.stringify({ is_active: false }),
        });
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });
  });

  // Kills 85/86 (the recordAudit action string and detail object emptied)
  // and 87/88 (the response object and "updated" literal emptied).
  test("a successful update is audited and returns the exact response shape", async () => {
    await withApp(async (baseUrl) => {
      createUser("users-mut-patch-ok", "irrelevant-hash", "viewer", null);
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/users/users-mut-patch-ok`, {
          method: "PATCH",
          headers: bearer(),
          body: JSON.stringify({ role: "operator" }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; username: string };
        expect(body).toEqual({ status: "updated", username: "users-mut-patch-ok" });
        expect(spy).toHaveBeenCalledWith(expect.any(String), "user.update", "users-mut-patch-ok", {
          role: "operator",
          is_active: undefined,
        });
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("DELETE /admin-api/users/:username", () => {
  // Kills 93/94/95/96 (the !existing guard's forced-false/block/exact
  // code+message) -- routes-admin.test.ts never exercises an unknown
  // username on DELETE.
  test("an unknown username returns the exact USER_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/users/users-mut-never-created-del`, {
        method: "DELETE",
        headers: bearer(),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("USER_NOT_FOUND");
      expect(body.error.message).toBe("User not found");
    });
  });

  // Kills 110 (the LAST_ADMIN_PROTECTED message emptied) -- the existing
  // "cannot delete the last active admin" test only checks the code.
  test("deleting the sole active admin returns the exact protection message", async () => {
    await withApp(async (baseUrl) => {
      createUser("users-mut-soleadmin-delete", "irrelevant-hash", "admin", null);
      const res = await fetch(`${baseUrl}/admin-api/users/users-mut-soleadmin-delete`, {
        method: "DELETE",
        headers: bearer(),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("Cannot delete the last active admin");
    });
  });

  // Kills 111 (the recordAudit action string emptied), 112 (the response
  // object emptied), and 113 ("deleted" literal emptied).
  test("a successful deletion is audited and returns the exact response shape", async () => {
    await withApp(async (baseUrl) => {
      createUser("users-mut-delete-ok", "irrelevant-hash", "viewer", null);
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/users/users-mut-delete-ok`, {
          method: "DELETE",
          headers: bearer(),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; username: string };
        expect(body).toEqual({ status: "deleted", username: "users-mut-delete-ok" });
        expect(spy).toHaveBeenCalledWith(expect.any(String), "user.delete", "users-mut-delete-ok");
      } finally {
        spy.mockRestore();
      }
    });
  });
});
