/**
 * mcpAuth integration with DB-managed MCP keys: minting a managed key locks
 * down the MCP surface even with no env MCP_API_KEYS set, and revoked/expired
 * keys are rejected. Env keys keep working unchanged.
 */
import { describe, test, expect, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { mcpAuth } from "../../middleware/auth.js";
import { createMcpKey, revokeMcpKey } from "../../security/mcp-key-store.js";

let baseUrl = "";
let activeServer: Server | null = null;
const originalMcpKeys = [...config.mcpApiKeys];
const originalAuthDisabled = config.authDisabled;

async function startApp(envKeys: string[] = []): Promise<void> {
  __resetDbForTesting();
  (config as Record<string, unknown>).authDisabled = false;
  (config as Record<string, unknown>).mcpApiKeys = envKeys;

  const app = express();
  app.get("/mcp-test", mcpAuth, (req, res) => {
    res.json({ ok: true, keyId: req.mcpKeyId ?? null });
  });

  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      activeServer = srv;
      resolve();
    });
    srv.on("error", reject);
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (activeServer) {
      activeServer.close(() => {
        activeServer = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

afterEach(async () => {
  await stopServer();
  (config as Record<string, unknown>).mcpApiKeys = originalMcpKeys;
  (config as Record<string, unknown>).authDisabled = originalAuthDisabled;
});

describe("mcpAuth + managed keys", () => {
  test("open mode when no env keys and no managed keys exist", async () => {
    await startApp([]);
    const res = await fetch(`${baseUrl}/mcp-test`);
    expect(res.status).toBe(200);
  });

  test("minting a managed key locks down the surface", async () => {
    await startApp([]);
    const { rawKey, record } = createMcpKey("bot", null, null, null);

    const noAuth = await fetch(`${baseUrl}/mcp-test`);
    expect(noAuth.status).toBe(401);

    const withKey = await fetch(`${baseUrl}/mcp-test`, { headers: { Authorization: `Bearer ${rawKey}` } });
    expect(withKey.status).toBe(200);
    const body = (await withKey.json()) as { keyId: number };
    expect(body.keyId).toBe(record.id);
  });

  test("a revoked managed key is rejected with 403", async () => {
    await startApp([]);
    const { rawKey, record } = createMcpKey("bot", null, null, null);
    revokeMcpKey(record.id);
    const res = await fetch(`${baseUrl}/mcp-test`, { headers: { Authorization: `Bearer ${rawKey}` } });
    expect(res.status).toBe(403);
  });

  test("a legacy env key still authenticates", async () => {
    await startApp(["env-secret"]);
    const res = await fetch(`${baseUrl}/mcp-test`, { headers: { Authorization: "Bearer env-secret" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keyId: number | null };
    expect(body.keyId).toBeNull();
  });

  test("an unknown token is rejected once any key material exists", async () => {
    await startApp(["env-secret"]);
    const res = await fetch(`${baseUrl}/mcp-test`, { headers: { Authorization: "Bearer wrong" } });
    expect(res.status).toBe(403);
  });
});
