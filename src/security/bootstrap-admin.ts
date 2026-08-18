import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { log } from "../logger.js";
import { countUsers, createUser, findUserByUsername } from "./user-store.js";

const MIN_BOOTSTRAP_PASSWORD_LENGTH = 12;

/** Username given to the auto-generated first-run admin. */
const GENERATED_ADMIN_USERNAME = "admin";

/**
 * `created_by` written for the auto-generated first-run admin, and the only
 * thing that identifies that row later.
 *
 * Recorded at creation time rather than inferred, because there is nothing to
 * infer it FROM. `created_by IS NULL` was tried and is wrong: the
 * BOOTSTRAP_ADMIN_USERNAME/PASSWORD path stores null too, and `.env.example`
 * plus every quickstart in the README and the deployment guide use
 * `BOOTSTRAP_ADMIN_USERNAME=admin` — so the two collide precisely on the
 * documented setup. The env vars themselves are no help either: the same docs
 * tell the operator to unset them once the account exists.
 *
 * Safe to put in `created_by` because that column holds an actor LABEL, not a
 * username reference: `POST /admin-api/users` writes the caller's session name
 * or `bearer:admin-api-key`, and SSO auto-provisioning writes
 * `oidc:<provider>`, so a namespaced non-username label is the existing
 * convention. No API exposes `admin_users.created_by` and nothing else reads
 * it, so the value is free. What would break the discrimination: writing this
 * marker from any other creation path, or a super-admin whose own username is
 * literally this string creating an account named `admin` — the worst outcome
 * of the latter is one advisory log line.
 */
const GENERATED_ADMIN_CREATED_BY = "bootstrap:generated";

/**
 * Entropy of the auto-generated first-run password. base64url of this many
 * random bytes is always longer than MIN_BOOTSTRAP_PASSWORD_LENGTH and than the
 * floor `POST /admin-api/users` enforces, so a generated credential can never
 * be weaker than one an operator is allowed to set by hand. Raising it is safe;
 * lowering it below 9 bytes would put the encoded length under that floor.
 */
const GENERATED_PASSWORD_BYTES = 24;

/**
 * Prints the one-time first-run credentials straight to stdout, deliberately
 * bypassing `log()`.
 *
 * What bypassing `log()` does and does not buy — worth spelling out, because
 * the bypass is easy to mistake for a secrecy property it does not provide:
 *
 *  - It DOES keep `log()`'s own no-secrets invariant literally true. `log()`
 *    redacts secret-named meta keys and, under LOG_FORMAT=json, emits one
 *    escaped record per line; this password never passes through it, so no
 *    amount of message-body handling there can ever leak it.
 *  - It does NOT keep the credential out of a log collector. `process.stdout`
 *    is exactly what `docker logs`, journald and any stdout-tailing shipper
 *    consume, so this password does reach them. What the bypass buys is
 *    readability and unmissability — a ruled block in `docker logs` rather than
 *    an escaped string inside one JSON record among the boot chatter.
 *
 * That trade is accepted deliberately: the password is stored only as an
 * argon2id hash and is never regenerated or reprinted, so an operator who
 * overlooks the banner has no admin account they can use. Losing the
 * credential is the worse outcome than having it in first-boot container logs.
 * Anyone tightening log retention should treat first-boot output as
 * credential-bearing, and rotate this password after signing in.
 *
 * This is the single, deliberate, first-run-only exception to "never print a
 * secret". Do not reuse this writer for anything else: any other secret has a
 * retrievable source, and this one does not.
 */
