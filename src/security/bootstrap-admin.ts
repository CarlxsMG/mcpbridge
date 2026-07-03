import { config } from "../config.js";
import { log } from "../logger.js";
import { countUsers, createUser } from "./user-store.js";

const MIN_BOOTSTRAP_PASSWORD_LENGTH = 12;

/**
 * Seeds the very first admin user from BOOTSTRAP_ADMIN_USERNAME/PASSWORD when
 * `admin_users` is empty. Deliberately NOT wired into `checkStartupGuards` —
 * an empty admin_users table is a functionality gap (the UI is unusable until
 * bootstrapped), not a security hole (Bearer-token callers are unaffected),
 * so it must never abort startup for existing API-only deployments.
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
    return;
  }

  if (!username || !password) {
    log(
      "warn",
      "No admin users exist yet and BOOTSTRAP_ADMIN_USERNAME/BOOTSTRAP_ADMIN_PASSWORD were not provided — " +
        "the admin UI is inaccessible until an admin user is bootstrapped.",
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
