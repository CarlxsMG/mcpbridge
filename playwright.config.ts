import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_BASE_URL, APP_PORT, BOOTSTRAP_ADMIN_PASSWORD, BOOTSTRAP_ADMIN_USERNAME } from "./e2e/env";

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
  globalSetup: "./e2e/global-setup.ts",

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
    },
  },
});
