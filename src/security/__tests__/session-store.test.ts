import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { __resetDbForTesting, getDb } from "../../db/connection.js";
import { config } from "../../config.js";
import { createUser, updateUser } from "../../security/user-store.js";
import {
  createSession,
  validateSession,
  revokeSession,
  revokeAllSessionsForUser,
  listActiveSessionsForUser,
  revokeSessionById,
} from "../../security/session-store.js";

const realNow = Date.now.bind(Date);

beforeEach(() => {
  __resetDbForTesting();
});

afterEach(() => {
  Date.now = realNow;
});

function makeUser(username = "alice") {
  return createUser(username, "irrelevant-hash", "admin", null);
}

describe("createSession / validateSession — happy path", () => {
  test("a freshly-created session validates successfully and returns the right identity", () => {
    const user = makeUser();
    const session = createSession(user.id, "127.0.0.1", "test-agent");

    const ctx = validateSession(session.token);
    expect(ctx).not.toBeNull();
    expect(ctx?.userId).toBe(user.id);
    expect(ctx?.username).toBe("alice");
    expect(ctx?.role).toBe("admin");
    expect(ctx?.csrfToken).toBe(session.csrfToken);
  });

  test("the raw token is never stored in plaintext — DB only has a hash", () => {
    const user = makeUser();
    const session = createSession(user.id, undefined, undefined);

    const row = getDb().query(`SELECT token_hash FROM admin_sessions WHERE user_id = ?`).get(user.id) as {
      token_hash: string;
    };
    expect(row.token_hash).not.toBe(session.token);
    expect(row.token_hash).toHaveLength(64); // SHA-256 hex
  });

  test("an unknown token returns null", () => {
    expect(validateSession("this-token-does-not-exist")).toBeNull();
  });
});

describe("validateSession — revocation and expiry", () => {
  test("a revoked session no longer validates", () => {
    const user = makeUser();
    const session = createSession(user.id, undefined, undefined);
    revokeSession(session.token);

    expect(validateSession(session.token)).toBeNull();
  });

  test("a session past its absolute expiry does not validate", () => {
    const user = makeUser();
    const session = createSession(user.id, undefined, undefined);

    Date.now = () => realNow() + config.sessionAbsoluteTtlMs + 1000;
    expect(validateSession(session.token)).toBeNull();
  });

  test("a session idle past sessionIdleTimeoutMs does not validate, even though it hasn't hit absolute expiry", () => {
    const user = makeUser();
    const session = createSession(user.id, undefined, undefined);

    Date.now = () => realNow() + config.sessionIdleTimeoutMs + 1000;
    expect(validateSession(session.token)).toBeNull();
  });

  test("validating a session touches last_seen_at, sliding the idle window forward", () => {
    const user = makeUser();
    const session = createSession(user.id, undefined, undefined);

    // Half the idle window elapses, then a validation touches it...
    Date.now = () => realNow() + Math.floor(config.sessionIdleTimeoutMs / 2);
    expect(validateSession(session.token)).not.toBeNull();

    // ...so another half-window later (which would have been past the ORIGINAL
    // idle deadline had it not been touched) still validates.
    Date.now = () => realNow() + config.sessionIdleTimeoutMs;
    expect(validateSession(session.token)).not.toBeNull();
  });

  test("a session for a deactivated user does not validate", () => {
    const user = makeUser();
    const session = createSession(user.id, undefined, undefined);

    updateUser(user.username, { isActive: false });

    expect(validateSession(session.token)).toBeNull();
  });
});

describe("revokeAllSessionsForUser", () => {
  test("revokes every active session for that user, leaves other users' sessions alone", () => {
    const alice = makeUser("alice");
    const bob = makeUser("bob");

    const aliceSession1 = createSession(alice.id, undefined, undefined);
    const aliceSession2 = createSession(alice.id, undefined, undefined);
    const bobSession = createSession(bob.id, undefined, undefined);

    revokeAllSessionsForUser(alice.id);

    expect(validateSession(aliceSession1.token)).toBeNull();
    expect(validateSession(aliceSession2.token)).toBeNull();
    expect(validateSession(bobSession.token)).not.toBeNull();
  });
});

describe("listActiveSessionsForUser / revokeSessionById", () => {
  test("lists only active, non-expired sessions for the given user", () => {
    const user = makeUser();
    createSession(user.id, "1.1.1.1", "agent-a");
    createSession(user.id, "2.2.2.2", "agent-b");

    const sessions = listActiveSessionsForUser(user.id);
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.ipAddress).sort()).toEqual(["1.1.1.1", "2.2.2.2"]);
  });

  test("revokeSessionById removes it from the active list and invalidates it", () => {
    const user = makeUser();
    const session = createSession(user.id, undefined, undefined);
    const [summary] = listActiveSessionsForUser(user.id);

    expect(revokeSessionById(user.id, summary.id)).toBe(true);
    expect(listActiveSessionsForUser(user.id)).toHaveLength(0);
    expect(validateSession(session.token)).toBeNull();
  });

  test("revokeSessionById scoped to the owning user — cannot revoke another user's session", () => {
    const alice = makeUser("alice");
    const bob = makeUser("bob");
    createSession(bob.id, undefined, undefined);
    const [bobSummary] = listActiveSessionsForUser(bob.id);

    expect(revokeSessionById(alice.id, bobSummary.id)).toBe(false);
    expect(listActiveSessionsForUser(bob.id)).toHaveLength(1);
  });

  test("revokeSessionById returns false for an unknown session id", () => {
    const user = makeUser();
    expect(revokeSessionById(user.id, 999999)).toBe(false);
  });
});
