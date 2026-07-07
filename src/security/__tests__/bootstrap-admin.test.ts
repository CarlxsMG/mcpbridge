import { describe, test, expect, beforeEach, afterEach, spyOn, type Mock } from "bun:test";

import { __resetDbForTesting } from "../../db/connection.js";
import { bootstrapAdminUser } from "../bootstrap-admin.js";
import { countUsers, createUser, findUserByUsername } from "../user-store.js";
import * as logger from "../../logger.js";
import { withConfig } from "../../__tests__/_utils/with-config.js";

// ---------------------------------------------------------------------------
// bootstrapAdminUser — direct unit tests (Stryker mutation backstop for
// src/security/bootstrap-admin.ts). Before P2-4 this module had no direct
// test — only indirect coverage — so 16 mutants survived, mostly the `log()`
// level/message StringLiterals and the `existing > 0` / password-length
// guards. We assert BOTH the DB effect (countUsers/findUserByUsername) AND the
// `log()` calls (via a spy on the logger) so the level, every message chunk,
// and the meta object are all pinned. Each assertion names the mutant it kills.
// ---------------------------------------------------------------------------

let logSpy: Mock<typeof logger.log>;

beforeEach(() => {
  __resetDbForTesting();
  // Spy + silence; `.mock.calls` records (level, message, meta) per call.
  logSpy = spyOn(logger, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
});

const STRONG_PW = "a-strong-password-123"; // >= 12 chars

describe("bootstrapAdminUser — empty admin_users", () => {
  test("valid creds → creates the admin user and logs the bootstrap warning", async () => {
    await withConfig({ bootstrapAdminUsername: "root", bootstrapAdminPassword: STRONG_PW }, async () => {
      expect(countUsers()).toBe(0);
      await bootstrapAdminUser();
    });
    expect(countUsers()).toBe(1);
    expect(findUserByUsername("root")?.role).toBe("admin");
    const warn = logSpy.mock.calls.find((c) => String(c[1]).includes("Bootstrapped"));
    expect(warn?.[0]).toBe("warn"); // kills L48 "warn"->""
    expect(warn?.[1]).toContain("Bootstrapped the initial admin user"); // kills L49 chunk
    expect(warn?.[1]).toContain("rotate the password after first login"); // kills L50 chunk
    expect(warn?.[2]).toEqual({ username: "root" }); // kills L51 ObjectLiteral->{}
  });

  test("password of exactly 12 chars is accepted (boundary; kills L37 `<`->`<=`)", async () => {
    const pw = "exactly12chr";
    expect(pw).toHaveLength(12);
    await withConfig({ bootstrapAdminUsername: "edge", bootstrapAdminPassword: pw }, async () => {
      await bootstrapAdminUser();
    });
    // `12 < 12` is false → NOT rejected → created. The `<=` mutant rejects it.
    expect(countUsers()).toBe(1);
  });

  test("password shorter than 12 chars → errors and does NOT create (kills L39/L40)", async () => {
    await withConfig({ bootstrapAdminUsername: "weak", bootstrapAdminPassword: "short" }, async () => {
      await bootstrapAdminUser();
    });
    expect(countUsers()).toBe(0);
    const err = logSpy.mock.calls.find((c) => c[0] === "error");
    expect(err?.[0]).toBe("error"); // kills L39 "error"->""
    expect(err?.[1]).toContain("shorter than the required"); // kills L40 template
  });

  test("no creds → warns UI-inaccessible and does NOT create (kills L30/L31/L32)", async () => {
    await withConfig({ bootstrapAdminUsername: undefined, bootstrapAdminPassword: undefined }, async () => {
      await bootstrapAdminUser();
    });
    expect(countUsers()).toBe(0);
    const warn = logSpy.mock.calls.find((c) => String(c[1]).includes("inaccessible"));
    expect(warn?.[0]).toBe("warn"); // kills L30 "warn"->""
    expect(warn?.[1]).toContain("No admin users exist yet"); // kills L31 chunk
    expect(warn?.[1]).toContain("the admin UI is inaccessible"); // kills L32 chunk
  });
});

describe("bootstrapAdminUser — admin_users already populated", () => {
  test("creds set + users exist → warns 'already exist', creates nothing (kills L19 block/false, L21/L22)", async () => {
    createUser("existing", "hash", "admin", null);
    await withConfig({ bootstrapAdminUsername: "root", bootstrapAdminPassword: STRONG_PW }, async () => {
      await bootstrapAdminUser();
    });
    expect(countUsers()).toBe(1); // no new user
    const warn = logSpy.mock.calls.find((c) => String(c[1]).includes("already exist"));
    expect(warn?.[0]).toBe("warn"); // kills L21 "warn"->""
    expect(warn?.[1]).toContain("already exist"); // kills L22 template->``
  });

  test("NO creds + users exist → stays silent (kills L19 Conditional->true)", async () => {
    createUser("existing", "hash", "admin", null);
    await withConfig({ bootstrapAdminUsername: undefined, bootstrapAdminPassword: undefined }, async () => {
      await bootstrapAdminUser();
    });
    expect(countUsers()).toBe(1);
    // `if (username || password)` is false → nothing logged; the `if (true)`
    // mutant would emit the "already exist" warning here.
    const warn = logSpy.mock.calls.find((c) => String(c[1]).includes("already exist"));
    expect(warn).toBeUndefined();
  });

  test("only username set + users exist → still warns (kills L19 `||`->`&&`)", async () => {
    createUser("existing", "hash", "admin", null);
    await withConfig({ bootstrapAdminUsername: "root", bootstrapAdminPassword: undefined }, async () => {
      await bootstrapAdminUser();
    });
    expect(countUsers()).toBe(1);
    // `username || password` is truthy → warns; the `username && password`
    // mutant is false (password undefined) → no warning.
    const warn = logSpy.mock.calls.find((c) => String(c[1]).includes("already exist"));
    expect(warn?.[0]).toBe("warn");
  });
});
