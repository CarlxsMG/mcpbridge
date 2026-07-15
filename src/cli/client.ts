import { homedir } from "os";
import { join } from "path";
import { mkdir, readFile, writeFile } from "fs/promises";

interface CliCredentials {
  url: string;
  token: string;
}

const CONFIG_DIR = join(homedir(), ".mcpbridge");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

/** Persists the gateway URL + bearer token used by every other command. Equivalent to an admin password, so 0600. */
export async function saveCliCredentials(creds: CliCredentials): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export async function loadCliCredentials(): Promise<CliCredentials> {
  let raw: string;
  try {
    raw = await readFile(CONFIG_PATH, "utf-8");
  } catch {
    throw new Error(`Not logged in — run "gateway login --url <gateway-url> --token <admin-api-key>" first.`);
  }
  const parsed = JSON.parse(raw) as Partial<CliCredentials>;
  if (typeof parsed.url !== "string" || typeof parsed.token !== "string") {
    throw new Error(`Corrupt credentials at ${CONFIG_PATH} — re-run "gateway login".`);
  }
  return { url: parsed.url, token: parsed.token };
}

export class CliApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface CliClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

/**
 * Thin bearer-authenticated HTTP client against the admin API. Bearer-only —
 * these calls hit adminAuth's env-key branch, which needs no CSRF token or
 * cookie session.
 */
export async function makeClient(): Promise<CliClient> {
  const { url, token } = await loadCliCredentials();
  const base = url.replace(/\/+$/, "");

  async function doFetch(path: string, init: RequestInit = {}): Promise<unknown> {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    const text = await res.text();
    let body: unknown;
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        // Not every non-2xx (or misconfigured --url) response is JSON — a
        // wrong port, reverse proxy, or load balancer can return an HTML/plain
        // error page. Surface it as a normal CliApiError instead of letting a
        // bare JSON.parse SyntaxError escape to the top-level catch.
        throw new CliApiError(res.status, text.slice(0, 200) || `HTTP ${res.status}`);
      }
    }
    if (!res.ok) {
      const message = (body as { error?: { message?: string } } | undefined)?.error?.message ?? `HTTP ${res.status}`;
      throw new CliApiError(res.status, message);
    }
    return body;
  }

  return {
    get: <T>(path: string) => doFetch(path) as Promise<T>,
    post: <T>(path: string, body: unknown) =>
      doFetch(path, { method: "POST", body: JSON.stringify(body) }) as Promise<T>,
  };
}

/** Whether a client name is already registered — used to keep `apply`/`plan` idempotent. Any non-404 error propagates rather than being treated as "absent". */
export async function clientExists(client: CliClient, name: string): Promise<boolean> {
  try {
    await client.get(`/admin-api/clients/${encodeURIComponent(name)}`);
    return true;
  } catch (err) {
    if (err instanceof CliApiError && err.status === 404) return false;
    throw err;
  }
}
