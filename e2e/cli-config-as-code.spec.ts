/**
 * End-to-end coverage for the config-as-code CLI (`bun run cli -- <command>`,
 * entry `src/cli/index.ts`), driven as a REAL child process against the REAL
 * running gateway.
 *
 * The CLI's unit tests (src/cli/__tests__/) cover the flag parser, the
 * gateway.yaml load/save round trip, and the `--help` early-return. What they
 * cannot cover is the only thing that makes a config-as-code tool trustworthy:
 * that `plan` is genuinely a dry run against a live server, that `apply`
 * actually mutates it, that a second `plan` then reports nothing, and that
 * every one of those verdicts is reflected in the PROCESS EXIT CODE — a CLI
 * that prints an error and exits 0 silently breaks every pipeline built on it.
 * Each assertion below therefore pairs the CLI's own output with an
 * independent read through the admin API.
 *
 * ── Three things this spec has to work around ──────────────────────────────
 *
 * (1) Playwright runs specs under NODE's ESM loader, and `bun` is not
 *     resolvable by a direct execFile/spawn on every platform (on Windows it's
 *     an npm shim with no PATHEXT match). So the CLI is invoked through a
 *     SHELL. Shell mode concatenates arguments without escaping them, so
 *     nothing variable is ever passed as an argument: every invocation writes
 *     a tiny generated runner into this spec's own temp dir with the argv
 *     baked in as JSON literals, leaving exactly one argument — that runner's
 *     path — which is quoted explicitly. Same approach, same reasons, as
 *     `readSnapshot` in backup-restore.spec.ts.
 *
 * (2) The CLI persists its credentials in `~/.mcpbridge/config.json`
 *     (src/cli/client.ts) — a developer's REAL file, with a real token for a
 *     real gateway in it. `login` would overwrite it and `apply` would then be
 *     pointed at whatever gateway it named. So every child runs with HOME and
 *     USERPROFILE redirected into a throwaway directory, and `beforeAll`
 *     PROVES the redirection took effect (one probe process reading
 *     `os.homedir()` from inside a child) BEFORE any command that writes
 *     credentials or mutates a gateway runs. Asserting it after the fact would
 *     be asserting it one step too late.
 *
 * (3) The CLI authenticates with a static admin Bearer token, and `adminAuth`
 *     (src/middleware/auth.ts) accepts a Bearer only if it matches an entry in
 *     `ADMIN_API_KEYS` — which playwright.config.ts's webServer env sets to the
 *     empty string, so the e2e stack has NO static admin key at all (see the
 *     same note in csrf-session.spec.ts). Rather than reconfigure the shared
 *     harness, this spec puts a tiny loopback shim in front of the gateway
 *     whose ONLY behaviour is to swap the CLI's Bearer for the session cookie +
 *     CSRF header the harness does have. Everything else — routing, RBAC,
 *     SSRF validation, OpenAPI discovery, importConfig — is the real gateway.
 *     A Bearer the shim doesn't recognise is forwarded UNTRANSLATED, so the
 *     rejection the CLI sees is the gateway's own; and the auth-failure test
 *     below bypasses the shim entirely and talks to the gateway direct.
 *
 * Not covered here: `connect` (it hits the live admin API to confirm a target
 * exists, but its output is a static template already pinned by
 * src/cli/__tests__/connect-templates.test.ts), and the `--help`/`version`
 * surface (covered end-to-end by src/cli/__tests__/help.test.ts).
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { APP_BASE_URL, FIXTURE_BASE_URL, FIXTURE_OPENAPI_PATH } from "./support/env";
import { type AdminAuth, adminAuthHeaders, apiHeaders, deleteClient, login, registerViaApi } from "./support/admin";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** The CLI entry point. `bun run cli` is exactly `bun src/cli/index.ts` (package.json). */
const CLI_ENTRY = join(REPO_ROOT, "src", "cli", "index.ts");

/** Registered through the admin API before the first `pull`, so the export has something of ours in it. */
const PULLED_CLIENT = "e2e-cli-pulled";
/** Deliberately absent at the start: `plan` must only promise it, `apply` must actually create it. */
const APPLIED_CLIENT = "e2e-cli-applied";
const BUNDLE = "e2e-cli-bundle";
/** Alert rule seeded so the export has one to replay — the pull/apply round trip used to fail on it. */
const ALERT_RULE = "e2e-cli-alert-rule";
/** The description the admin API sets, and the one `apply` must replace it with. */
const DESC_FROM_API = "created-via-admin-api";
const DESC_FROM_CLI = "applied-by-cli";

