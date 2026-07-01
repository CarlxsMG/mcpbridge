import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// Dev server proxies /admin-api to the Express backend so the browser only
// ever sees one origin — zero CORS config needed, cookies work with no
// special handling, and frontend code stays identical between dev and prod
// (always relative /admin-api/... paths).
export default defineConfig({
  plugins: [vue()],
  base: "/admin/",
  server: {
    proxy: {
      "/admin-api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
