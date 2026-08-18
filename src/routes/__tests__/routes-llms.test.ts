/**
 * GET /llms.txt — the public, unauthenticated self-description endpoint.
 *
 * The load-bearing case here is the information-disclosure one: the document
 * must describe the SHAPE of the API and never this deployment's contents. So
 * the registry and the bundle table are seeded with deliberately distinctive
 * names before the fetch, and the body is asserted not to contain any of them.
 * That case was proven to discriminate by temporarily rendering
 * `registry.listAllTools()` into the document — it went red on every seeded
 * name — before the render was restored.
 *
 * The advertised-scheme group at the bottom was proven the same way: replacing
 * `req.protocol` with a direct `req.get("x-forwarded-proto")` read failed the
 * untrusted-header case AND the nonsensical-scheme case (the latter rendered a
 * literal `null/mcp`), and both went green again on restore.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import http from "node:http";
import type { Server } from "node:http";
import { listen, closeServer } from "../../__tests__/_utils/app.js";
import { clearRegistry, makeTool, registerTestClient } from "../../__tests__/_utils/registry.js";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { initBundles, createBundle } from "../../admin/tool-composition/bundles.js";
import { _internalsForTesting } from "../../middleware/rate-limiter.js";
import { llmsRoutes } from "../llms.js";

// Distinctive enough that a substring match can't collide with the boilerplate
// prose, the base URL, or the documentation links in the rendered document.
const SECRET_CLIENT = "zzsecretclient";
const SECRET_TOOL = "zzsecrettool";
const SECRET_BUNDLE = "zzsecretbundle";

const originalGatewayPublicUrl = config.gatewayPublicUrl;
const originalRateLimitExpensive = config.rateLimitExpensive;

/**
 * `trustProxy` mirrors the ONE line createApp() uses to wire TRUST_PROXY into
 * Express (`app.set("trust proxy", config.trustProxy)`). The forwarded-scheme
 * cases below are only meaningful against that real wiring: `req.protocol`
 * consults `X-Forwarded-Proto` exclusively through it.
 */
function startApp(trustProxy: boolean | number | string = false): Promise<{ baseUrl: string; server: Server }> {
  const app = express();
  app.set("trust proxy", trustProxy);
  llmsRoutes(app);
  return listen(app);
}

/** GET /llms.txt over raw node:http so the test can set an arbitrary Host or
 * forwarded header — `fetch` derives Host from the URL and refuses to override it. */