function printFirstRunCredentials(username: string, password: string): void {
  const rule = "=".repeat(74);
  process.stdout.write(
    `\n${rule}\n` +
      `  MCP REST BRIDGE — FIRST-RUN ADMIN CREDENTIALS (shown once, never again)\n` +
      `${rule}\n` +
      `    username: ${username}\n` +
      `    password: ${password}\n` +
      `${rule}\n` +
      `  Generated because no admin user existed and neither BOOTSTRAP_ADMIN_USERNAME\n` +
      `  nor BOOTSTRAP_ADMIN_PASSWORD was set. Only the argon2id hash is stored, so\n` +
      `  this password cannot be recovered or reprinted. Copy it now, sign in at\n` +
      `  /admin, and change it.\n` +
      `${rule}\n\n`,
  );
}

/**
 * Creates a random first-run admin so a flag-less `docker run` still yields a
 * usable instance. Only ever called with an EMPTY `admin_users` table, which is
 * what makes it safe: it can never reset, shadow or re-issue an existing
 * operator's account, and on every later boot the table is non-empty so no
 * account is generated and no credential is ever printed a second time.
 *
 * A later boot is not silent, though — see `warnIfGeneratedAdminUnused`: the
 * one-time banner can be lost (a process that dies after this row commits, a
 * restart loop scrolling it away), and an install nobody can log into needs to
 * say so.
 */
async function generateFirstRunAdmin(): Promise<void> {
  const password = randomBytes(GENERATED_PASSWORD_BYTES).toString("base64url");
  const passwordHash = await Bun.password.hash(password);
  // Persist before printing: a banner for a credential that failed to store
  // would send the operator to a login that can never succeed.
  createUser(GENERATED_ADMIN_USERNAME, passwordHash, "admin", GENERATED_ADMIN_CREATED_BY);
  printFirstRunCredentials(GENERATED_ADMIN_USERNAME, password);
  log(
    "warn",
    "No admin user existed and no BOOTSTRAP_ADMIN_USERNAME/PASSWORD were configured — generated a random " +
      "first-run admin. Its password was printed to stdout once and is not recoverable; change it after signing in.",
    { username: GENERATED_ADMIN_USERNAME },
  );
}

/**
 * Recovery hint for the one shape a lost first-run credential leaves behind: an
 * `admin` row this module GENERATED (so its password was random, printed once
 * and never stored) that has never been signed into, on an install with no
 * Bearer way in.
 *
 * Why this exists: the banner is written once and only the argon2id hash is
 * kept, so anything that ends the process after the row commits burns the
 * credential — and in the zero-config story there is no ADMIN_API_KEYS Bearer
 * path and no password-reset route, so silence here left the operator with no
 * documented way back in except deleting the database. `bootstrapAdminUser()`
 * running after every `process.exit` gate is the primary fix; this is the
 * belt-and-braces half, for the cases no ordering can prevent (an operator who
 * simply missed the output, a crash loop that scrolled it away).
 *
 * Every claim the message makes has to be true of the install reading it, and
 * three conditions is what that costs — the message says a password cannot be
 * printed or regenerated and offers DELETING the account as a way out, so a
 * false positive is destructive advice, not just noise:
 *  - `createdBy === GENERATED_ADMIN_CREATED_BY` — the account really is the
 *    generated one. An operator-created replacement named `admin`, and an
 *    account bootstrapped from BOOTSTRAP_ADMIN_USERNAME=admin (the documented
 *    quickstart), both have a password their operator chose and know it.
 *  - `lastLoginAt === null` — one successful sign-in ends it permanently, so a
 *    healthy install prints it at most until its first login.
 *  - no `adminApiKeys` — recovery route 1 IS "set ADMIN_API_KEYS, then POST
 *    /admin-api/users". An install that already has them needs no advice and
 *    never signs into the UI, so `lastLoginAt` would stay null forever and this
 *    would print on every restart, recommending what is already in place.
 * No credential is emitted here; that guarantee is `printFirstRunCredentials`'s
 * alone and stays first-run-only.
 */
