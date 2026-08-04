/**
 * Route-level contract for GET /admin-api/security-posture.
 *
 * The payload itself is covered by src/security/__tests__/security-posture.test.ts;
 * what matters here is the boundary. This endpoint enumerates which protections
 * are OFF, which is worth reading only to someone who can change them and is
 * worth hiding from everyone else — so a viewer/operator session must get the
 * same 403 as any other admin-only mutation, not a partial answer.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { Server } from "http";
import { listen } from "../../__tests__/_utils/app.js";
import { bearerHeaders, setAdminApiKeys } from "../../__tests__/_utils/admin-auth.js";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { createUser } from "../../security/user-store.js";
import { createSession } from "../../security/session-store.js";
import { SESSION_COOKIE_NAME } from "../../security/cookies.js";

let baseUrl = "";
let activeServer: Server | null = null;
const ADMIN_KEY = "test-admin-key-security-posture";

beforeEach(async () => {
  __resetDbForTesting();
  setAdminApiKeys([ADMIN_KEY]);
  (config as Record<string, unknown>).authDisabled = false;

  const { adminRoutes } = await import("../../routes/admin.js");
  const app = express();
  app.use(express.json());
  adminRoutes(app);
  ({ baseUrl, server: activeServer } = await listen(app));
});

afterEach(() => {
  activeServer?.close();
  activeServer = null;
});

/**
 * Creates a user with `role` and returns a session cookie header for it. The
 * password hash is irrelevant here — these tests never go through login, they
 * mint the session directly.
 */
function sessionCookie(username: string, role: "admin" | "operator" | "viewer"): string {
  const user = createUser(username, "irrelevant-hash", role, null);
  const session = createSession(user.id, "127.0.0.1", "test-agent");
  return `${SESSION_COOKIE_NAME}=${session.token}`;
}

describe("GET /admin-api/security-posture", () => {
  test("a bearer caller gets the posture", async () => {
    const res = await fetch(`${baseUrl}/admin-api/security-posture`, { headers: bearerHeaders(ADMIN_KEY) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { findings: unknown[]; worst: string | null };
    expect(Array.isArray(body.findings)).toBe(true);
    // `worst` is present in both states — null is a real answer here ("nothing
    // to report"), not a missing field.
    expect(body).toHaveProperty("worst");
  });

  test("an admin session gets the posture", async () => {
    const res = await fetch(`${baseUrl}/admin-api/security-posture`, {
      headers: { Cookie: sessionCookie("posture-admin", "admin") },
    });
    expect(res.status).toBe(200);
  });

  test.each([["operator"], ["viewer"]] as const)("a %s session is refused", async (role) => {
    const res = await fetch(`${baseUrl}/admin-api/security-posture`, {
      headers: { Cookie: sessionCookie(`posture-${role}`, role) },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  test("an unauthenticated caller is refused", async () => {
    const res = await fetch(`${baseUrl}/admin-api/security-posture`);
    expect(res.status).toBe(401);
  });
});
