import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

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
  plugins: [vue()],
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
});
