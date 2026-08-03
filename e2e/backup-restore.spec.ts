/**
 * End-to-end coverage for the two things this gateway calls "backup", which are
 * separate mechanisms with separate restore stories — and only one of them has
 * a restore endpoint at all:
 *
 *  1. `POST /admin-api/backup` — a full SQLite snapshot of the admin database,
 *     produced with `VACUUM INTO` and streamed back as a download. There is NO
 *     restore route: recovery means stopping the process and putting the file
 *     back. So the only property worth proving end to end is that the bytes you
 *     download are actually a restorable database containing your data. This
 *     spec proves it the only way that means anything — by opening the
 *     downloaded file as a real SQLite database and querying it.
 *
 *     That matters more than it sounds. The reason `VACUUM INTO` is used rather
 *     than copying the `.db` file is that under WAL mode the main file alone is
 *     NOT a consistent snapshot — committed rows can still be in the `-wal`
 *     sidecar. A regression to `fs.copyFile` would still return 200, still
 *     stream plausible bytes, and still pass any assertion about status codes
 *     or Content-Length. It would only be caught by reading the data back.
 *
 *  2. `/admin-api/config/*` — config-as-code export/import plus versioned
 *     snapshots with rollback. This one is a genuine round trip, so it is
 *     asserted as one: capture, mutate, restore, and prove the mutation is gone.
 *
 * Both surfaces are super-admin only (`requireSuperAdmin`), and the backup route
 * is additionally rate-limited, so this spec makes exactly one backup call.
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_BASE_URL } from "./support/env";
import {
  type AdminAuth,
  adminAuthHeaders,
  apiHeaders,
  createAdminUser,
  deleteClient,
  login,
  registerViaApi,
} from "./support/admin";

/** A client registered by this spec, used as the row we look for inside the snapshot. */
const MARKER_CLIENT = "e2e-backup-marker-api";
/** A bundle created, then deliberately mutated, to drive the config round trip. */
const ROUND_TRIP_BUNDLE = "e2e-backup-bundle";
/** Discovered from the shared OpenAPI fixture; the guard patch below targets it. */
const MARKER_TOOL = "list-users";
/** A deliberately low-privilege account, owned by this spec (see the authz test). */
const LOW_PRIV = {
  username: "e2e-backup-viewer",
  password: "e2e-backup-viewer-pw-2026",
  role: "viewer",
} as const;

interface ImportResult {
  applied?: Record<string, number>;
  skipped?: unknown[];
}

interface BundleDetail {
  name: string;
  description: string | null;
  enabled: boolean;
}

async function getBundle(request: APIRequestContext, auth: AdminAuth, name: string): Promise<BundleDetail | null> {
  const res = await request.get(`${APP_BASE_URL}/admin-api/bundles/${name}`, { headers: apiHeaders(auth) });
  if (res.status() !== 200) return null;
  return (await res.json()) as BundleDetail;
}

/** What reading the downloaded snapshot back as a database found in it. */
interface SnapshotContents {
  client: string | null;
  auditRows: number;
  toolRows: number;
}

/**
 * Open a `.db` file and report what is inside it.
 *
 * Runs in a `bun` CHILD PROCESS rather than importing `bun:sqlite` directly:
 * Playwright executes spec files under NODE's ESM loader, which rejects the
 * `bun:` scheme outright ("Only URLs with a scheme in: file, data, and node are
 * supported"). Shelling out keeps the verification in the runtime that owns the
 * driver and adds no dependency — bun is this repo's toolchain.
 *
 * `shell: true` is required because bun is not always resolvable by Node's
 * direct spawn (on Windows it is an npm shim with no PATHEXT match). Since that
 * mode concatenates arguments WITHOUT escaping them, nothing variable is passed
 * as an argument: the database path and client name are baked into the
 * generated script, leaving one argument that this function itself created
 * under the OS temp dir and quotes explicitly.
 */
