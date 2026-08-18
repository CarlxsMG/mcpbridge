import { describe, test, expect, beforeEach, afterEach, spyOn, type Mock } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __resetDbForTesting } from "../../db/connection.js";
import { bootstrapAdminUser } from "../bootstrap-admin.js";
import { countUsers, createUser, findUserByUsername, touchLastLogin } from "../user-store.js";
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
let stdoutSpy: Mock<typeof process.stdout.write>;

beforeEach(() => {
  __resetDbForTesting();
  // Spy + silence; `.mock.calls` records (level, message, meta) per call.
  logSpy = spyOn(logger, "log").mockImplementation(() => {});
  // The first-run banner deliberately bypasses log() and writes to stdout
  // directly, so it has to be captured here rather than off the logger spy.
  stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  logSpy.mockRestore();
  stdoutSpy.mockRestore();
});

const STRONG_PW = "a-strong-password-123"; // >= 12 chars

/**
 * "Nothing is configured" — every input the bootstrap decision and the recovery
 * hint read, pinned explicitly.
 *
 * All three keys are pinned on every test that uses this: a gitignored `.env`
 * supplies BOOTSTRAP_ADMIN_* (and can supply ADMIN_API_KEYS) on a developer
 * machine and nothing in CI, so reading whatever `config` happens to hold would
 * pass locally and fail there — or, worse, the reverse.
 */
const noEnv = { bootstrapAdminUsername: undefined, bootstrapAdminPassword: undefined, adminApiKeys: [] };

/** Everything the code under test wrote to stdout during this test. */
function capturedStdout(): string {
  return stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
}

/** The password printed in the first-run banner, or null when none was printed. */
function bannerPassword(): string | null {
  return /^\s*password: (\S+)$/m.exec(capturedStdout())?.[1] ?? null;
}

/**
 * The later-boot recovery hint's `log()` call, or undefined when it was not
 * emitted. Matched on the invariant half of the message (the account exists but
 * has never been used) rather than on the recovery wording, which is prose.
 */
function recoveryHint(): unknown[] | undefined {
  return logSpy.mock.calls.find((c) => String(c[1]).includes("has never signed in"));
}