function getWithHeaders(baseUrl: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: hostname, port, path: "/llms.txt", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function getWithHost(baseUrl: string, host: string): Promise<{ status: number; body: string }> {
  return getWithHeaders(baseUrl, { Host: host });
}

beforeEach(() => {
  // Every test in this file shares the process-wide "expensive" bucket map, and
  // the tier's ceiling is low enough that a few tests would otherwise 429 each
  // other. Pin both the counters and the limit rather than inheriting whatever
  // an earlier file left behind.
  _internalsForTesting.expensiveBuckets.clear();
  (config as Record<string, unknown>).gatewayPublicUrl = undefined;
  (config as Record<string, unknown>).rateLimitExpensive = originalRateLimitExpensive;
});

afterEach(() => {
  (config as Record<string, unknown>).gatewayPublicUrl = originalGatewayPublicUrl;
  (config as Record<string, unknown>).rateLimitExpensive = originalRateLimitExpensive;
});

describe("GET /llms.txt — response envelope", () => {
  test("serves 200 as text/plain without any credential", async () => {
    const { baseUrl, server } = await startApp();
    try {
      const res = await fetch(`${baseUrl}/llms.txt`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect((await res.text()).length).toBeGreaterThan(0);
    } finally {
      await closeServer(server);
    }
  });

  test("describes every endpoint shape, the auth scheme and where the docs live", async () => {
    const { baseUrl, server } = await startApp();
    try {
      const body = await (await fetch(`${baseUrl}/llms.txt`)).text();
      // The three MCP planes, each as a shape rather than an instance.
      expect(body).toContain("/mcp`");
      expect(body).toContain("/mcp/<clientName>");
      expect(body).toContain("/mcp-custom/<bundleName>");
      expect(body).toContain("sys_*");
      // How to authenticate, and that keys come from an administrator.
      expect(body).toContain("Authorization: Bearer <mcp-api-key>");
      expect(body).toContain("minted by a gateway administrator");
      // How to connect a client.
      expect(body).toContain("streamable-http");
      expect(body).toContain("tools/list");
      // Where the full docs live.
      expect(body).toContain("https://carlxsmg.github.io/mcpbridge/");
    } finally {
      await closeServer(server);
    }
  });
});

describe("GET /llms.txt — base URL resolution", () => {
  test("advertises the configured gatewayPublicUrl when set", async () => {
    const { baseUrl, server } = await startApp();
    try {
      (config as Record<string, unknown>).gatewayPublicUrl = "https://gw.configured.example";
      const body = await (await fetch(`${baseUrl}/llms.txt`)).text();
      expect(body).toContain("https://gw.configured.example/mcp");
      expect(body).not.toContain(new URL(baseUrl).host);
    } finally {
      await closeServer(server);
    }
  });

  test("falls back to the request's own protocol and host", async () => {
    const { baseUrl, server } = await startApp();
    try {
      const body = await (await fetch(`${baseUrl}/llms.txt`)).text();
      expect(body).toContain(`http://${new URL(baseUrl).host}/mcp`);
    } finally {
      await closeServer(server);
    }
  });

  test("reduces a caller-supplied Host to a bare origin", async () => {
    const { baseUrl, server } = await startApp();
    try {
      const { body } = await getWithHost(baseUrl, "proxy.example:8443");
      expect(body).toContain("http://proxy.example:8443/mcp");
    } finally {
      await closeServer(server);
    }
  });

  test("drops a Host the URL parser rejects instead of echoing it", async () => {
    const { baseUrl, server } = await startApp();
    try {
      const { status, body } = await getWithHost(baseUrl, "[unclosed.bracket");
      expect(status).toBe(200);
      expect(body).not.toContain("unclosed.bracket");
      expect(body).toContain("http://localhost/mcp");
    } finally {
      await closeServer(server);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The advertised scheme. This document's whole audience is a machine that will
// use the URL verbatim, so getting `http` where the deployment is `https` sends
// every agent to an address that does not answer. The fix must not go the other
// way either: an anonymous caller must never be able to pick the scheme a
// public document hands the next reader.
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /llms.txt — advertised scheme behind a reverse proxy", () => {
  test("advertises https when the proxy is trusted and forwards it", async () => {
    const { baseUrl, server } = await startApp(true);
    try {
      const { body } = await getWithHeaders(baseUrl, {
        Host: "gw.example.com",
        "X-Forwarded-Proto": "https",
      });
      expect(body).toContain("https://gw.example.com/mcp");
      expect(body).not.toContain("http://gw.example.com");
    } finally {
      await closeServer(server);
    }
  });

  // The discriminating case: reading `x-forwarded-proto` directly instead of
  // going through Express's trust-proxy-aware `req.protocol` passes the test
  // above and fails this one.
  test("an untrusted X-Forwarded-Proto cannot control the advertised scheme", async () => {
    const { baseUrl, server } = await startApp(false);
    try {
      const { body } = await getWithHeaders(baseUrl, {
        Host: "gw.example.com",
        "X-Forwarded-Proto": "https",
      });
      expect(body).toContain("http://gw.example.com/mcp");
      expect(body).not.toContain("https://gw.example.com");
    } finally {
      await closeServer(server);
    }
  });

  // A trusted proxy is trusted input, not validated input. `new URL()` accepts
  // a non-special scheme and reports its `.origin` as the string "null", which
  // would put a literal `null/mcp` in front of every advertised endpoint.
  test("clamps a trusted but nonsensical forwarded scheme to http", async () => {
    const { baseUrl, server } = await startApp(true);
    try {
      const { status, body } = await getWithHeaders(baseUrl, {
        Host: "gw.example.com",
        "X-Forwarded-Proto": "javascript",
      });
      expect(status).toBe(200);
      expect(body).toContain("http://gw.example.com/mcp");
      expect(body).not.toContain("javascript");
      expect(body).not.toContain("null/mcp");
    } finally {
      await closeServer(server);
    }
  });

  test("tells the reader the base URL is a hint and names GATEWAY_PUBLIC_URL", async () => {
    const { baseUrl, server } = await startApp();
    try {
      const body = await (await fetch(`${baseUrl}/llms.txt`)).text();
      // Load-bearing copy, not decoration: without it an agent handed an
      // `http://` URL from an HTTPS deployment has nothing telling it to
      // distrust the value, and the operator has nothing naming the fix.
      expect(body).toContain("GATEWAY_PUBLIC_URL");
      expect(body).toContain("Treat it as a hint");
    } finally {
      await closeServer(server);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The reason this endpoint needed a security review at all. An anonymous
// caller learning which backends are registered here is an information
// disclosure, so the seeded names below must not appear anywhere in the body.
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /llms.txt — reveals nothing instance-specific", () => {
  test("names no registered client, tool or bundle even with a populated registry", async () => {
    __resetDbForTesting();
    initBundles();
    await registerTestClient(SECRET_CLIENT, [makeTool({ name: SECRET_TOOL })]);
    const created = await createBundle(
      SECRET_BUNDLE,
      "seeded for the disclosure check",
      [{ client: SECRET_CLIENT, tool: SECRET_TOOL }],
      "test",
    );
    expect(created.ok).toBe(true);

    const { baseUrl, server } = await startApp();
    try {
      const body = await (await fetch(`${baseUrl}/llms.txt`)).text();
      expect(body).not.toContain(SECRET_CLIENT);
      expect(body).not.toContain(SECRET_TOOL);
      expect(body).not.toContain(SECRET_BUNDLE);
      // Not just the names: the document must not report how many of anything
      // exists either, so it stays byte-identical whatever the registry holds.
      expect(body).toBe(await (await fetch(`${baseUrl}/llms.txt`)).text());
    } finally {
      await closeServer(server);
      await clearRegistry();
    }
  });
});

describe("GET /llms.txt — rate limiting", () => {
  test("429s once the per-IP budget for this route is spent", async () => {
    // The limit is read when the route is registered, so it has to be pinned
    // before startApp() rather than before the requests.
    (config as Record<string, unknown>).rateLimitExpensive = 2;
    const { baseUrl, server } = await startApp();
    try {
      expect((await fetch(`${baseUrl}/llms.txt`)).status).toBe(200);
      expect((await fetch(`${baseUrl}/llms.txt`)).status).toBe(200);
      const limited = await fetch(`${baseUrl}/llms.txt`);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBeTruthy();
      const body = (await limited.json()) as { error: { code: string } };
      expect(body.error.code).toBe("RATE_LIMITED");
    } finally {
      await closeServer(server);
    }
  });

  test("uses its own bucket rather than the install-link tier's", async () => {
    (config as Record<string, unknown>).rateLimitExpensive = 1;
    const { baseUrl, server } = await startApp();
    try {
      await fetch(`${baseUrl}/llms.txt`);
      // Spending this route's budget must leave the public install-link
      // budget untouched — sharing that bucket would let a crawler pulling
      // this document lock a teammate out of /install/:token.
      expect(_internalsForTesting.installLinkBuckets.size).toBe(0);
      expect(_internalsForTesting.expensiveBuckets.size).toBeGreaterThan(0);
    } finally {
      await closeServer(server);
    }
  });
});
