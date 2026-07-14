/**
 * Regression test for the tenant-isolation boundary (fix: confine team-scoped
 * admins to their own tenant).
 *
 * The genuinely-global admin routes — user CRUD, DB backup, and config export —
 * must require a SUPER-admin (admin role + no team), not merely the admin role.
 * Otherwise a team-scoped admin could escalate (a teamless role:"admin" user IS a
 * super-admin, so creating one is a direct escalation), exfiltrate the whole
 * multi-tenant DB via backup, or read/rewrite another tenant's config. Bearer/CI
 * callers and the teamless bootstrap admin must still pass.
 *
 * These assert the DENIED half of that boundary — the existing route tests only
 * ever call as the env Bearer (always a super-admin), so nothing pinned the
 * team-scoped-admin rejection until this file.
 */
import { describe, test, expect } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { createUser } from "../../security/user-store.js";
import { createSession } from "../../security/session-store.js";
import { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } from "../../security/cookies.js";
import { createTeam, setUserTeam } from "../../admin/entities/teams.js";

const ADMIN_KEY = "test-admin-key-tenant-iso";

async function startApp(): Promise<{ baseUrl: string; server: Server }> {
  __resetDbForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  // users lives under adminRoutes; backup + config-io self-mount (own adminAuth).
  const { adminRoutes } = await import("../../routes/admin.js");
  const { backupRoutes } = await import("../../routes/backup.js");
  const { configIoRoutes } = await import("../../routes/config-io.js");
  const app = express();
  app.use(express.json());
  adminRoutes(app);
  backupRoutes(app);
  configIoRoutes(app);
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

/** A session for an admin-role user scoped to a real team — i.e. NOT a super-admin. */
function teamAdminHeaders(username: string): Record<string, string> {
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("tenant isolation — global admin routes require super-admin", () => {
  test("a team-scoped admin cannot create users (would be a teamless super-admin)", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/users`, {
        method: "POST",
        headers: teamAdminHeaders("iso-create"),
        body: JSON.stringify({ username: "escalated", password: "correct-horse-battery-staple", role: "admin" }),
      });
      expect(res.status).toBe(403);
    });
  });

  test("a team-scoped admin cannot download the multi-tenant DB backup", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/backup`, {
        method: "POST",
        headers: teamAdminHeaders("iso-backup"),
      });
      expect(res.status).toBe(403);
    });
  });

  test("a team-scoped admin cannot export another tenant's config", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/config/export`, {
        headers: teamAdminHeaders("iso-export"),
      });
      expect(res.status).toBe(403);
    });
  });

  test("a super-admin (env Bearer) still passes the same global routes", async () => {
    await withApp(async (baseUrl) => {
      const exported = await fetch(`${baseUrl}/admin-api/config/export`, { headers: bearer() });
      expect(exported.status).toBe(200);

      const created = await fetch(`${baseUrl}/admin-api/users`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ username: "legit-admin", password: "correct-horse-battery-staple", role: "admin" }),
      });
      expect(created.status).toBe(201);
    });
  });
});
