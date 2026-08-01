/**
 * Shared constants for the Playwright e2e smoke test — imported by
 * playwright.config.ts (to configure webServer.env) and by the spec /
 * global-setup files, so the port numbers and bootstrap credentials never
 * drift out of sync between the two.
 */

/** Port the bridge backend (+ built admin-ui it serves at /admin) listens on for e2e. */
export const APP_PORT = 8793;
export const APP_BASE_URL = `http://127.0.0.1:${APP_PORT}`;

/** Port the tiny fixture HTTP server (OpenAPI doc + fake REST backend) listens on. */
export const FIXTURE_PORT = 8794;
export const FIXTURE_BASE_URL = `http://127.0.0.1:${FIXTURE_PORT}`;

/** Bootstrap admin seeded via BOOTSTRAP_ADMIN_USERNAME/PASSWORD (>= 12 char password required). */
export const BOOTSTRAP_ADMIN_USERNAME = "e2e-admin";
export const BOOTSTRAP_ADMIN_PASSWORD = "e2e-admin-password-2026";

/** Name under which the fixture REST API is registered as a backend client. */
export const DEMO_SERVER_NAME = "e2e-demo-api";
