/**
 * Ephemeral-port HTTP server fixtures for backend tests.
 *
 * ~100 test files stand up a real Express app on a random loopback port and
 * derive its base URL. The surrounding `startApp()` differs per file — which
 * routes get mounted, which middleware, what config is pinned — and that part
 * SHOULD stay visible in each test. What is identical everywhere is the
 * promisified `app.listen(0, "127.0.0.1", ...)` dance plus the
 * `srv.address() as AddressInfo` cast needed to read the assigned port.
 *
 * So this extracts the listen, not `startApp`. That deliberately sidesteps the
 * fact that `startApp` has nine mutually incompatible signatures across the
 * suite (returning void, a string, an Express, a teardown thunk, ...): there is
 * no single correct shape to force them into, and trying would have rewritten
 * call sites in ~100 files to no benefit.
 *
 * Note `listen` rejects on the server's `error` event. Roughly a third of the
 * hand-rolled copies omitted that, so a failed bind (EADDRINUSE from a leaked
 * server in an earlier file) resolved never and hung the run instead of
 * failing it.
 */
import type { Express } from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Bind `app` to an OS-assigned port on loopback.
 *
 * Resolves once the server is accepting connections, with the base URL to
 * point requests at and the handle to pass to {@link closeServer}.
 */
export function listen(app: Express): Promise<{ baseUrl: string; server: Server }> {
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      resolve({ baseUrl: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, server: srv });
    });
    srv.on("error", reject);
  });
}

/**
 * Close a server opened by {@link listen}, resolving once it has stopped.
 *
 * Safe to call on an already-closed server: `close()` invokes its callback
 * with an error in that case, which is ignored here — a test tearing down
 * twice is not a failure worth propagating.
 */
export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