/** Longest any single CLI invocation may take. Generous: `apply` does a real OpenAPI discovery round trip. */
const CLI_TIMEOUT_MS = 20_000;

/** The Bearer the shim recognises. Any other value is forwarded to the gateway untranslated. */
const SHIM_TOKEN = "e2e-cli-shim-token";

// ── Local types for the documents this spec reads back ──────────────────────
// Deliberately structural and local rather than imported from src/: the point
// of reading `gateway.yaml` back is to check what the CLI actually wrote, and
// borrowing the producer's own types would assume the answer.

interface PulledBundle {
  name: string;
  description: string | null;
  enabled: boolean;
}
interface PulledClient {
  name: string;
  enabled: boolean;
  tools: { name: string }[];
}
interface PulledAlertRule {
  name: string;
  eventType: string;
  enabled: boolean;
  webhookUrl: string;
}
interface PulledConfig {
  version: number;
  bundles: PulledBundle[];
  clients: PulledClient[];
  alertRules?: PulledAlertRule[];
}
interface GatewayYaml {
  version: number;
  servers?: { name: string }[];
  config?: PulledConfig;
}

interface CliRun {
  status: number;
  stdout: string;
  stderr: string;
}

// ── The credential shim ─────────────────────────────────────────────────────

/**
 * Reverse proxy in front of the gateway that translates exactly one thing: a
 * request carrying `Authorization: Bearer <SHIM_TOKEN>` is replayed with the
 * admin session cookie + `X-CSRF-Token` instead. See note (3) in the header for
 * why this is needed at all. Anything else — a wrong Bearer, no Bearer — is
 * forwarded as-is so the gateway's own `adminAuth` produces the verdict.
 */
