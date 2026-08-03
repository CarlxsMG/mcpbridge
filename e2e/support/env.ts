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

/**
 * Paths served by the fixture server (see support/fixture-server.ts).
 *
 * `/openapi.json` serves the repo's shared fixtures/simple-openapi.json
 * unchanged — backend unit tests assert on that file, so it must not grow new
 * paths. `/openapi-extended.json` is the e2e-only superset that adds the
 * endpoints the newer specs need (a failing endpoint for the circuit breaker,
 * a secret-leaking one for the sanitizer, a slow one for timeout guards).
 */
export const FIXTURE_OPENAPI_PATH = "/openapi.json";
export const FIXTURE_OPENAPI_EXTENDED_PATH = "/openapi-extended.json";
export const FIXTURE_GRAPHQL_PATH = "/graphql";

/**
 * WebSocket upstream the ws-proxy specs point a target at.
 *
 * Reached as `ws://localhost:<FIXTURE_PORT>/ws` — deliberately by HOSTNAME, not
 * by IP: `pinnedWsDial` returns a raw-IP URL unchanged, so a `127.0.0.1` target
 * would skip the very rewrite the spec exists to pin.
 */
/** Health endpoint that CAN be made to fail — only the eviction spec registers against it. */
export const FIXTURE_HEALTH_TOGGLE_PATH = "/health-toggle";

export const FIXTURE_WS_PATH = "/ws";
export const FIXTURE_WS_HOSTNAME = "localhost";
export const FIXTURE_WS_URL = `ws://${FIXTURE_WS_HOSTNAME}:${FIXTURE_PORT}${FIXTURE_WS_PATH}`;

/**
 * Control channel for toggling fixture behaviour mid-spec (used by the circuit
 * breaker spec to make a single tool endpoint start failing without taking
 * `/health` down with it — health-check eviction would otherwise remove the
 * client before the breaker could trip).
 */
export const FIXTURE_CONTROL_PATH = "/__control";
