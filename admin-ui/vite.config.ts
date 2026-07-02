import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// Uncommon/high ports so they don't clash with 3000/5173/8080. Overridable via
// env (dev:all passes them); the defaults must match PORT in the root .env.
const UI_PORT = Number(process.env.UI_PORT) || 8791;
const BACKEND_PORT = Number(process.env.BACKEND_PORT) || 8790;

// Dev server proxies /admin-api to the Express backend so the browser only
// ever sees one origin — zero CORS config needed, cookies work with no
// special handling, and frontend code stays identical between dev and prod
// (always relative /admin-api/... paths).
export default defineConfig({
  plugins: [vue()],
  base: "/admin/",
  server: {
    port: UI_PORT,
    strictPort: true, // fail loudly if the port is taken instead of silently picking another (would break the proxy assumption)
    proxy: {
      "/admin-api": {
        target: `http://127.0.0.1:${BACKEND_PORT}`,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