function startCredentialShim(auth: AdminAuth): Promise<{ url: string; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise<string>((resolveBody, rejectBody) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", rejectBody);
    });
  }

  async function forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    const offered = req.headers.authorization;
    if (offered === `Bearer ${SHIM_TOKEN}`) {
      headers.cookie = auth.cookie;
      headers["x-csrf-token"] = auth.csrf;
    } else if (typeof offered === "string") {
      headers.authorization = offered;
    }

    const upstream = await fetch(`${APP_BASE_URL}${req.url ?? "/"}`, {
      method: req.method ?? "GET",
      headers,
      body: body.length > 0 ? body : undefined,
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
    res.end(text);
  }

  const server: Server = createServer((req, res) => {
    forward(req, res).catch((err: unknown) => {
      // Surface a shim fault in the CLI's own error envelope shape, so a broken
      // shim reads as "shim failure" rather than masquerading as a gateway bug.
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "SHIM_FAILURE", message: `shim failure: ${String(err)}` } }));
    });
  });
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise((resolveStart) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolveStart({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((resolveClose) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

// ── Driving the CLI ─────────────────────────────────────────────────────────

let workDir = "";
/** Throwaway home the CLI's ~/.mcpbridge/config.json is redirected into. */
let cliHome = "";
let runCounter = 0;

/** Path `saveCliCredentials`/`loadCliCredentials` use, relative to a given home. */
function credentialsPath(home: string): string {
  return join(home, ".mcpbridge", "config.json");
}

/** Write the credential file by hand — the format the CLI's `login` produces. */
function writeCredentials(home: string, creds: { url: string; token: string }): void {
  mkdirSync(dirname(credentialsPath(home)), { recursive: true });
  writeFileSync(credentialsPath(home), JSON.stringify(creds, null, 2), "utf-8");
}

/**
 * Run one `bun <script>` in a shell and hand back its exit code and streams.
 *
 * ASYNCHRONOUS, and that is not a style preference — a synchronous spawn here
 * deadlocks. The credential shim below is an http server running in THIS
 * process, and every CLI command except the offline ones calls it. `spawnSync`
 * blocks the event loop for the child's whole lifetime, so the shim can never
 * answer the request its own child is waiting on: both sides wait until the
 * timeout fires and the failure reads as `spawnSync ETIMEDOUT`, which looks
 * like a missing `bun` rather than a deadlock. Observed on all four
 * gateway-touching tests; the three offline ones passed throughout, which is
 * the tell.
 *
 * `spawn` rather than `exec` because a non-zero exit is a RESULT here, not an
 * exception — most of what this spec asserts is the exit code.
 */
async function runBunScript(scriptPath: string, home: string): Promise<CliRun> {
  return new Promise<CliRun>((resolve, reject) => {
    const child = spawn(`bun "${scriptPath}"`, {
      shell: true,
      // The generated runner imports the CLI by absolute path, so the working
      // directory only decides where a bare `--file gateway.yaml` default would
      // land. Pointed at the temp dir so nothing can ever be written into the repo.
      cwd: workDir,
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));

    // Hand-rolled rather than spawn's own `timeout`, so the streams collected
    // so far survive into the error message — a CLI that hung after printing
    // something is a very different diagnosis from one that never started.
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`the gateway CLI did not exit within ${CLI_TIMEOUT_MS}ms. stdout: ${stdout} stderr: ${stderr}`));
    }, CLI_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`could not run the gateway CLI (is bun on PATH?): ${err.message}`, { cause: err }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * Invoke the CLI with `args`. The argv is baked into a generated runner rather
 * than appended to the shell command — see note (1) in the header; temp paths
 * routinely contain spaces and backslashes.
 */
async function runCli(args: string[], home: string = cliHome): Promise<CliRun> {
  const runnerPath = join(workDir, `run-cli-${++runCounter}.ts`);
  writeFileSync(
    runnerPath,
    `// generated by e2e/cli-config-as-code.spec.ts
process.argv = [process.argv[0], ${JSON.stringify(CLI_ENTRY)}, ...${JSON.stringify(args)}];
await import(${JSON.stringify(pathToFileURL(CLI_ENTRY).href)});
`,
    "utf-8",
  );
  return runBunScript(runnerPath, home);
}

/** What `os.homedir()` resolves to inside a child launched with `home`. */
async function probeChildHomedir(home: string): Promise<string> {
  const probePath = join(workDir, "probe-homedir.ts");
  writeFileSync(probePath, `import { homedir } from "os";\nconsole.log(homedir());\n`, "utf-8");
  const run = await runBunScript(probePath, home);
  if (run.status !== 0) throw new Error(`home-directory probe failed (${run.status}): ${run.stderr}`);
  return run.stdout.trim();
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string =>
    resolve(p)
      .replace(/[\\/]+$/, "")
      .toLowerCase();
  return norm(a) === norm(b);
}

test.describe("config-as-code CLI", () => {
  let page: Page;
  let request: APIRequestContext;
  let auth: AdminAuth;
  let shim: { url: string; close: () => Promise<void> };
  /** A home holding a credential for the gateway with a token it will reject. */
  let wrongTokenHome = "";
  /** A home with no credential file at all. */
  let noCredentialsHome = "";
  let loginRun: CliRun;

  let gatewayYaml = "";
  let serversYaml = "";
  let configYaml = "";

  async function bundleDescription(): Promise<string | null> {
    const res = await request.get(`${APP_BASE_URL}/admin-api/bundles/${BUNDLE}`, { headers: apiHeaders(auth) });
    expect(res.status()).toBe(200);
    return ((await res.json()) as { description: string | null }).description;
  }

  async function clientStatus(name: string): Promise<number> {
    const res = await request.get(`${APP_BASE_URL}/admin-api/clients/${name}`, { headers: apiHeaders(auth) });
    return res.status();
  }

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    request = page.context().request;
    await login(page);
    auth = await adminAuthHeaders(page);

    workDir = mkdtempSync(join(tmpdir(), "e2e-cli-work-"));
    cliHome = mkdtempSync(join(tmpdir(), "e2e-cli-home-"));
    wrongTokenHome = mkdtempSync(join(tmpdir(), "e2e-cli-badhome-"));
    noCredentialsHome = mkdtempSync(join(tmpdir(), "e2e-cli-nohome-"));
    gatewayYaml = join(workDir, "gateway.yaml");
    serversYaml = join(workDir, "servers.yaml");
    configYaml = join(workDir, "config-only.yaml");

    // THE INTERLOCK (header note 2): prove the child's home really is the
    // throwaway one before running anything that writes credentials there.
    const childHome = await probeChildHomedir(cliHome);
    expect(
      samePath(childHome, cliHome),
      `the CLI child resolved its home to ${childHome}, not the throwaway ${cliHome} — ` +
        `refusing to continue, since "gateway login" would overwrite the real ~/.mcpbridge/config.json`,
    ).toBe(true);

    shim = await startCredentialShim(auth);

    // Non-interactive login: every value is a flag, there is no prompt.
    loginRun = await runCli(["login", "--url", shim.url, "--token", SHIM_TOKEN]);

    // State the export must contain, created through the real admin API so
    // finding it in the CLI's output means something.
    await registerViaApi(request, auth, PULLED_CLIENT);
    const created = await request.post(`${APP_BASE_URL}/admin-api/bundles`, {
      headers: apiHeaders(auth),
      data: { name: BUNDLE, description: DESC_FROM_API, tools: [], composites: [] },
    });
    expect([201, 409], `bundle create failed: ${await created.text()}`).toContain(created.status());
    // A local re-run (reuseExistingServer) meets the previous run's bundle,
    // already carrying the description `apply` is supposed to write — so force
    // the known starting state rather than assuming a clean database.
    const reset = await request.patch(`${APP_BASE_URL}/admin-api/bundles/${BUNDLE}`, {
      headers: apiHeaders(auth),
      data: { description: DESC_FROM_API, enabled: true },
    });
    expect(reset.status(), `bundle reset failed: ${await reset.text()}`).toBe(200);
    // Likewise: the client `apply` must create has to be absent first.
    await deleteClient(request, auth, APPLIED_CLIENT);
  });

  test.afterAll(async () => {
    await request.delete(`${APP_BASE_URL}/admin-api/bundles/${BUNDLE}`, { headers: apiHeaders(auth) });
    await deleteClient(request, auth, APPLIED_CLIENT);
    await deleteClient(request, auth, PULLED_CLIENT);
    await shim.close();
    for (const dir of [workDir, cliHome, wrongTokenHome, noCredentialsHome]) {
      rmSync(dir, { recursive: true, force: true });
    }
    await page.close();
  });

  // ── Authentication ────────────────────────────────────────────────────────

  test("login is fully non-interactive and persists a reusable credential", () => {
    expect(loginRun.status, `login failed: ${loginRun.stderr}`).toBe(0);
    expect(loginRun.stdout).toContain(`Logged in to ${shim.url}`);
    // It never prompts: a TTY-less child would otherwise hang until the spawn
    // timeout instead of exiting 0 above.
    expect(loginRun.stderr).toBe("");

    // The credential file is the whole auth mechanism — there is no token env
    // var — so its location and shape are part of the CLI's contract.
    expect(existsSync(credentialsPath(cliHome)), "login wrote no credential file").toBe(true);
    const stored = JSON.parse(readFileSync(credentialsPath(cliHome), "utf-8")) as Record<string, unknown>;
    expect(stored).toEqual({ url: shim.url, token: SHIM_TOKEN });
  });

  // ── (1) pull ──────────────────────────────────────────────────────────────

  test("pull exports the live gateway's config, including state created through the admin API", async () => {
    const run = await runCli(["pull", "--file", gatewayYaml]);
    expect(run.status, `pull failed: ${run.stderr}`).toBe(0);
    expect(run.stdout).toContain(`Wrote ${gatewayYaml}`);

    const file = parseYaml(readFileSync(gatewayYaml, "utf-8")) as GatewayYaml;
    expect(file.version).toBe(1);
    // `servers:` is hand-authored, never derived from the live gateway — pull
    // preserves an existing one but must not invent one.
    expect(file.servers, "pull invented a servers: section").toBeUndefined();
    expect(file.config?.version).toBe(1);

    const bundle = file.config?.bundles.find((b) => b.name === BUNDLE);
    expect(bundle, `the bundle created via the admin API is missing from the export`).toBeDefined();
    expect(bundle?.description).toBe(DESC_FROM_API);

    // A second entity type, from a different table, so this proves a whole
    // export round-tripped rather than one section.
    const client = file.config?.clients.find((c) => c.name === PULLED_CLIENT);
    expect(client, "the client registered via the admin API is missing from the export").toBeDefined();
    // …and its discovered tools, so an export that kept the client row but
    // dropped its join partner still fails here.
    expect(client?.tools.length, "the export kept the client but lost its tools").toBeGreaterThan(0);
  });

  // ── (2) plan is a dry run ────────────────────────────────────────────────

  test("plan reports the change it would make, and makes none of it", async () => {
    writeFileSync(
      serversYaml,
      stringifyYaml({
        version: 1,
        servers: [
          {
            name: APPLIED_CLIENT,
            health_url: `${FIXTURE_BASE_URL}/health`,
            base_url: FIXTURE_BASE_URL,
            openapi_url: `${FIXTURE_BASE_URL}${FIXTURE_OPENAPI_PATH}`,
          },
        ],
      }),
      "utf-8",
    );

    const run = await runCli(["plan", "--file", serversYaml]);

    // Drift is a deliberate non-zero exit so CI can gate on it
    // (`gateway plan || echo "drift detected"` — see planCommand's docblock).
    expect(run.status, `plan exited ${run.status}: ${run.stderr}`).toBe(1);
    expect(run.stdout).toContain(`+ ${APPLIED_CLIENT} (would be registered)`);
    expect(run.stdout).not.toContain("Up to date.");

    // THE assertion: the live gateway is untouched. A plan that silently
    // applies would still print exactly the same line above.
    expect(await clientStatus(APPLIED_CLIENT), "plan registered the server it only promised to plan").toBe(404);
  });

  // ── (3) apply, and the idempotence that makes it usable ──────────────────

  test("apply performs the planned registration, and a second plan then reports no drift", async () => {
    const applied = await runCli(["apply", "--file", serversYaml]);
    expect(applied.status, `apply failed: ${applied.stderr}`).toBe(0);
    expect(applied.stdout).toContain(`+ ${APPLIED_CLIENT} (registered)`);

    const res = await request.get(`${APP_BASE_URL}/admin-api/clients/${APPLIED_CLIENT}`, {
      headers: apiHeaders(auth),
    });
    expect(res.status(), "apply reported a registration the admin API does not see").toBe(200);
    const detail = (await res.json()) as PulledClient;
    expect(detail.name).toBe(APPLIED_CLIENT);
    // A registration that discovered nothing would be a row, not a backend —
    // this went through the real OpenAPI discovery path against the fixture.
    expect(detail.tools.length, "the CLI registered the server but discovered no tools").toBeGreaterThan(0);

    // Idempotence: the same file, applied, must now be a no-op — and `plan`
    // must say so with exit 0, or every "does prod match the repo?" CI job
    // built on this CLI fails forever.
    const replanned = await runCli(["plan", "--file", serversYaml]);
    expect(replanned.status, `plan reported drift straight after apply: ${replanned.stdout}`).toBe(0);
    expect(replanned.stdout).toContain(`= ${APPLIED_CLIENT} (already registered)`);
    expect(replanned.stdout).toContain("Up to date.");
  });

  test("apply --dry-run reports the config change without writing it; apply writes it", async () => {
    // A hand-authored, minimal `config:` section (importConfig treats absent
    // sections as empty) rather than the full pulled export: replaying every
    // other spec's live config through the import endpoint would make this
    // test's result depend on what ran before it.
    writeFileSync(
      configYaml,
      stringifyYaml({
        version: 1,
        config: {
          version: 1,
          bundles: [{ name: BUNDLE, description: DESC_FROM_CLI, enabled: true, tools: [], composites: [] }],
        },
      }),
      "utf-8",
    );

    const dry = await runCli(["apply", "--file", configYaml, "--dry-run"]);
    expect(dry.status, `dry run failed: ${dry.stderr}`).toBe(0);
    // It must still REPORT the work — a dry run that reports nothing is
    // indistinguishable from one that parsed nothing.
    expect(dry.stdout).toContain('config: applied {"bundles":1');
    expect(await bundleDescription(), "apply --dry-run wrote to the gateway").toBe(DESC_FROM_API);

    const real = await runCli(["apply", "--file", configYaml]);
    expect(real.status, `apply failed: ${real.stderr}`).toBe(0);
    expect(real.stdout).toContain('config: applied {"bundles":1');
    expect(await bundleDescription(), "apply did not write the config change").toBe(DESC_FROM_CLI);
  });

  test("re-applying the gateway's own exported alert rules is clean, not a skip", async () => {
    // The pull/edit/apply loop's core promise: a document this gateway just
    // produced applies back to it without complaint. It used to fail — alert
    // rules were the only create-only section of importConfig, so an existing
    // rule came back as `skipped: "already exists"`, and `apply` treats ANY
    // skip as a failure. One alert rule anywhere on the gateway was therefore
    // enough to make `pull` followed by `apply` exit 1 with nothing wrong.
    const created = await request.post(`${APP_BASE_URL}/admin-api/alerts`, {
      headers: apiHeaders(auth),
      data: {
        name: ALERT_RULE,
        eventType: "usage_spike",
        // Points at the fixture rather than a real host: creation runs the same
        // SSRF validation as any other outbound URL, and nothing ever posts to
        // it here — the alert loop is not driven by this spec.
        webhookUrl: `${FIXTURE_BASE_URL}/__control/state`,
        threshold: 100,
      },
    });
    expect([201, 409], `alert create failed: ${created.status()} ${await created.text()}`).toContain(created.status());

    const pulled = await runCli(["pull", "--file", gatewayYaml]);
    expect(pulled.status, `pull failed: ${pulled.stderr}`).toBe(0);

    // Only the alertRules section is replayed. The rest of the export is every
    // other spec's live config, and replaying that would make this test's exit
    // code depend on what ran before it — the same reason the test above
    // hand-authors its `config:` block.
    const doc = parseYaml(readFileSync(gatewayYaml, "utf-8")) as GatewayYaml;
    const alertRules = doc.config?.alertRules ?? [];
    expect(
      alertRules.some((r) => r.name === ALERT_RULE),
      "the pulled export does not contain the rule that was just created",
    ).toBe(true);

    const alertsOnly = join(workDir, "alerts-only.yaml");
    writeFileSync(alertsOnly, stringifyYaml({ version: 1, config: { version: 1, alertRules } }), "utf-8");

    const applied = await runCli(["apply", "--file", alertsOnly]);
    expect(applied.status, `re-applying an exported alert rule was not clean: ${applied.stderr}`).toBe(0);
    expect(applied.stderr, "an existing alert rule was reported as skipped").not.toContain("skipped");
    expect(applied.stdout).toContain(`"alertRules":${alertRules.length}`);
  });

  // ── (4) failure exit codes ───────────────────────────────────────────────

  test("a malformed config file is reported on stderr and exits non-zero", async () => {
    const brokenYaml = join(workDir, "broken.yaml");
    // Parses as YAML, but is not a gateway file: no top-level `version`.
    writeFileSync(brokenYaml, "servers: []\n", "utf-8");

    const run = await runCli(["plan", "--file", brokenYaml]);
    expect(run.status, "a CLI that prints an error and exits 0 breaks every pipeline using it").toBe(1);
    expect(run.stderr).toContain('is not a valid gateway.yaml (missing top-level "version")');
    expect(run.stdout.trim(), "a rejected file still produced a plan").toBe("");
  });

  test("a credential the gateway rejects fails cleanly and exits non-zero", async () => {
    // Pointed straight at the gateway, NOT the shim: the 403 asserted here is
    // adminAuth's own verdict on a Bearer that is not in ADMIN_API_KEYS.
    writeCredentials(wrongTokenHome, { url: APP_BASE_URL, token: "e2e-cli-not-a-configured-admin-key" });
    const out = join(workDir, "never-written.yaml");

    const run = await runCli(["pull", "--file", out], wrongTokenHome);

    expect(run.status, `pull with a rejected token exited ${run.status}`).toBe(1);
    expect(run.stderr, "the gateway's rejection did not reach the operator").toContain("Invalid API key");
    // A readable message, not a stack dump: the top-level handler prints
    // errorMessage(err), which is the message alone.
    expect(run.stderr).not.toMatch(/\n\s+at .+:\d+/);
    expect(existsSync(out), "a rejected pull still wrote an output file").toBe(false);
  });

  test("no credentials at all fails with the login hint rather than a crash", async () => {
    const out = join(workDir, "also-never-written.yaml");

    const run = await runCli(["pull", "--file", out], noCredentialsHome);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Not logged in");
    // The message has to name the fix, since there is no env-var fallback.
    expect(run.stderr).toContain("gateway login");
    expect(existsSync(out)).toBe(false);
  });
});
