import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { corsMiddleware } from "../middleware/cors.js";
import { config } from "../config.js";

import { withConfig } from "./_utils/with-config.js";
// ---------------------------------------------------------------------------
// Direct coverage for src/middleware/cors.ts (previously only exercised
// indirectly through routes mounted behind it in index.ts).
//
// Note on wildcard "gating": corsMiddleware itself does NOT gate the
// wildcard — it simply trusts `config.corsOrigins`. The ALLOW_UNSAFE_CORS_
// WILDCARD escape-hatch check lives in `parseCorsOrigins()` (config.ts),
// which runs once at config-load time and *throws* if '*' is requested
// without the escape hatch (or without AUTH_DISABLED). That throw-on-
// ungated-wildcard behavior is covered directly in config-parsers.test.ts.
// Here we cover what corsMiddleware does once `config.corsOrigins` already
// contains `["*"]` (i.e. gating already passed): it reflects the request
// origin and never sends credentials, per the docstring.
// ---------------------------------------------------------------------------

function buildApp() {
  const app = express();
  app.use(corsMiddleware);
  app.get("/test", (_req, res) => res.status(200).json({ ok: true }));
  app.post("/test", (_req, res) => res.status(200).json({ ok: true }));
  return app;
}

let baseUrl: string;
let server: Server;

beforeAll(async () => {
  const app = buildApp();
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// Save/restore the mutable config singleton around every test so nothing leaks.
const originalCorsOrigins = config.corsOrigins;
const originalAllowCredentials = config.corsAllowCredentials;

beforeEach(() => {
  (config as Record<string, unknown>).corsOrigins = ["https://allowed.example.com"];
  (config as Record<string, unknown>).corsAllowCredentials = false;
});

afterEach(() => {
  (config as Record<string, unknown>).corsOrigins = originalCorsOrigins;
  (config as Record<string, unknown>).corsAllowCredentials = originalAllowCredentials;
});

// ---------------------------------------------------------------------------
// Allowed origin
// ---------------------------------------------------------------------------

describe("corsMiddleware — allowed origin", () => {
  test("GET with an allowed Origin gets the exact origin echoed back + CORS headers", async () => {
    const res = await fetch(`${baseUrl}/test`, {
      headers: { Origin: "https://allowed.example.com" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://allowed.example.com");
    expect(res.headers.get("vary")).toBe("Origin");
    expect(res.headers.get("access-control-allow-methods")).toBe(config.corsAllowedMethods.join(", "));
    expect(res.headers.get("access-control-allow-headers")).toBe(config.corsAllowedHeaders.join(", "));
    expect(res.headers.get("access-control-expose-headers")).toBe(config.corsExposedHeaders.join(", "));
    expect(res.headers.get("access-control-max-age")).toBe(String(config.corsMaxAgeSeconds));
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  test("host comparison is case-insensitive: Origin with uppercase host still matches", async () => {
    const res = await fetch(`${baseUrl}/test`, {
      headers: { Origin: "https://ALLOWED.example.com" },
    });
    expect(res.status).toBe(200);
    // Reflects the canonical (lowercased) form, not the raw casing sent.
    expect(res.headers.get("access-control-allow-origin")).toBe("https://allowed.example.com");
  });

  test("a non-default port must match exactly to be allowed", async () => {
    await withConfig({ corsOrigins: ["https://allowed.example.com:8443"] }, async () => {
      const matching = await fetch(`${baseUrl}/test`, {
        headers: { Origin: "https://allowed.example.com:8443" },
      });
      expect(matching.headers.get("access-control-allow-origin")).toBe("https://allowed.example.com:8443");

      const mismatched = await fetch(`${baseUrl}/test`, {
        headers: { Origin: "https://allowed.example.com" },
      });
      expect(mismatched.headers.get("access-control-allow-origin")).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Disallowed origin
// ---------------------------------------------------------------------------

describe("corsMiddleware — disallowed origin", () => {
  test("GET with a disallowed Origin gets no CORS headers but the request still completes", async () => {
    const res = await fetch(`${baseUrl}/test`, {
      headers: { Origin: "https://evil.example.com" },
    });
    // The middleware does not block the response server-side — the browser
    // is the one that will refuse to expose it to the page without the header.
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  test("a malformed Origin header is treated as disallowed, not a crash", async () => {
    const res = await fetch(`${baseUrl}/test`, {
      headers: { Origin: "not-a-valid-origin" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("empty allowlist rejects every origin", async () => {
    await withConfig({ corsOrigins: [] }, async () => {
      const res = await fetch(`${baseUrl}/test`, {
        headers: { Origin: "https://allowed.example.com" },
      });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Preflight (OPTIONS)
// ---------------------------------------------------------------------------

describe("corsMiddleware — preflight (OPTIONS)", () => {
  test("preflight from an allowed origin short-circuits with 204 + CORS headers", async () => {
    const res = await fetch(`${baseUrl}/test`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://allowed.example.com",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://allowed.example.com");
  });

  test("preflight from a disallowed origin is rejected with 403 and no CORS headers", async () => {
    const res = await fetch(`${baseUrl}/test`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example.com",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("preflight with no Origin header at all returns 204 (same-origin/non-browser)", async () => {
    const res = await fetch(`${baseUrl}/test`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// No Origin header (same-origin / non-browser client)
// ---------------------------------------------------------------------------

describe("corsMiddleware — no Origin header", () => {
  test("GET with no Origin header passes through untouched with no CORS headers", async () => {
    const res = await fetch(`${baseUrl}/test`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("vary")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Credentials behavior
// ---------------------------------------------------------------------------

describe("corsMiddleware — credentials", () => {
  test("credentials header is sent only when corsAllowCredentials=true AND origin is allowed", async () => {
    await withConfig({ corsAllowCredentials: true }, async () => {
      const allowed = await fetch(`${baseUrl}/test`, {
        headers: { Origin: "https://allowed.example.com" },
      });
      expect(allowed.headers.get("access-control-allow-credentials")).toBe("true");

      const disallowed = await fetch(`${baseUrl}/test`, {
        headers: { Origin: "https://evil.example.com" },
      });
      expect(disallowed.headers.get("access-control-allow-credentials")).toBeNull();
    });
  });

  test("credentials header is omitted when corsAllowCredentials=false even for an allowed origin", async () => {
    await withConfig({ corsAllowCredentials: false }, async () => {
      const res = await fetch(`${baseUrl}/test`, {
        headers: { Origin: "https://allowed.example.com" },
      });
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Wildcard mode
// ---------------------------------------------------------------------------

describe("corsMiddleware — wildcard mode", () => {
  test("wildcard mode reflects the request origin verbatim (not '*') for any origin", async () => {
    await withConfig({ corsOrigins: ["*"] }, async () => {
      const res = await fetch(`${baseUrl}/test`, {
        headers: { Origin: "https://anything.example.net" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("https://anything.example.net");
      expect(res.headers.get("vary")).toBe("Origin");
    });
  });

  test("wildcard mode never sends credentials, even when corsAllowCredentials=true", async () => {
    await withConfig({ corsOrigins: ["*"], corsAllowCredentials: true }, async () => {
      const res = await fetch(`${baseUrl}/test`, {
        headers: { Origin: "https://anything.example.net" },
      });
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    });
  });

  test("wildcard mode preflight also short-circuits with 204", async () => {
    await withConfig({ corsOrigins: ["*"] }, async () => {
      const res = await fetch(`${baseUrl}/test`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://anything.example.net",
          "Access-Control-Request-Method": "POST",
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("https://anything.example.net");
    });
  });
});