function readSnapshot(workDir: string, dbPath: string, clientName: string): SnapshotContents {
  const scriptPath = join(workDir, "read-snapshot.ts");
  writeFileSync(
    scriptPath,
    `import { Database } from "bun:sqlite";
const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });
const client = db.query("SELECT name FROM clients WHERE name = ?").get(${JSON.stringify(clientName)});
const audit = db.query("SELECT COUNT(*) AS n FROM admin_audit_log WHERE action = ? AND target = ?").get("tool.guards.update", ${JSON.stringify(`${clientName}__${MARKER_TOOL}`)});
const tools = db.query("SELECT COUNT(*) AS n FROM tools WHERE client_name = ?").get(${JSON.stringify(clientName)});
db.close();
console.log(JSON.stringify({ client: client?.name ?? null, auditRows: audit.n, toolRows: tools.n }));
`,
  );
  let out: string;
  try {
    out = execSync(`bun "${scriptPath}"`, { encoding: "utf-8" });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Two very different causes land here, so name both rather than guessing.
    // "no such table" means the SNAPSHOT is bad — which is the real signal, and
    // exactly what a regression from VACUUM INTO to a raw file copy produces,
    // since under WAL the main .db file may carry no schema at all.
    const looksLikeBadSnapshot = /no such table|file is not a database|malformed/i.test(detail);
    throw new Error(
      looksLikeBadSnapshot
        ? `the downloaded snapshot is not a usable database: ${detail}`
        : `could not run the snapshot reader (is bun on PATH?): ${detail}`,
      { cause: err },
    );
  }
  return JSON.parse(out.trim()) as SnapshotContents;
}

