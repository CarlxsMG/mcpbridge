import { readCsrfCookie } from "./useCsrf";

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** True while the app is on the public login page — suppresses the auto-redirect-on-401 loop. */
function onLoginPage(): boolean {
  return window.location.pathname.replace(/\/+$/, "").endsWith("/login");
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Public demo build: serve everything from the in-browser mock. The dynamic
  // import sits in a statically-false branch in the real product build, so the
  // demo code (and its fixtures) is tree-shaken out entirely.
  if (import.meta.env.VITE_DEMO === "true") {
    const { demoFetch } = await import("./demo");
    return demoFetch<T>(path, init);
  }

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
      // router.push() on the login page treats `redirect` as base-relative (the
      // router is mounted with createWebHistory("/admin/")), so the "/admin"
      // prefix must be stripped here or the post-login push doubles it up
      // (e.g. /admin/keys -> /admin/admin/keys).
      const pathname = window.location.pathname.startsWith("/admin")
        ? window.location.pathname.slice("/admin".length) || "/"
        : window.location.pathname;
      const redirect = encodeURIComponent(pathname + window.location.search);
      window.location.href = `/admin/login?redirect=${redirect}`;
    }
    throw new ApiError(401, "UNAUTHORIZED", "Not authenticated");
  }

  if (!res.ok) {
    let code = "UNKNOWN_ERROR";
    let message = `Request failed with status ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
    } catch {
      // Non-JSON error body — keep the defaults above.
    }
    throw new ApiError(res.status, code, message);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string): Promise<T> => apiFetch<T>(path),
  post: <T>(path: string, body?: unknown): Promise<T> =>
    apiFetch<T>(path, { method: "POST", body: body !== undefined ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown): Promise<T> =>
    apiFetch<T>(path, { method: "PATCH", body: body !== undefined ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown): Promise<T> =>
    apiFetch<T>(path, { method: "PUT", body: body !== undefined ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string): Promise<T> => apiFetch<T>(path, { method: "DELETE" }),
};
