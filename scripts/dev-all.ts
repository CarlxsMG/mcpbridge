#!/usr/bin/env bun
/**
 * Starts the backend (bun --watch) and the admin-ui (vite) dev servers together,
 * streams both logs to this terminal, and tears both down on Ctrl-C or when
 * either one exits. Dependency-free (Bun.spawn) — no `concurrently`.
 *
 * Ports come from the root .env (Bun auto-loads it): PORT drives the backend and
 * is forwarded to Vite as BACKEND_PORT so the /admin-api proxy stays in sync.
 * Override the UI port with UI_PORT.
 */
const root = `${import.meta.dir}/..`;

// Absolute path to THIS bun executable. On Windows, Bun.spawn(["bun", …]) can
// fail to resolve the bare "bun" from PATH (ENOENT) — especially when a custom
// env is passed — so we spawn the runtime by its real path instead.
const bunExe = process.execPath;

const backendPort = process.env.PORT ?? "8790";
const uiPort = process.env.UI_PORT ?? "8791";

console.log(`[dev:all] backend  → http://localhost:${backendPort}`);
console.log(`[dev:all] admin-ui → http://localhost:${uiPort}/admin/  (login here)`);

// Backend: no explicit env so Bun re-loads the root .env from this cwd.
const backend = Bun.spawn([bunExe, "--watch", "src/index.ts"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
  stdin: "ignore",
});

// Admin UI: forward the resolved ports so vite.config's proxy target matches.
const ui = Bun.spawn([bunExe, "run", "dev"], {
  cwd: `${root}/admin-ui`,
  env: { ...process.env, BACKEND_PORT: backendPort, UI_PORT: uiPort },
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
});

let shuttingDown = false;
function shutdown(code: number): never {
  if (!shuttingDown) {
    shuttingDown = true;
    for (const p of [backend, ui]) {
      try {
        p.kill();
      } catch {
        /* already gone */
      }
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// If either dev server dies, bring the other down too so you're never left with
// half a stack running.
await Promise.race([
  backend.exited.then(() => console.error("\n[dev:all] backend exited — stopping admin-ui")),
  ui.exited.then(() => console.error("\n[dev:all] admin-ui exited — stopping backend")),
]);
shutdown(1);