test.describe("backup and restore", () => {
  let page: Page;
  let request: APIRequestContext;
  let auth: AdminAuth;
  let workDir: string;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    request = page.context().request;
    await login(page);
    auth = await adminAuthHeaders(page);
    workDir = mkdtempSync(join(tmpdir(), "e2e-backup-"));

    // A row that must survive into the snapshot. Registering through the real
    // path (rather than writing SQL) is what makes its presence meaningful.
    await registerViaApi(request, auth, MARKER_CLIENT);

    // An action that IS audited, so the snapshot has a deterministic audit row
    // to look for. Registration itself writes NO audit entry (routes/register.ts
    // has no recordAudit call) — asserting "the audit log is non-empty" instead
    // would pass only because OTHER specs happened to run first.
    const guarded = await request.patch(`${APP_BASE_URL}/admin-api/clients/${MARKER_CLIENT}/tools/${MARKER_TOOL}`, {
      headers: apiHeaders(auth),
      data: { guards: { rateLimitPerMin: 99 } },
    });
    expect(guarded.status(), `guard patch failed: ${await guarded.text()}`).toBe(200);
  });

  test.afterAll(async () => {
    await request.delete(`${APP_BASE_URL}/admin-api/bundles/${ROUND_TRIP_BUNDLE}`, { headers: apiHeaders(auth) });
    await deleteClient(request, auth, MARKER_CLIENT);
    rmSync(workDir, { recursive: true, force: true });
    await page.close();
  });

  // ── (1) The database snapshot ──────────────────────────────────────────────

  test("the downloaded backup is a real SQLite database containing the live data", async () => {
    const res = await request.post(`${APP_BASE_URL}/admin-api/backup`, { headers: apiHeaders(auth) });
    expect(res.status(), `backup failed: ${await res.text()}`).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/octet-stream");
    // The route names the file for the operator downloading it.
    expect(res.headers()["content-disposition"]).toMatch(/attachment; filename="mcp-bridge-backup-.*\.db"/);

    const bytes = Buffer.from(await res.body());
    expect(bytes.byteLength, "an empty backup is not a backup").toBeGreaterThan(0);
    // SQLite's file magic. Checked before opening so a corrupt download fails
    // here with an obvious message rather than deep inside the driver.
    expect(bytes.subarray(0, 15).toString("utf-8")).toBe("SQLite format 3");

    const restored = join(workDir, "restored.db");
    writeFileSync(restored, bytes);

    // THE assertion: open the snapshot as a database and read the data back.
    const contents = readSnapshot(workDir, restored, MARKER_CLIENT);

    expect(contents.client, "the client registered before the backup is missing from the snapshot").toBe(MARKER_CLIENT);
    // A second table, so this proves a whole database round-tripped rather than
    // one lucky page — and a SPECIFIC row, written by beforeAll's guard patch,
    // rather than a non-empty count that other specs would satisfy for free.
    expect(contents.auditRows, "the snapshot lost the audited guard change made before it").toBeGreaterThan(0);
    // And the tools discovered for that client, which live in their own table —
    // a snapshot that dropped a join partner would still pass the check above.
    expect(contents.toolRows, "the snapshot kept the client but lost its tools").toBeGreaterThan(0);
  });

  test("creating a backup is audited", async () => {
    const res = await request.get(`${APP_BASE_URL}/admin-api/audit-log?action=backup.create&limit=5`, {
      headers: apiHeaders(auth),
    });
    expect(res.status()).toBe(200);
    const { items } = (await res.json()) as { items: { action: string; target: string }[] };
    expect(items.length, "the backup above left no audit entry").toBeGreaterThan(0);
    expect(items[0].action).toBe("backup.create");
    expect(items[0].target).toBe("database");
  });

  // ── (2) The config round trip ──────────────────────────────────────────────

  test("export -> mutate -> import restores the captured state", async () => {
    // Something of our own in the export, so the assertions below are about
    // this spec's data and not whatever other specs happen to have left.
    const created = await request.post(`${APP_BASE_URL}/admin-api/bundles`, {
      headers: apiHeaders(auth),
      data: { name: ROUND_TRIP_BUNDLE, description: "original", tools: [], composites: [] },
    });
    expect([201, 409], `bundle create failed: ${await created.text()}`).toContain(created.status());
    // A re-run meets the previous run's bundle, so force the known starting state.
    await request.patch(`${APP_BASE_URL}/admin-api/bundles/${ROUND_TRIP_BUNDLE}`, {
      headers: apiHeaders(auth),
      data: { description: "original", enabled: true },
    });

    const exported = await request.get(`${APP_BASE_URL}/admin-api/config/export`, { headers: apiHeaders(auth) });
    expect(exported.status()).toBe(200);
    const snapshot = (await exported.json()) as { version: unknown; bundles?: { name: string }[] };
    expect(snapshot.version, "an export with no version cannot be re-imported").toBeDefined();
    expect(snapshot.bundles?.some((b) => b.name === ROUND_TRIP_BUNDLE)).toBe(true);

    // Mutate away from the captured state.
    const patched = await request.patch(`${APP_BASE_URL}/admin-api/bundles/${ROUND_TRIP_BUNDLE}`, {
      headers: apiHeaders(auth),
      data: { description: "MUTATED", enabled: false },
    });
    expect(patched.status(), `bundle patch failed: ${await patched.text()}`).toBe(200);
    const mutated = await getBundle(request, auth, ROUND_TRIP_BUNDLE);
    expect(mutated?.description).toBe("MUTATED");
    expect(mutated?.enabled).toBe(false);

    // Restore.
    const imported = await request.post(`${APP_BASE_URL}/admin-api/config/import`, {
      headers: apiHeaders(auth),
      data: { data: snapshot },
    });
    expect(imported.status(), `import failed: ${await imported.text()}`).toBe(200);

    const restored = await getBundle(request, auth, ROUND_TRIP_BUNDLE);
    expect(restored?.description, "import did not restore the captured description").toBe("original");
    expect(restored?.enabled, "import did not restore the captured enabled flag").toBe(true);
  });

  test("a dry-run import reports what it would do and changes nothing", async () => {
    const exported = await request.get(`${APP_BASE_URL}/admin-api/config/export`, { headers: apiHeaders(auth) });
    const snapshot = await exported.json();

    await request.patch(`${APP_BASE_URL}/admin-api/bundles/${ROUND_TRIP_BUNDLE}`, {
      headers: apiHeaders(auth),
      data: { description: "DRY-RUN-MUTATION" },
    });

    const dry = await request.post(`${APP_BASE_URL}/admin-api/config/import`, {
      headers: apiHeaders(auth),
      data: { dryRun: true, data: snapshot },
    });
    expect(dry.status(), `dry run failed: ${await dry.text()}`).toBe(200);
    const result = (await dry.json()) as ImportResult;
    // It must still REPORT the work — a dry run that reports nothing is
    // indistinguishable from one that parsed nothing.
    expect(result.applied, "a dry run reported no planned work").toBeDefined();

    // …and must not have performed it.
    const after = await getBundle(request, auth, ROUND_TRIP_BUNDLE);
    expect(after?.description, "a dry-run import wrote to the database").toBe("DRY-RUN-MUTATION");
  });

  test("an export with an unsupported version is refused", async () => {
    const res = await request.post(`${APP_BASE_URL}/admin-api/config/import`, {
      headers: apiHeaders(auth),
      data: { data: { version: "definitely-not-a-real-version", bundles: [] } },
    });
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain("IMPORT_ERROR");
  });

  // ── (3) Versioned snapshots ────────────────────────────────────────────────

  test("a snapshot can be taken and rolled back to", async () => {
    await request.patch(`${APP_BASE_URL}/admin-api/bundles/${ROUND_TRIP_BUNDLE}`, {
      headers: apiHeaders(auth),
      data: { description: "at-snapshot-time", enabled: true },
    });

    const taken = await request.post(`${APP_BASE_URL}/admin-api/config/snapshots`, {
      headers: apiHeaders(auth),
      data: { label: "e2e-backup-rollback" },
    });
    expect([200, 201], `snapshot failed: ${await taken.text()}`).toContain(taken.status());
    const { id } = (await taken.json()) as { id: number };
    expect(typeof id, "the snapshot response carries no id to roll back to").toBe("number");

    await request.patch(`${APP_BASE_URL}/admin-api/bundles/${ROUND_TRIP_BUNDLE}`, {
      headers: apiHeaders(auth),
      data: { description: "drifted-after-snapshot", enabled: false },
    });
    expect((await getBundle(request, auth, ROUND_TRIP_BUNDLE))?.description).toBe("drifted-after-snapshot");

    const rolled = await request.post(`${APP_BASE_URL}/admin-api/config/snapshots/${id}/rollback`, {
      headers: apiHeaders(auth),
    });
    expect(rolled.status(), `rollback failed: ${await rolled.text()}`).toBe(200);

    const restored = await getBundle(request, auth, ROUND_TRIP_BUNDLE);
    expect(restored?.description, "rollback did not restore the snapshotted description").toBe("at-snapshot-time");
    expect(restored?.enabled, "rollback did not restore the snapshotted enabled flag").toBe(true);
  });

  test("rolling back to an unknown snapshot id is refused", async () => {
    const res = await request.post(`${APP_BASE_URL}/admin-api/config/snapshots/99999999/rollback`, {
      headers: apiHeaders(auth),
    });
    expect(res.status()).toBe(404);
    expect(await res.text()).toContain("SNAPSHOT_NOT_FOUND");
  });

  // ── Authorization ──────────────────────────────────────────────────────────

  test("every backup and config surface is super-admin only", async ({ browser }) => {
    // This spec creates its OWN low-privilege account rather than reusing the
    // one rbac-viewer.spec.ts makes: borrowing it silently couples the two
    // files, and running this spec alone then fails at login with an error that
    // says nothing about the missing dependency.
    await createAdminUser(request, auth, LOW_PRIV);

    const context = await browser.newContext();
    try {
      const viewerPage = await context.newPage();
      await login(viewerPage, LOW_PRIV.username, LOW_PRIV.password);
      const viewerAuth = await adminAuthHeaders(viewerPage);
      const headers = apiHeaders(viewerAuth);

      for (const [method, path] of [
        ["post", "/admin-api/backup"],
        ["get", "/admin-api/config/export"],
        ["post", "/admin-api/config/import"],
        ["get", "/admin-api/config/snapshots"],
      ] as const) {
        const res =
          method === "get"
            ? await context.request.get(`${APP_BASE_URL}${path}`, { headers })
            : await context.request.post(`${APP_BASE_URL}${path}`, { headers, data: {} });
        expect(res.status(), `a viewer reached ${method.toUpperCase()} ${path}`).toBe(403);
      }
    } finally {
      await context.close();
    }
  });
});
