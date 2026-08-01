/**
 * Admin-API auth fixtures for backend tests.
 *
 * 65 test files declare a local `bearer()` with a byte-identical body. They are
 * NOT interchangeable, though: each closes over its own file-scoped `ADMIN_KEY`
 * (46 distinct values across 61 declarations), so there is no correct shared
 * zero-argument `bearer()` to extract. What is genuinely shared is the two
 * header shapes and the config write — including the
 * `(config as Record<string, unknown>)` escape hatch, repeated 72 times purely
 * because `adminApiKeys` is readonly on the exported config object.
 *
 * So the unit of reuse here is the header builder, not the function: a file
 * keeps its own key and collapses three lines to one,
 *
 *   const bearer = () => jsonBearerHeaders(ADMIN_KEY);
 *
 * leaving every call site untouched.
 */
import { config } from "../../config.js";

/** `Authorization` only — for GETs and DELETEs that send no body. */
export function bearerHeaders(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}` };
}

/** `Authorization` + JSON content-type — for POST/PATCH/PUT with a JSON body. */
export function jsonBearerHeaders(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

/**
 * Point the admin-API static-key auth at `keys` for the current test.
 *
 * Call this from the test file's own `beforeEach` and restore the captured
 * original in `afterAll`/`afterEach` — this module deliberately installs no
 * hooks of its own. `config.adminApiKeys` is readonly on the exported object,
 * so the cast lives here once instead of at all 72 call sites.
 */
export function setAdminApiKeys(keys: readonly string[]): void {
  (config as Record<string, unknown>).adminApiKeys = [...keys];
}