describe("bootstrapAdminUser — empty admin_users", () => {
  test("valid creds → creates the admin user and logs the bootstrap warning", async () => {
    await withConfig({ bootstrapAdminUsername: "root", bootstrapAdminPassword: STRONG_PW }, async () => {
      expect(countUsers()).toBe(0);
      await bootstrapAdminUser();
    });
    expect(countUsers()).toBe(1);
    expect(findUserByUsername("root")?.role).toBe("admin");
    // Only the argon2id hash is stored, and it has to be the hash OF the
    // configured password — a bootstrap that stored something else would leave
    // the operator locked out of the credential they set themselves.
    const rootHash = findUserByUsername("root")?.passwordHash;
    expect(rootHash).not.toBe(STRONG_PW);
    expect(await Bun.password.verify(STRONG_PW, rootHash ?? "")).toBe(true);
    // The explicit-credentials path is untouched by the zero-config feature: no
    // random account, no banner, nothing extra on stdout.
    expect(findUserByUsername("admin")).toBeNull();
    expect(capturedStdout()).not.toContain("FIRST-RUN ADMIN CREDENTIALS");
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

  test("only the username is set → warns and does NOT create or generate", async () => {
    await withConfig({ bootstrapAdminUsername: "half", bootstrapAdminPassword: undefined }, async () => {
      await bootstrapAdminUser();
    });
    // Half-configured is a mistake, not a request for a generated account —
    // handing back a *different* username than the one the operator set would
    // be worse than refusing.
    expect(countUsers()).toBe(0);
    expect(capturedStdout()).not.toContain("FIRST-RUN ADMIN CREDENTIALS");
    const warn = logSpy.mock.calls.find((c) => String(c[1]).includes("Only one of"));
    expect(warn?.[0]).toBe("warn");
    expect(warn?.[1]).toContain("both are required");
    expect(warn?.[1]).toContain("the admin UI is inaccessible");
  });

  test("only the password is set → warns and does NOT create or generate", async () => {
    await withConfig({ bootstrapAdminUsername: undefined, bootstrapAdminPassword: STRONG_PW }, async () => {
      await bootstrapAdminUser();
    });
    expect(countUsers()).toBe(0);
    expect(capturedStdout()).not.toContain("FIRST-RUN ADMIN CREDENTIALS");
    expect(logSpy.mock.calls.find((c) => String(c[1]).includes("Only one of"))?.[0]).toBe("warn");
  });
});

// ---------------------------------------------------------------------------
// Zero-config first run: `docker run` with no -e flags at all must still yield
// a usable, secure instance. Every assertion here is about the pair of
// properties that makes that safe — the credential is strong and it actually
// works, and it is emitted exactly once, never over an existing install.
// ---------------------------------------------------------------------------
describe("bootstrapAdminUser — zero-config first run (no BOOTSTRAP_ADMIN_* at all)", () => {
  test("empty table → creates an admin and prints the credentials banner once", async () => {
    await withConfig(noEnv, async () => {
      expect(countUsers()).toBe(0);
      await bootstrapAdminUser();
    });

    expect(countUsers()).toBe(1);
    const user = findUserByUsername("admin");
    expect(user?.role).toBe("admin");
    expect(user?.isActive).toBe(true);

    const out = capturedStdout();
    expect(out).toContain("FIRST-RUN ADMIN CREDENTIALS");
    expect(out).toContain("username: admin");
    // Exactly one banner — a second print would imply a second generation.
    expect(out.match(/FIRST-RUN ADMIN CREDENTIALS/g)).toHaveLength(1);
  });

  test("the printed password is the one that actually authenticates", async () => {
    await withConfig(noEnv, async () => {
      await bootstrapAdminUser();
    });
    const printed = bannerPassword();
    expect(printed).not.toBeNull();
    const hash = findUserByUsername("admin")?.passwordHash;
    expect(hash).toBeDefined();
    // The whole feature is worthless if the banner and the stored argon2id hash
    // ever drift apart — the operator would be locked out with no way back.
    expect(await Bun.password.verify(printed ?? "", hash ?? "")).toBe(true);
  });

  test("the generated password clears the strength floor and is not predictable", async () => {
    await withConfig(noEnv, async () => {
      await bootstrapAdminUser();
    });
    const first = bannerPassword() ?? "";
    // Same floor POST /admin-api/users and BOOTSTRAP_ADMIN_PASSWORD enforce, so
    // the generated credential can't be weaker than a hand-set one.
    expect(first.length).toBeGreaterThanOrEqual(12);

    // A second first-run (fresh, empty database) must not reproduce it.
    stdoutSpy.mockClear();
    __resetDbForTesting();
    await withConfig(noEnv, async () => {
      await bootstrapAdminUser();
    });
    const second = bannerPassword() ?? "";
    expect(second.length).toBeGreaterThanOrEqual(12);
    expect(second).not.toBe(first);
  });

  test("the generated password never passes through the logger", async () => {
    await withConfig(noEnv, async () => {
      await bootstrapAdminUser();
    });
    const printed = bannerPassword() ?? "";
    expect(printed).not.toBe("");
    // log() redacts secret-named meta keys but not message bodies, so the only
    // way this stays true is by not handing the password to log() at all. The
    // accompanying warn is expected — it just must not carry the secret.
    const logged = JSON.stringify(logSpy.mock.calls);
    expect(logged).not.toContain(printed);
    expect(logSpy.mock.calls.find((c) => String(c[1]).includes("generated a random"))?.[0]).toBe("warn");
  });

  test("a second boot re-generates nothing and re-prints no credential, but is not silent", async () => {
    await withConfig(noEnv, async () => {
      await bootstrapAdminUser();
    });
    const firstBannerCount = (capturedStdout().match(/FIRST-RUN ADMIN CREDENTIALS/g) ?? []).length;
    expect(firstBannerCount).toBe(1);
    const firstPassword = bannerPassword() ?? "";
    expect(firstPassword).not.toBe("");
    const hashAfterFirstBoot = findUserByUsername("admin")?.passwordHash;

    // Same database, second process boot — the table is no longer empty.
    stdoutSpy.mockClear();
    logSpy.mockClear();
    await withConfig(noEnv, async () => {
      await bootstrapAdminUser();
    });

    // Half one of the contract, and the part that must never weaken: no second
    // account, no re-hash, and NOTHING on the credential writer — a credential
    // printed twice is a credential in twice as many log stores.
    expect(countUsers()).toBe(1);
    expect(findUserByUsername("admin")?.passwordHash).toBe(hashAfterFirstBoot);
    expect(capturedStdout()).toBe("");

    // Half two: this boot used to be TOTALLY silent, which is what made a
    // burned first-run credential unrecoverable — the operator had no
    // indication the instance was reachable at all, let alone how. A hint is
    // logged, and it carries no secret.
    const hint = recoveryHint();
    expect(hint?.[0]).toBe("warn");
    expect(String(hint?.[1])).toContain("no password can be printed or regenerated");
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(firstPassword);
    // Both recovery routes are named, since neither is discoverable: there is
    // no password-reset route, and with no ADMIN_API_KEYS `adminAuth` has no
    // Bearer path at all.
    const meta = JSON.stringify(hint?.[2]);
    expect(meta).toContain("ADMIN_API_KEYS");
    expect(meta).toContain("POST /admin-api/users");
    expect(meta).toContain("admin_users");
  });

  test("the recovery hint stops after the first successful sign-in", async () => {
    await withConfig(noEnv, async () => {
      await bootstrapAdminUser();
    });
    const id = findUserByUsername("admin")?.id;
    expect(id).toBeDefined();
    touchLastLogin(id ?? 0);

    logSpy.mockClear();
    stdoutSpy.mockClear();
    await withConfig(noEnv, async () => {
      await bootstrapAdminUser();
    });
    // Anything logged on EVERY restart of a healthy install is noise operators
    // learn to skip past. A recorded login proves the credential landed.
    expect(recoveryHint()).toBeUndefined();
    expect(capturedStdout()).toBe("");
  });

  test("the recovery hint also fires when BOOTSTRAP_ADMIN_* are set and ignored", async () => {
    await withConfig(noEnv, async () => {
      await bootstrapAdminUser();
    });
    logSpy.mockClear();

    // Setting these is the natural first attempt at recovering a lost password,
    // and on its own that path only answers "ignoring. Remove these env vars."
    await withConfig(
      { bootstrapAdminUsername: "admin", bootstrapAdminPassword: STRONG_PW, adminApiKeys: [] },
      async () => {
        await bootstrapAdminUser();
      },
    );
    expect(logSpy.mock.calls.find((c) => String(c[1]).includes("already exist"))?.[0]).toBe("warn");
    expect(recoveryHint()?.[0]).toBe("warn");
    // Still no reset: the env-configured password must not silently replace the
    // stored hash, or BOOTSTRAP_ADMIN_* would be an unauthenticated reset hole.
    expect(await Bun.password.verify(STRONG_PW, findUserByUsername("admin")?.passwordHash ?? "")).toBe(false);
  });

  test("the recovery hint does not fire for an operator-created account named admin", async () => {
    // The hint keys off `created_by === GENERATED_ADMIN_CREATED_BY`, a marker
    // only the generated row carries. Null is NOT the discriminator: the
    // BOOTSTRAP_ADMIN_* path writes null too, which is what made this hint fire
    // at operators who had set their own password. An account someone created
    // deliberately has a password its creator chose and needs no hint.
    createUser("admin", "hash", "admin", "some-super-admin");
    await withConfig(noEnv, async () => {
      await bootstrapAdminUser();
    });
    expect(recoveryHint()).toBeUndefined();
  });

  test("an install that was always explicitly configured stays silent on later boots", async () => {
    // The pre-existing property the recovery hint must not trample: an operator
    // who set BOOTSTRAP_ADMIN_* once (and knows that password) has nothing to
    // recover, so their restarts print and log nothing at all.
    await withConfig({ bootstrapAdminUsername: "root", bootstrapAdminPassword: STRONG_PW }, async () => {
      await bootstrapAdminUser();
    });
    stdoutSpy.mockClear();
    logSpy.mockClear();
    await withConfig(noEnv, async () => {
      await bootstrapAdminUser();
    });
    expect(countUsers()).toBe(1);
    expect(capturedStdout()).toBe("");
    expect(logSpy.mock.calls).toHaveLength(0);
  });

  test("an existing NON-admin user still blocks generation (any row means 'not a first run')", async () => {
    // Guards the fail-closed reading of `existing > 0`: a deployment whose only
    // account is a viewer must not silently gain a fresh admin credential.
    createUser("viewer-only", "hash", "viewer", null);
    await withConfig(noEnv, async () => {
      await bootstrapAdminUser();
    });
    expect(countUsers()).toBe(1);
    expect(findUserByUsername("admin")).toBeNull();
    expect(capturedStdout()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The recovery hint's two false-positive shapes.
//
// The hint tells an operator that the account's password "cannot be printed or
// regenerated" and offers deleting the row as a way out. Both statements are
// only true of the auto-generated account on an install with no other way in.
// Emitted anywhere else it is confidently-wrong prose aimed at an operator —
// and one of its two suggestions is destructive.
// ---------------------------------------------------------------------------
describe("the first-run recovery hint must not fire outside the case it describes", () => {
  const QUICKSTART = { bootstrapAdminUsername: "admin", bootstrapAdminPassword: STRONG_PW, adminApiKeys: [] };

  test("an explicitly-configured admin named `admin` gets no hint, env vars still set", async () => {
    // This is the DOCUMENTED shape, not an edge case: `.env.example` ships
    // BOOTSTRAP_ADMIN_USERNAME=admin and every quickstart in the README and the
    // deployment/getting-started guides passes `-e BOOTSTRAP_ADMIN_USERNAME=admin`.
    // The operator chose this password, so "no password can be printed or
    // regenerated for it" is false, and recovery step 2 would have them delete
    // their own — and only — admin row.
    await withConfig(QUICKSTART, async () => {
      await bootstrapAdminUser();
    });
    expect(findUserByUsername("admin")).not.toBeNull();

    logSpy.mockClear();
    stdoutSpy.mockClear();
    // Restart before ever signing in to the UI — last_login_at is still null,
    // which is the whole basis of the old check.
    await withConfig(QUICKSTART, async () => {
      await bootstrapAdminUser();
    });
    // The "remove these env vars" warning is correct here and stays.
    expect(logSpy.mock.calls.find((c) => String(c[1]).includes("already exist"))?.[0]).toBe("warn");
    expect(recoveryHint()).toBeUndefined();
  });

  test("an explicitly-configured admin named `admin` gets no hint after the env vars are unset", async () => {
    // The docs tell the operator to unset BOOTSTRAP_ADMIN_* after the first
    // boot, so by the restart that matters the config no longer records what
    // the account was created from — only the row does.
    await withConfig(QUICKSTART, async () => {
      await bootstrapAdminUser();
    });
    logSpy.mockClear();
    await withConfig(noEnv, async () => {
      await bootstrapAdminUser();
    });
    expect(recoveryHint()).toBeUndefined();
  });

  test("the generated row records where it came from; the env-configured row does not share it", async () => {
    // The property both tests above rest on, asserted directly: the two
    // creation paths must be distinguishable from the row alone. Compared
    // rather than matched against a literal, so the marker's spelling stays an
    // implementation detail — what matters is that it discriminates.
    await withConfig(noEnv, async () => {
      await bootstrapAdminUser();
    });
    const generatedOrigin = findUserByUsername("admin")?.createdBy;
    expect(generatedOrigin).not.toBeUndefined();

    __resetDbForTesting();
    await withConfig(QUICKSTART, async () => {
      await bootstrapAdminUser();
    });
    expect(findUserByUsername("admin")?.createdBy).not.toBe(generatedOrigin);
  });

  test("no hint on a Bearer-configured install — its own first recovery step is already satisfied", async () => {
    // ADMIN_API_KEYS set and nobody using the UI: last_login_at stays null
    // forever, so the hint would print on EVERY restart, advising the operator
    // to set ADMIN_API_KEYS and POST /admin-api/users — which they can already
    // do. Permanent noise that recommends what is already in place.
    await withConfig(noEnv, async () => {
      await bootstrapAdminUser();
    });
    logSpy.mockClear();
    await withConfig(
      {
        bootstrapAdminUsername: undefined,
        bootstrapAdminPassword: undefined,
        adminApiKeys: ["a-strong-admin-api-key"],
      },
      async () => {
        await bootstrapAdminUser();
      },
    );
    expect(recoveryHint()).toBeUndefined();
    // Suppression is about the Bearer path existing, not about the account: the
    // row is untouched, so removing ADMIN_API_KEYS brings the hint back.
    logSpy.mockClear();
    await withConfig(noEnv, async () => {
      await bootstrapAdminUser();
    });
    expect(recoveryHint()?.[0]).toBe("warn");
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

// ---------------------------------------------------------------------------
// Boot ordering, driven through the REAL process (`bun src/index.ts`).
//
// The property under test belongs to src/index.ts, not to this module, and it
// is an ORDER: the generated credential exists in memory for exactly one
// stdout write, so every boot check that can `process.exit` has to run BEFORE
// bootstrapAdminUser(). When it ran first, `docker run -e TRUST_PROXY=true -v
// data:/app/data` printed the banner, committed the `admin` row to the volume,
// then died on the guard — and the next boot saw a non-empty table, generated
// nothing, and left no way in.
//
// Spawned rather than imported for two reasons: src/index.ts is a top-level-
// await entrypoint that binds a port and starts background loops (importing it
// into this process would leak all of that into the shared test runtime), and
// only a real process can prove an ordering that is defined by process.exit.
//
// The subprocess gets its OWN DB file in a temp dir and never touches the
// shared bun:sqlite connection or the global `config` — the cross-test
// contamination this suite otherwise has to be careful about.
// ---------------------------------------------------------------------------
describe("boot ordering — a fatal startup guard must not burn the generated credential", () => {
  const ENTRYPOINT = join(import.meta.dir, "..", "..", "index.ts");
  const BANNER = "FIRST-RUN ADMIN CREDENTIALS";

  /**
   * The interpreter to spawn — the binary already running this test, NOT the
   * name `bun` resolved through PATH.
   *
   * Why it has to be the real executable: on a machine where bun was installed
   * through npm, PATH's `bun` is a shim script (`bun.cmd`/`bun.ps1`) that
   * launches the actual `bun.exe` as a CHILD. `Bun.spawn` then owns the shim,
   * so the `proc.kill()` below terminates the shim while the gateway keeps
   * running, and `await proc.exited` still resolves — the test passes and
   * leaves a live server behind. That orphan is not merely untidy: it inherits
   * the test runner's stdout pipe, so any piped invocation of the suite
   * (`bun run check | tail`) never sees EOF and appears to hang forever after
   * every check has already passed. Measured: 27 abandoned gateways
   * accumulated on one developer machine this way.
   *
   * `process.execPath` is the bun binary itself on every platform, so there is
   * no intermediate process to own. What would reintroduce the leak: going
   * back to a bare command name, or spawning through a shell.
   */
  const BUN_EXE = process.execPath;

  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bootstrap-order-"));
    dbPath = join(tmpDir, "gateway.db");
  });

  afterEach(async () => {
    // Windows releases the subprocess's SQLite file handle a moment after the
    // process itself is gone, so an immediate rm can lose the race with EBUSY.
    // Cleanup is best-effort by design: a stray temp dir is harmless, and
    // failing a passing test on it would be a pure flake.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
        return;
      } catch {
        await Bun.sleep(100);
      }
    }
  });

  /**
   * Env for the spawned gateway. Every key that feeds a startup guard, the
   * bootstrap decision, the port or the DB path is pinned EXPLICITLY, and the
   * cwd is the temp dir rather than the repo: a gitignored `.env` at the repo
   * root supplies BOOTSTRAP_ADMIN_USERNAME, NODE_ENV and SESSION_COOKIE_SECURE
   * on a developer machine and nothing at all in CI, and bun auto-loads it
   * relative to cwd. Reading whichever of those happened to be ambient would make this
   * pass locally and fail there (or worse, the reverse).
   */
  function gatewayEnv(overrides: Record<string, string>): Record<string, string> {
    return {
      ...(process.env as Record<string, string>),
      DB_PATH: dbPath,
      // Ephemeral port: a fixed one would collide with a local `bun run dev`.
      PORT: "0",
      // The zero-config story — no credentials supplied, so one is generated.
      BOOTSTRAP_ADMIN_USERNAME: "",
      BOOTSTRAP_ADMIN_PASSWORD: "",
      ADMIN_API_KEYS: "",
      // Guard inputs, all pinned to their safe values so that only the one an
      // individual test sets can be the guard that fires.
      NODE_ENV: "production",
      TRUST_PROXY: "",
      AUTH_DISABLED: "",
      CORS_ORIGINS: "",
      SESSION_COOKIE_SECURE: "true",
      JWT_JWKS_URL: "",
      JWT_AUDIENCE: "",
      ALLOW_UNSAFE_AUTH_DISABLED: "",
      ALLOW_UNSAFE_INSECURE_SESSION_COOKIE: "",
      ALLOW_UNSAFE_JWT_NO_AUDIENCE: "",
      // Keep env validation warn-only; an unrelated ambient var must not turn
      // into the second `process.exit` path and mask the one under test.
      STRICT_CONFIG: "",
      ...overrides,
    };
  }

  /**
   * Number of rows in the subprocess's `admin_users`, read after it exited.
   *
   * Opened read-WRITE on purpose: the gateway runs `journal_mode = WAL` and a
   * `process.exit` leaves the `-wal` sidecar uncheckpointed, and a read-only
   * connection that cannot use the `-shm` would report an EMPTY table — a false
   * PASS in exactly the direction this test is asserting. A writable handle
   * always sees the committed rows. Nothing else touches this file by now.
   */
  function adminUsersInSpawnedDb(): number {
    const db = new Database(dbPath);
    try {
      // Asserted separately from the count so a database the process never got
      // as far as migrating reads as that, not as a "no such table" throw — and
      // so an accidentally-created empty file can't masquerade as "0 rows".
      const table = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='admin_users'`).get();
      expect(table).not.toBeNull();
      const row = db.query(`SELECT COUNT(*) as count FROM admin_users`).get() as { count: number };
      return row.count;
    } finally {
      db.close();
    }
  }

  test("TRUST_PROXY=true exits 1 with no banner printed and no admin row committed", async () => {
    const proc = Bun.spawn([BUN_EXE, ENTRYPOINT], {
      cwd: tmpDir,
      env: gatewayEnv({ TRUST_PROXY: "true" }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const output = stdout + stderr;

    // The guard really is what stopped it (not a crash on the way there).
    expect(output).toContain("TRUST_PROXY=true (boolean) is unsafe outside development");
    expect(code).toBe(1);
    // The two halves of "the credential was not burned": nothing was shown to
    // an operator whose attention is on the FATAL line...
    expect(output).not.toContain(BANNER);
    // ...and, decisively, nothing was written to the volume that would make the
    // NEXT boot treat this as an existing install.
    expect(adminUsersInSpawnedDb()).toBe(0);
  }, 60_000);

  test("a boot that trips no guard does create and print the credential", async () => {
    // The other half of the ordering: proving the call is still reached. A
    // "fix" that moved it into an unreachable position would satisfy the test
    // above and leave every zero-config install with no admin at all.
    const proc = Bun.spawn([BUN_EXE, ENTRYPOINT], {
      cwd: tmpDir,
      env: gatewayEnv({}),
      stdout: "pipe",
      stderr: "pipe",
    });
    let seen = "";
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) {
      seen += decoder.decode(chunk as Uint8Array);
      if (seen.includes(BANNER)) break;
    }
    proc.kill();
    await proc.exited;

    expect(seen).toContain(BANNER);
    expect(seen).toContain("username: admin");
    expect(adminUsersInSpawnedDb()).toBe(1);
  }, 60_000);
});