function warnIfGeneratedAdminUnused(): void {
  if (config.adminApiKeys.length > 0) return;
  const generated = findUserByUsername(GENERATED_ADMIN_USERNAME);
  if (!generated || generated.createdBy !== GENERATED_ADMIN_CREATED_BY || generated.lastLoginAt !== null) return;
  log(
    "warn",
    `Admin user "${GENERATED_ADMIN_USERNAME}" has never signed in, and no password can be printed or regenerated ` +
      "for it — only an argon2id hash is stored. If the one-time first-run credentials banner was missed, recover " +
      "via one of the paths below instead of assuming the instance is unusable.",
    {
      username: GENERATED_ADMIN_USERNAME,
      recovery: [
        "Set ADMIN_API_KEYS to a strong value, restart, then create a replacement admin with that Bearer token: POST /admin-api/users",
        `Delete the "${GENERATED_ADMIN_USERNAME}" row from admin_users — when it is the only account, the next boot generates and prints a fresh credential`,
      ],
      // Both stop conditions, so an operator who takes the first path is not
      // left wondering why the message vanished without them signing in.
      stopsAfter: "the first successful sign-in for this account, or setting ADMIN_API_KEYS (recovery path 1)",
    },
  );
}

/**
 * Seeds the very first admin user when `admin_users` is empty — from
 * BOOTSTRAP_ADMIN_USERNAME/PASSWORD when both are set, otherwise from a
 * generated random credential printed once to stdout. Deliberately NOT wired
 * into `checkStartupGuards` — a failed bootstrap is a functionality gap (the UI
 * is unusable), not a security hole (Bearer-token callers are unaffected), so
 * it must never abort startup for existing API-only deployments.
 *
 * ORDERING REQUIREMENT: call this only once every boot check that can
 * `process.exit` has passed. The generated password exists in memory for one
 * `printFirstRunCredentials` call and nowhere else afterwards, so a fatal check
 * running AFTER this leaves the row committed (to a mounted volume, typically)
 * with its credential gone — the failure the caller in `src/index.ts` is
 * ordered to avoid.
 */
export async function bootstrapAdminUser(): Promise<void> {
  const existing = countUsers();
  const { bootstrapAdminUsername: username, bootstrapAdminPassword: password } = config;

  if (existing > 0) {
    if (username || password) {
      log(
        "warn",
        `BOOTSTRAP_ADMIN_USERNAME/PASSWORD are set but ${existing} admin user(s) already exist — ignoring. Remove these env vars.`,
      );
    }
    // Also runs on the ignored-env path on purpose: setting BOOTSTRAP_ADMIN_*
    // is the natural first attempt at recovering a lost credential, and that
    // warning alone says only "ignoring", never how to get in.
    warnIfGeneratedAdminUnused();
    return;
  }

  if (!username && !password) {
    await generateFirstRunAdmin();
    return;
  }

  if (!username || !password) {
    // Half-configured is a mistake, not a request for a generated account:
    // silently ignoring the half that WAS set and handing back a different
    // username/password pair would be worse than refusing. Fail closed and say
    // which way out is which.
    log(
      "warn",
      "Only one of BOOTSTRAP_ADMIN_USERNAME/BOOTSTRAP_ADMIN_PASSWORD is set — both are required, so no admin " +
        "user was created and the admin UI is inaccessible. Set both, or unset both to get a generated first-run admin.",
    );
    return;
  }

  if (password.length < MIN_BOOTSTRAP_PASSWORD_LENGTH) {
    log(
      "error",
      `BOOTSTRAP_ADMIN_PASSWORD is shorter than the required ${MIN_BOOTSTRAP_PASSWORD_LENGTH} characters — refusing to bootstrap a weak admin password.`,
    );
    return;
  }

  const passwordHash = await Bun.password.hash(password);
  createUser(username, passwordHash, "admin", null);
  log(
    "warn",
    "Bootstrapped the initial admin user from BOOTSTRAP_ADMIN_USERNAME/PASSWORD. " +
      "Unset those env vars now and rotate the password after first login.",
    { username },
  );
}
