import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_BASE_URL, APP_PORT, BOOTSTRAP_ADMIN_PASSWORD, BOOTSTRAP_ADMIN_USERNAME } from "./e2e/support/env";

// Fresh, isolated SQLite file per run, outside the repo entirely — never
// touches (or races with) dev data at ./data/mcp-bridge.db, and needs no
// cleanup since it lives under the OS temp dir.
const e2eDbDir = mkdtempSync(join(tmpdir(), "mcp-bridge-e2e-"));
const e2eDbPath = join(e2eDbDir, "e2e.db");

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: [["list"]],
  globalSetup: "./e2e/support/global-setup.ts",

  use: {
    baseURL: APP_BASE_URL,
    trace: "retain-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],

  // Boots the real stack: builds the admin-ui SPA (bridge serves it as static
  // files at /admin — see src/index.ts), then starts the backend against a
  // throwaway SQLite DB on a dedicated test port. `bun run build` is the
  // root-level convenience script (admin-ui/package.json's own `build`
  // wrapped one directory up) — see package.json.
  webServer: {
    command: "bun run build && bun run start",
    url: `${APP_BASE_URL}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      NODE_ENV: "development", // required for SESSION_COOKIE_SECURE=false to be accepted (see security/startup-guards.ts)
      PORT: String(APP_PORT),
      DB_PATH: e2eDbPath,
      SESSION_COOKIE_SECURE: "false", // Playwright hits http://localhost, not https
      BOOTSTRAP_ADMIN_USERNAME,
      BOOTSTRAP_ADMIN_PASSWORD,
      ALLOW_PRIVATE_IPS: "true", // lets discovery/registration target the loopback fixture server (SSRF guard escape hatch)
      ADMIN_API_KEYS: "",
      MCP_API_KEYS: "", // empty = /mcp stays in "open mode" for the raw JSON-RPC call in the spec
      CORS_ORIGINS: "",
      METRICS_ENABLED: "false",
      LOG_FORMAT: "text",

      // The whole suite hits the backend from one IP (127.0.0.1), so every
      // spec's logins, registrations and tool calls land in the SAME rate-limit
      // bucket. At the shipped defaults (10 logins, 10 registrations, 100 MCP
      // calls per window) the suite throttles itself somewhere in the middle
      // and fails with a 429 that looks nothing like the bug it interrupts.
      // Raised well past what the suite can emit, so the only rate limiting an
      // assertion ever sees is the PER-TOOL guard a spec configures itself
      // (enforced in proxyToolCall from the DB, not from these env knobs) —
      // which is exactly what guard-enforcement.spec.ts asserts on.
      RATE_LIMIT_LOGIN: "100000",
      RATE_LIMIT_REGISTER: "100000",
      RATE_LIMIT_MCP: "100000",
      RATE_LIMIT_GLOBAL: "1000000",
      RATE_LIMIT_EXPENSIVE: "100000",

      // Trip breakers on the second consecutive failure instead of the third,
      // so circuit-breaker.spec.ts needs one less round trip to open one. Specs
      // that care about the exact number set it per client via the admin API.
      CIRCUIT_BREAKER_FAILURE_THRESHOLD: "2",
    },
  },
});
