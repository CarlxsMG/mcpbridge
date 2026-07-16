/**
 * Regression test for the bundle install-link privilege-escalation bug
 * (Finding #3, P1): editing a bundle down to zero tools used to re-scope every
 * still-active install-link's underlying MCP key to `toolScopesFor([])`, which
 * mcp-key-store.normalizeScopes() collapses to `null` (== UNRESTRICTED). That
 * silently widened a bundle-scoped credential — often handed to a non-admin
 * teammate — to gateway-wide tool access across all clients/teams.
 *
 * The fix fails closed: an empty tool set now revokes the affected install
 * links (and their keys) instead, mirroring createInstallLink()'s EMPTY_BUNDLE
 * refusal. This exercises the real path via bundles.updateBundle(), which is
 * what calls reScopeInstallLinksForBundle.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { __resetDbForTesting } from "../../../db/connection.js";
import { registry } from "../../../mcp/registry.js";
import { initBundles, createBundle, updateBundle } from "../bundles.js";
import { createInstallLink, listInstallLinks } from "../bundle-install-links.js";
import { getMcpKey, isToolInKeyScope } from "../../../security/mcp-key-store.js";
import { config } from "../../../config.js";
import type { RestToolDefinition } from "../../../mcp/types.js";

const ORIGINAL_SECRET_KEY = config.secretEncryptionKey;

function makeTool(overrides: Partial<RestToolDefinition> = {}): RestToolDefinition {
  return {
    name: "empty-scope-tool",
    method: "GET",
    endpoint: "/things",
    description: "a real description",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

beforeEach(async () => {
  for (const client of registry.listClients()) {
    await registry.unregister(client.name);
  }
  __resetDbForTesting();
  initBundles();
  (config as Record<string, unknown>).secretEncryptionKey = Buffer.alloc(32, 7).toString("base64");
});

afterAll(() => {
  (config as Record<string, unknown>).secretEncryptionKey = ORIGINAL_SECRET_KEY;
});

describe("reScopeInstallLinksForBundle — empty tool set fails closed", () => {
  test("editing a bundle to zero tools revokes live install links instead of widening their key to unrestricted", async () => {
    const clientName = "empty-scope-client";
    await registry.register(
      clientName,
      [makeTool()],
      "http://example.com/health",
      "1.2.3.4",
      "http://example.com",
      "1.2.3.4",
    );
    const bundleName = "empty-scope-bundle";
    const created = await createBundle(
      bundleName,
      undefined,
      [{ client: clientName, tool: "empty-scope-tool" }],
      "actor",
    );
    expect(created.ok).toBe(true);

    const link = await createInstallLink(bundleName, null, "actor");
    expect(link.ok).toBe(true);
    if (!link.ok) return;

    // Sanity: the freshly-minted key is scoped to exactly the bundle's tool.
    const before = getMcpKey(link.record.mcpKeyId);
    expect(before!.scopes).toEqual({ tools: [`${clientName}__empty-scope-tool`] });

    // Edit the bundle down to zero tools — the escalation trigger.
    const updated = await updateBundle(bundleName, { tools: [] });
    expect(updated.ok).toBe(true);

    const key = getMcpKey(link.record.mcpKeyId);
    expect(key).not.toBeNull();

    // The key must NOT have widened to unrestricted (null) scope.
    expect(key!.scopes).not.toBeNull();

    // And it must be fail-closed for any tool: the link (and its key) is revoked.
    expect(key!.revokedAt).not.toBeNull();
    expect(key!.enabled).toBe(false);
    expect(listInstallLinks(bundleName)[0]!.revokedAt).not.toBeNull();

    // Belt-and-suspenders: an unrelated client/tool is not callable through
    // this credential — never gateway-wide access.
    expect(isToolInKeyScope(key!.scopes, "some-other-client", "some-other-client__some-tool")).toBe(false);
  });

  test("editing a bundle to a smaller NON-empty tool set still narrows (not revokes) the key", async () => {
    const clientName = "narrow-scope-client";
    await registry.register(
      clientName,
      [makeTool({ name: "tool-a" }), makeTool({ name: "tool-b" })],
      "http://example.com/health",
      "1.2.3.4",
      "http://example.com",
      "1.2.3.4",
    );
    const bundleName = "narrow-scope-bundle";
    await createBundle(
      bundleName,
      undefined,
      [
        { client: clientName, tool: "tool-a" },
        { client: clientName, tool: "tool-b" },
      ],
      "actor",
    );

    const link = await createInstallLink(bundleName, null, "actor");
    expect(link.ok).toBe(true);
    if (!link.ok) return;

    const updated = await updateBundle(bundleName, { tools: [{ client: clientName, tool: "tool-a" }] });
    expect(updated.ok).toBe(true);

    const key = getMcpKey(link.record.mcpKeyId);
    expect(key!.revokedAt).toBeNull();
    expect(key!.scopes).toEqual({ tools: [`${clientName}__tool-a`] });
    expect(isToolInKeyScope(key!.scopes, clientName, `${clientName}__tool-b`)).toBe(false);
    expect(isToolInKeyScope(key!.scopes, clientName, `${clientName}__tool-a`)).toBe(true);
  });
});
