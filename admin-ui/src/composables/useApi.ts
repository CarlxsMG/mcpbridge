import { readCsrfCookie } from "../utils/cookies";
import { i18n } from "../i18n";

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Light-weight wrappers around the global i18n singleton: composables that
// raise ApiError live outside Vue's setup() tree, so useI18n() is unreachable
// from them. These helpers share the same instance main.ts installs on the app.
function t(key: string): string {
  return (i18n.global.t as (k: string) => string)(key);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** True while the app is on the public login page — suppresses the auto-redirect-on-401 loop. */
function onLoginPage(): boolean {
  return window.location.pathname.replace(/\/+$/, "").endsWith("/login");
}

/**
 * Builds the URL to bounce an unauthenticated user to the login page, preserving
 * where they were headed as a `redirect` query param.
 *
 * `base` is the app's router base (e.g. Vite's `import.meta.env.BASE_URL`, which is
 * "/admin/" in the real product build and "/<repo>/demo/" in the public demo build —
 * see admin-ui/vite.config.ts). The post-login `router.push()` treats `redirect` as
 * base-relative (the router is mounted with `createWebHistory(base)`), so that prefix
 * must be stripped from `pathname` here or the post-login push doubles it up (e.g.
 * base "/admin/" + pathname "/admin/keys" -> "/admin/admin/keys" instead of "/admin/keys").
 *
 * `base` always ends in "/" (Vite's convention), but the pathname prefix to strip does
 * not (e.g. strip "/admin", not "/admin/"), so it's normalized before comparing.
 */
export function loginRedirectUrl(pathname: string, search: string, base: string): string {
  const prefix = base.replace(/\/$/, "");
  const strippedPath = prefix !== "" && pathname.startsWith(prefix) ? pathname.slice(prefix.length) || "/" : pathname;
  const redirect = encodeURIComponent(strippedPath + search);
  const baseWithSlash = base.endsWith("/") ? base : `${base}/`;
  return `${baseWithSlash}login?redirect=${redirect}`;
}

async function rawFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  if (!SAFE_METHODS.has(method)) {
    const csrf = readCsrfCookie();
    if (csrf) headers.set("X-CSRF-Token", csrf);
  }

  const res = await fetch(path, { ...init, method, headers, credentials: "include" });

  if (res.status === 401) {
    if (!onLoginPage()) {
      window.location.href = loginRedirectUrl(
        window.location.pathname,
        window.location.search,
        import.meta.env.BASE_URL,
      );
    }
    throw new ApiError(401, "UNAUTHORIZED", t("errors.not_authenticated"));
  }

  if (!res.ok) {
    let code = "UNKNOWN_ERROR";
    let message = t("errors.request_failed_with_status").replace("{status}", String(res.status));
    try {
      const body = (await res.clone().json()) as { error?: { code?: string; message?: string } };
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
    } catch {
      // Non-JSON error body — keep the defaults above.
    }
    throw new ApiError(res.status, code, message);
  }

  return res;
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Public demo build: serve everything from the in-browser mock. The dynamic
  // import sits in a statically-false branch in the real product build, so the
  // demo code (and its fixtures) is tree-shaken out entirely.
  if (import.meta.env.VITE_DEMO === "true") {
    const { demoFetch } = await import("../demo/demo");
    return demoFetch<T>(path, init);
  }
  const res = await rawFetch(path, init);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Like apiFetch, but returns the raw response body as text (e.g. a YAML export) instead of parsing JSON. */
export async function apiFetchRaw(path: string, init: RequestInit = {}): Promise<string> {
  if (import.meta.env.VITE_DEMO === "true") {
    const { demoFetch } = await import("../demo/demo");
    const data = await demoFetch<unknown>(path, init);
    return JSON.stringify(data, null, 2);
  }
  const res = await rawFetch(path, init);
  return res.text();
}

export const api = {
  get: <T>(path: string): Promise<T> => apiFetch<T>(path),
  getRaw: (path: string): Promise<string> => apiFetchRaw(path),
  post: <T>(path: string, body?: unknown): Promise<T> =>
    apiFetch<T>(path, { method: "POST", body: body !== undefined ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown): Promise<T> =>
    apiFetch<T>(path, { method: "PATCH", body: body !== undefined ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown): Promise<T> =>
    apiFetch<T>(path, { method: "PUT", body: body !== undefined ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string): Promise<T> => apiFetch<T>(path, { method: "DELETE" }),
};
