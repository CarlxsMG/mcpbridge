import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { __resetDbForTesting } from "../db/connection.js";
import { config } from "../config.js";
import { bootstrapAdminUser } from "../security/bootstrap-admin.js";
import { countUsers, findUserByUsername, createUser } from "../security/user-store.js";

let originalUsername: string | undefined;
let originalPassword: string | undefined;

beforeEach(() => {
  __resetDbForTesting();
  originalUsername = config.bootstrapAdminUsername;
  originalPassword = config.bootstrapAdminPassword;
});

afterEach(() => {
  (config as Record<string, unknown>).bootstrapAdminUsername = originalUsername;
  (config as Record<string, unknown>).bootstrapAdminPassword = originalPassword;
});

describe("bootstrapAdminUser — empty admin_users table", () => {
  test("creates the admin user when both env vars are set with a strong password", async () => {
    (config as Record<string, unknown>).bootstrapAdminUsername = "root";
    (config as Record<string, unknown>).bootstrapAdminPassword = "correct-horse-battery-staple";

    await bootstrapAdminUser();

    expect(countUsers()).toBe(1);
    const user = findUserByUsername("root");
    expect(user).not.toBeNull();
    expect(user?.role).toBe("admin");
    expect(user?.isActive).toBe(true);
    // The hash must not be the raw password, and must be verifiable.
    expect(user?.passwordHash).not.toBe("correct-horse-battery-staple");
    expect(await Bun.password.verify("correct-horse-battery-staple", user!.passwordHash)).toBe(true);
  });

  test("does nothing when neither env var is set", async () => {
    (config as Record<string, unknown>).bootstrapAdminUsername = undefined;
    (config as Record<string, unknown>).bootstrapAdminPassword = undefined;

    await bootstrapAdminUser();

    expect(countUsers()).toBe(0);
  });

  test("does nothing when only the username is set", async () => {
    (config as Record<string, unknown>).bootstrapAdminUsername = "root";
    (config as Record<string, unknown>).bootstrapAdminPassword = undefined;

    await bootstrapAdminUser();

    expect(countUsers()).toBe(0);
  });

  test("refuses to bootstrap with a password shorter than 12 characters", async () => {
    (config as Record<string, unknown>).bootstrapAdminUsername = "root";
    (config as Record<string, unknown>).bootstrapAdminPassword = "tooshort";

    await bootstrapAdminUser();

    expect(countUsers()).toBe(0);
  });
});

describe("bootstrapAdminUser — admin_users already populated", () => {
  test("does not create a second user even if the bootstrap env vars are still set", async () => {
    createUser("existing-admin", "some-hash", "admin", null);
    (config as Record<string, unknown>).bootstrapAdminUsername = "root";
    (config as Record<string, unknown>).bootstrapAdminPassword = "correct-horse-battery-staple";

    await bootstrapAdminUser();

    expect(countUsers()).toBe(1);
    expect(findUserByUsername("root")).toBeNull();
  });

  test("is a no-op when env vars are absent and users already exist", async () => {
    createUser("existing-admin", "some-hash", "admin", null);
    (config as Record<string, unknown>).bootstrapAdminUsername = undefined;
    (config as Record<string, unknown>).bootstrapAdminPassword = undefined;

    await bootstrapAdminUser();

    expect(countUsers()).toBe(1);
  });
});
