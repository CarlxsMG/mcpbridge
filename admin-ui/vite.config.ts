import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";
import VueI18nPlugin from "@intlify/unplugin-vue-i18n/vite";

// Uncommon/high ports so they don't clash with 3000/5173/8080. Overridable via
// env (dev:all passes them); the defaults must match PORT in the root .env.
const UI_PORT = Number(process.env.UI_PORT) || 8791;
const BACKEND_PORT = Number(process.env.BACKEND_PORT) || 8790;

// Public "try it" demo build (VITE_DEMO=true): a standalone SPA with an in-browser
// mock backend, published to GitHub Pages under DEMO_BASE (e.g. /mcpbridge/demo/).
// It builds to a separate dist-demo/ so it never clobbers the real product build.
const IS_DEMO = process.env.VITE_DEMO === "true";
const DEMO_BASE = process.env.DEMO_BASE || "/demo/";

// Dev server proxies /admin-api to the Express backend so the browser only
// ever sees one origin — zero CORS config needed, cookies work with no
// special handling, and frontend code stays identical between dev and prod
// (always relative /admin-api/... paths).
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  plugins: [
    vue(),
    VueI18nPlugin({
      // All messages live in JSON files under src/locales/. SFC <i18n> blocks
      // are intentionally NOT used — they scatter strings across .vue files
      // and break the per-locale JSON review workflow. The plugin is included
      // here so future contributors can opt in via a per-block override
      // without further config, but currently no .vue file matches.
      include: ["src/locales/**"],
      // Source of truth for runtime locale composition + type-safe keys. We use
      // a global `t()` injection (configured in `src/i18n.ts`), so the
      // `compositionApi` mode matches vue-i18n v10's default install.
      compositionApi: true,
      runtimeOnly: false,
    }),
  ],
  base: IS_DEMO ? DEMO_BASE : "/admin/",
  server: {
    port: UI_PORT,
    strictPort: true, // fail loudly if the port is taken instead of silently picking another (would break the proxy assumption)
    proxy: {
      "/admin-api": {
        target: `http://127.0.0.1:${BACKEND_PORT}`,
        changeOrigin: false,
      },
      // /register lives at the backend root (sibling to /admin-api, see
      // src/routes/register.ts) — in production it's same-origin because
      // Express serves both; the dev proxy needs its own entry or the
      // register/re-sync flows 404 against the Vite dev server instead.
      "/register": {
        target: `http://127.0.0.1:${BACKEND_PORT}`,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: IS_DEMO ? "dist-demo" : "dist",
    emptyOutDir: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    coverage: {
      provider: "v8",
      // Ratchet floor: set a few points below the current numbers so the gate can't
      // silently decay the (still-thin) admin-UI coverage, and can be raised as page
      // and composable tests are added. `bun run test:coverage` locally; CI enforces
      // it on every push/PR. The root backend project already gates at 90/85.
      thresholds: {
        lines: 65,
        statements: 62,
        // Held at 56 (measured ~59%): the previous 58 sat <1pp under the measured
        // number, so the next untested helper would have reddened CI. Keep a few
        // points of slack — raise it deliberately when a batch of tests lifts the
        // floor, not by chasing the current run.
        functions: 56,
        // Ratcheted up (48 -> 52) after the ConnectClientDialog/SchemaForm/
        // SelectMenu/GuardEditor and Config/Sso/BundleDetail/CompositeDetail page
        // tests landed — kept a few points under the measured ~55% so ordinary
        // branch-coverage jitter can't red the gate.
        branches: 52,
      },
    },
  },
});
