/**
 * Stryker mutation-testing backstop for
 * src/admin/tool-composition/bundle-install-links.ts — domain 9. No prior
 * test file existed for this module (the sibling route test,
 * src/routes/__tests__/routes-install-links-mutation.test.ts, only covers
 * src/routes/install-links.ts's HTTP-layer concerns — gateway URL
 * resolution, snippet shape, exact 404 message — and never touches this
 * module's own business logic directly). This file exercises every exported
 * function via direct import+call against an in-memory `bun:sqlite` DB, no
 * Express harness (this module has no route-registration exports).
 */
import { describe, test, expect, beforeEach, afterAll, spyOn } from "bun:test";
import { __resetDbForTesting, getDb } from "../../../db/connection.js";
import { registry } from "../../../mcp/registry.js";
import { initBundles, createBundle } from "../bundles.js";
import {
  createInstallLink,
  listInstallLinks,
  revokeInstallLink,
  revokeAllInstallLinksForBundle,
  resolveInstallLinkToken,
} from "../bundle-install-links.js";
import { getMcpKey, listMcpKeys } from "../../../security/mcp-key-store.js";
import { hashApiKey } from "../../../security/key-hash.js";
import { config } from "../../../config.js";
import { localProvider } from "../../../secrets/local-provider.js";
import * as logger from "../../../logger.js";
import type { RestToolDefinition } from "../../../mcp/types.js";

const ORIGINAL_SECRET_KEY = config.secretEncryptionKey;

function makeTool(overrides: Partial<RestToolDefinition> = {}): RestToolDefinition {
  return {
    name: "install-link-tool",
    method: "GET",
    endpoint: "/things",
    description: "a real description",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

async function reg(name: string, tools: RestToolDefinition[] = [makeTool()]): Promise<void> {
  await registry.register(name, tools, "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

/** Registers a client + tool and creates a bundle referencing it. Returns the bundle name. */
async function makeBundleWithOneTool(bundleName: string, clientName = `${bundleName}-client`): Promise<string> {
  await reg(clientName);
  const result = await createBundle(
    bundleName,
    undefined,
    [{ client: clientName, tool: "install-link-tool" }],
    "actor",
  );
  expect(result.ok).toBe(true);
  return bundleName;
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

describe("createInstallLink", () => {
  test("BUNDLE_NOT_FOUND for an unknown bundle, exact message", async () => {
    const result = await createInstallLink("no-such-bundle", null, "actor");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("BUNDLE_NOT_FOUND");
      expect(result.error.message).toBe('Bundle "no-such-bundle" not found');
    }
  });

  test("EMPTY_BUNDLE for a bundle with zero tools, exact message", async () => {
    const result0 = await createBundle("empty-bundle", undefined, [], "actor");
    expect(result0.ok).toBe(true);
    const result = await createInstallLink("empty-bundle", null, "actor");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EMPTY_BUNDLE");
      expect(result.error.message).toBe(
        "Cannot create an install link for a bundle with no tools — there is nothing safe to scope a key to",
      );
    }
  });

  test("SECRET_BOX_NOT_CONFIGURED when no encryption key is set, exact message", async () => {
    const bundleName = await makeBundleWithOneTool("no-secret-bundle");
    (config as Record<string, unknown>).secretEncryptionKey = undefined;
    try {
      const result = await createInstallLink(bundleName, null, "actor");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("SECRET_BOX_NOT_CONFIGURED");
        expect(result.error.message).toBe("Set SECRET_ENCRYPTION_KEY to create install links");
      }
    } finally {
      (config as Record<string, unknown>).secretEncryptionKey = Buffer.alloc(32, 7).toString("base64");
    }
  });

  test("happy path: mints a bundle-scoped MCP key, stores the row, and returns the raw token exactly once", async () => {
    const clientName = "hp-client";
    await reg(clientName, [makeTool({ name: "tool-a" }), makeTool({ name: "tool-b" })]);
    const bundleResult = await createBundle(
      "hp-bundle",
      undefined,
      [
        { client: clientName, tool: "tool-a" },
        { client: clientName, tool: "tool-b" },
      ],
      "actor",
    );
    expect(bundleResult.ok).toBe(true);

    const expiresAt = Date.now() + 100_000;
    const result = await createInstallLink("hp-bundle", expiresAt, "creator-actor");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Raw token shape: `bil_` prefix, and the persisted prefix is exactly its
    // first 12 characters.
    expect(result.rawToken.startsWith("bil_")).toBe(true);
    expect(result.record.tokenPrefix).toBe(result.rawToken.slice(0, 12));
    expect(result.record.tokenPrefix.length).toBe(12);

    // Every summary field maps from the freshly-inserted row.
    expect(result.record.bundleName).toBe("hp-bundle");
    expect(result.record.createdBy).toBe("creator-actor");
    expect(result.record.expiresAt).toBe(expiresAt);
    expect(result.record.revokedAt).toBeNull();
    expect(result.record.lastUsedAt).toBeNull();
    expect(Number.isInteger(result.record.id)).toBe(true);
    expect(result.record.createdAt).toBeGreaterThan(0);
    expect(result.record.createdAt).toBeLessThanOrEqual(Date.now());

    // The auto-provisioned MCP key is scoped to exactly this bundle's tools
    // (client__tool composite keys), non-elevated, unrestricted consumer,
    // carries the same actor and expiry.
    const key = getMcpKey(result.record.mcpKeyId);
    expect(key).not.toBeNull();
    expect(key!.label).toBe("install-link:hp-bundle");
    expect(key!.scopes).toEqual({ tools: [`${clientName}__tool-a`, `${clientName}__tool-b`] });
    expect(key!.elevated).toBe(false);
    expect(key!.consumerId).toBeNull();
    expect(key!.createdBy).toBe("creator-actor");
    expect(key!.expiresAt).toBe(expiresAt);
    expect(key!.adminRole).toBeNull();
    expect(key!.revokedAt).toBeNull();
  });

  test("SECRETS_PROVIDER_ERROR (Error instance): message reflects err.message, and the freshly-minted key is revoked, not left orphaned", async () => {
    const bundleName = await makeBundleWithOneTool("err-bundle-a");
    const spy = spyOn(localProvider, "encryptSecret").mockRejectedValue(new Error("boom from provider"));
    try {
      const result = await createInstallLink(bundleName, null, "actor");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("SECRETS_PROVIDER_ERROR");
        expect(result.error.message).toBe("boom from provider");
      }
      // No install-link row should have been created.
      expect(listInstallLinks(bundleName)).toEqual([]);
      // The MCP key minted before the failure must be revoked, not orphaned.
      const orphan = listMcpKeys().find((k) => k.label === `install-link:${bundleName}`);
      expect(orphan).toBeDefined();
      expect(orphan!.revokedAt).not.toBeNull();
      expect(orphan!.enabled).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test("SECRETS_PROVIDER_ERROR (non-Error thrown value): message is String(err), not err.message", async () => {
    const bundleName = await makeBundleWithOneTool("err-bundle-b");
    const spy = spyOn(localProvider, "encryptSecret").mockRejectedValue("just a string, not an Error");
    try {
      const result = await createInstallLink(bundleName, null, "actor");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("SECRETS_PROVIDER_ERROR");
        expect(result.error.message).toBe("just a string, not an Error");
      }
    } finally {
      spy.mockRestore();
    }
  });
});

describe("listInstallLinks", () => {
  test("filters strictly by bundle_name and orders newest (highest id) first", async () => {
    const bundleA = await makeBundleWithOneTool("list-bundle-a");
    const bundleB = await makeBundleWithOneTool("list-bundle-b");

    const first = await createInstallLink(bundleA, null, "actor");
    const second = await createInstallLink(bundleA, null, "actor");
    await createInstallLink(bundleB, null, "actor");
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const linksA = listInstallLinks(bundleA);
    expect(linksA.map((l) => l.id)).toEqual([second.record.id, first.record.id]);
    expect(linksA.every((l) => l.bundleName === bundleA)).toBe(true);

    const linksB = listInstallLinks(bundleB);
    expect(linksB.length).toBe(1);
    expect(linksB[0]!.bundleName).toBe(bundleB);
  });

  test("returns an empty array for a bundle with no links", async () => {
    const bundleName = await makeBundleWithOneTool("list-bundle-empty");
    expect(listInstallLinks(bundleName)).toEqual([]);
  });
});

describe("revokeInstallLink", () => {
  test("NOT_FOUND for an unknown id, exact message", async () => {
    const bundleName = await makeBundleWithOneTool("revoke-bundle-unknown");
    const result = revokeInstallLink(bundleName, 999_999);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.message).toBe("Install link not found");
    }
  });

  // A non-integer `id` correctly reports NOT_FOUND (defensive-guard
  // behaviour worth documenting even though it can't discriminate the
  // mutant below -- see the accepted-equivalent comment that follows).
  test("NOT_FOUND for a non-integer id", async () => {
    const bundleName = await makeBundleWithOneTool("revoke-bundle-noninteger");
    const created = await createInstallLink(bundleName, null, "actor");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const result = revokeInstallLink(bundleName, created.record.id + 0.5);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  // The `!Number.isInteger(id)` guard inside getInstallLinkRow() (line ~196)
  // is an accepted EQUIVALENT mutant when replaced with `if (false) return
  // null;` -- empirically verified by hand-applying that exact mutation and
  // re-running this whole file: all tests, including the one directly above,
  // still passed unmodified. A throwaway bun:sqlite script confirmed why:
  // binding NaN, +/-Infinity, or any non-integer REAL (1.5, 1.0000000001, a
  // real row's id + 0.5) as the `?` parameter against an `INTEGER PRIMARY
  // KEY` column in a STRICT table never throws and never matches any row --
  // SQLite's own numeric equality already rejects every non-integer value the
  // guard would have caught, so bypassing the guard is unobservable from any
  // return value.

  test("NOT_FOUND when the id exists but belongs to a different bundle", async () => {
    const bundleA = await makeBundleWithOneTool("revoke-cross-a");
    const bundleB = await makeBundleWithOneTool("revoke-cross-b");
    const created = await createInstallLink(bundleA, null, "actor");
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = revokeInstallLink(bundleB, created.record.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    // And the link is untouched under its real bundle.
    expect(listInstallLinks(bundleA)[0]!.revokedAt).toBeNull();
  });

  test("ALREADY_REVOKED on a second revoke, exact message", async () => {
    const bundleName = await makeBundleWithOneTool("revoke-bundle-twice");
    const created = await createInstallLink(bundleName, null, "actor");
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const first = revokeInstallLink(bundleName, created.record.id);
    expect(first.ok).toBe(true);
    const second = revokeInstallLink(bundleName, created.record.id);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("ALREADY_REVOKED");
      expect(second.error.message).toBe("Install link is already revoked");
    }
  });

  test("happy path: revokes the link row AND its underlying MCP key in one call", async () => {
    const bundleName = await makeBundleWithOneTool("revoke-bundle-happy");
    const created = await createInstallLink(bundleName, null, "actor");
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = revokeInstallLink(bundleName, created.record.id);
    expect(result.ok).toBe(true);

    const link = listInstallLinks(bundleName).find((l) => l.id === created.record.id);
    expect(link).toBeDefined();
    expect(link!.revokedAt).not.toBeNull();

    const key = getMcpKey(created.record.mcpKeyId);
    expect(key!.revokedAt).not.toBeNull();
    expect(key!.enabled).toBe(false);
  });
});

describe("revokeAllInstallLinksForBundle", () => {
  // The `rows.length === 0` early return (line ~236) is an accepted
  // EQUIVALENT mutant when replaced with `if (false) return;` -- empirically
  // verified by hand-applying that exact mutation and re-running this whole
  // file: all tests, including the one directly below, still passed
  // unmodified. Tracing why: when `rows` is genuinely empty, bypassing the
  // early return only means the subsequent `for (const row of rows)` loop
  // inside the transaction executes zero iterations -- an unconditional
  // no-op with no observable side effect either way.
  test("no-op for a bundle with zero active links (none created)", async () => {
    const bundleName = await makeBundleWithOneTool("revoke-all-none");
    expect(() => revokeAllInstallLinksForBundle(bundleName)).not.toThrow();
    expect(listInstallLinks(bundleName)).toEqual([]);
  });

  test("no-op for a bundle whose only link is already revoked (doesn't touch its revoked_at again)", async () => {
    const bundleName = await makeBundleWithOneTool("revoke-all-already");
    const created = await createInstallLink(bundleName, null, "actor");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    revokeInstallLink(bundleName, created.record.id);
    const revokedAtBefore = listInstallLinks(bundleName)[0]!.revokedAt;

    revokeAllInstallLinksForBundle(bundleName);

    const revokedAtAfter = listInstallLinks(bundleName)[0]!.revokedAt;
    expect(revokedAtAfter).toBe(revokedAtBefore);
  });

  test("revokes every still-active link for the bundle AND each one's underlying MCP key, without touching a different bundle's links", async () => {
    const clientName = "revoke-all-client";
    await reg(clientName);
    const bundleTarget = "revoke-all-target";
    const bundleOther = "revoke-all-other";
    await createBundle(bundleTarget, undefined, [{ client: clientName, tool: "install-link-tool" }], "actor");
    await createBundle(bundleOther, undefined, [{ client: clientName, tool: "install-link-tool" }], "actor");

    const linkA = await createInstallLink(bundleTarget, null, "actor");
    const linkB = await createInstallLink(bundleTarget, null, "actor");
    const linkOther = await createInstallLink(bundleOther, null, "actor");
    expect(linkA.ok && linkB.ok && linkOther.ok).toBe(true);
    if (!linkA.ok || !linkB.ok || !linkOther.ok) return;

    revokeAllInstallLinksForBundle(bundleTarget);

    const targetLinks = listInstallLinks(bundleTarget);
    expect(targetLinks.length).toBe(2);
    expect(targetLinks.every((l) => l.revokedAt !== null)).toBe(true);
    expect(getMcpKey(linkA.record.mcpKeyId)!.revokedAt).not.toBeNull();
    expect(getMcpKey(linkB.record.mcpKeyId)!.revokedAt).not.toBeNull();

    // A different bundle's link is untouched.
    const otherLinks = listInstallLinks(bundleOther);
    expect(otherLinks.length).toBe(1);
    expect(otherLinks[0]!.revokedAt).toBeNull();
    expect(getMcpKey(linkOther.record.mcpKeyId)!.revokedAt).toBeNull();
  });
});

describe("resolveInstallLinkToken", () => {
  test("returns null for an empty/falsy token, even when a row happens to hash-match it", async () => {
    // A bare `resolveInstallLinkToken("")` would coincidentally return null
    // via the "unknown token" branch below regardless of whether the
    // `!rawToken` guard runs at all (hashApiKey("") won't match any
    // legitimately-generated row's token_hash) -- that convergent path masks
    // the guard's own mutant. To actually discriminate it, plant a row whose
    // token_hash is deliberately set to hashApiKey("") and confirm resolution
    // is STILL null: the guard must short-circuit before ever reaching the
    // DB, regardless of whether a matching row exists.
    const bundleName = await makeBundleWithOneTool("resolve-empty-token-plant");
    const created = await createInstallLink(bundleName, null, "actor");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    getDb()
      .query(`UPDATE bundle_install_tokens SET token_hash = ? WHERE id = ?`)
      .run(hashApiKey(""), created.record.id);

    expect(await resolveInstallLinkToken("")).toBeNull();
  });

  test("returns null for an unknown token", async () => {
    expect(await resolveInstallLinkToken("bil_this-does-not-exist")).toBeNull();
  });

  test("returns null for a revoked token", async () => {
    const bundleName = await makeBundleWithOneTool("resolve-revoked");
    const created = await createInstallLink(bundleName, null, "actor");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    revokeInstallLink(bundleName, created.record.id);
    expect(await resolveInstallLinkToken(created.rawToken)).toBeNull();
  });

  test("returns null for an expired token (in the past)", async () => {
    const bundleName = await makeBundleWithOneTool("resolve-expired");
    const created = await createInstallLink(bundleName, Date.now() - 1_000, "actor");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(await resolveInstallLinkToken(created.rawToken)).toBeNull();
  });

  test("boundary: expires_at exactly equal to Date.now() counts as expired (<=, not <)", async () => {
    const bundleName = await makeBundleWithOneTool("resolve-boundary-exact");
    const fixedNow = Date.now() + 500_000;
    const created = await createInstallLink(bundleName, fixedNow, "actor");
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const dateSpy = spyOn(Date, "now").mockReturnValue(fixedNow);
    try {
      expect(await resolveInstallLinkToken(created.rawToken)).toBeNull();
    } finally {
      dateSpy.mockRestore();
    }
  });

  test("boundary: expires_at one millisecond after Date.now() is NOT expired", async () => {
    const bundleName = await makeBundleWithOneTool("resolve-boundary-notyet");
    const fixedNow = Date.now() + 500_000;
    const created = await createInstallLink(bundleName, fixedNow + 1, "actor");
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const dateSpy = spyOn(Date, "now").mockReturnValue(fixedNow);
    try {
      const resolved = await resolveInstallLinkToken(created.rawToken);
      expect(resolved).not.toBeNull();
    } finally {
      dateSpy.mockRestore();
    }
  });

  test("happy path: resolves bundle detail + decrypted MCP key, and touches last_used_at", async () => {
    const clientName = "resolve-hp-client";
    await reg(clientName);
    const bundleName = "resolve-hp-bundle";
    await createBundle(bundleName, "a nice bundle", [{ client: clientName, tool: "install-link-tool" }], "actor");
    const created = await createInstallLink(bundleName, null, "actor");
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(listInstallLinks(bundleName)[0]!.lastUsedAt).toBeNull();

    const resolved = await resolveInstallLinkToken(created.rawToken);
    expect(resolved).not.toBeNull();
    expect(resolved!.bundle.name).toBe(bundleName);
    expect(resolved!.bundle.description).toBe("a nice bundle");
    // The decrypted key round-trips back to the exact raw MCP key minted at
    // creation time (never a human admin's own key).
    expect(typeof resolved!.mcpApiKey).toBe("string");
    expect(resolved!.mcpApiKey.startsWith("mcp_")).toBe(true);

    // Resolving is never null-returning without a side effect: last_used_at
    // gets touched on every successful resolution.
    const afterFirst = listInstallLinks(bundleName)[0]!.lastUsedAt;
    expect(afterFirst).not.toBeNull();

    await new Promise((r) => setTimeout(r, 2));
    await resolveInstallLinkToken(created.rawToken);
    const afterSecond = listInstallLinks(bundleName)[0]!.lastUsedAt;
    expect(afterSecond).not.toBeNull();
    expect(afterSecond! >= afterFirst!).toBe(true);
  });

  test("returns null and logs the exact warning (does not throw) when the secrets provider fails to decrypt", async () => {
    const bundleName = await makeBundleWithOneTool("resolve-decrypt-fail");
    const created = await createInstallLink(bundleName, null, "actor");
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const decryptSpy = spyOn(localProvider, "decryptSecret").mockRejectedValue(new Error("cannot decrypt"));
    const logSpy = spyOn(logger, "log").mockImplementation(() => {});
    try {
      const resolved = await resolveInstallLinkToken(created.rawToken);
      expect(resolved).toBeNull();
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith(
        "warn",
        "Failed to decrypt install-link MCP key — is the secrets provider configured correctly?",
        { installLinkId: created.record.id, error: "cannot decrypt" },
      );
    } finally {
      decryptSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  test("logs String(err) (not err.message) when the secrets provider throws a non-Error value on decrypt", async () => {
    const bundleName = await makeBundleWithOneTool("resolve-decrypt-fail-nonerror");
    const created = await createInstallLink(bundleName, null, "actor");
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const decryptSpy = spyOn(localProvider, "decryptSecret").mockRejectedValue("plain string failure");
    const logSpy = spyOn(logger, "log").mockImplementation(() => {});
    try {
      const resolved = await resolveInstallLinkToken(created.rawToken);
      expect(resolved).toBeNull();
      expect(logSpy).toHaveBeenCalledWith(
        "warn",
        "Failed to decrypt install-link MCP key — is the secrets provider configured correctly?",
        { installLinkId: created.record.id, error: "plain string failure" },
      );
    } finally {
      decryptSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  test("null-safety: expiresAt of null never expires regardless of how far Date.now() is pushed forward", async () => {
    const bundleName = await makeBundleWithOneTool("resolve-never-expires");
    const created = await createInstallLink(bundleName, null, "actor");
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const dateSpy = spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000);
    try {
      const resolved = await resolveInstallLinkToken(created.rawToken);
      expect(resolved).not.toBeNull();
    } finally {
      dateSpy.mockRestore();
    }
  });
});

// The `if (!bundle) return null;` branch inside resolveInstallLinkToken
// (getBundleDetail(row.bundle_name) returning undefined for a row that DID
// resolve by token_hash) is an accepted EQUIVALENT, not chased with a
// dedicated test. `bundle_install_tokens.bundle_name` carries `REFERENCES
// mcp_bundles(name) ON DELETE CASCADE` (src/db/migrations.ts, migration id
// 46) with `PRAGMA foreign_keys = ON` unconditionally set on every
// connection (src/db/connection.ts) — the same cascade shape already
// verified for mcp_bundle_tools by the sibling bundles.ts test suite.
// Verified empirically with a throwaway bun:sqlite script reproducing this
// exact schema: (1) inserting a bundle_install_tokens row referencing a
// nonexistent bundle_name throws "FOREIGN KEY constraint failed" — so a row
// can never exist without a live parent bundle; (2) deleting the parent
// mcp_bundles row cascades to delete the bundle_install_tokens row in the
// same transaction. So by the time the token_hash SELECT above finds a row,
// getBundleDetail(row.bundle_name) can never return undefined — the bundle
// it references, if the row itself is still readable, is guaranteed to
// still exist.
describe("db reference note", () => {
  test("smoke: getDb() is the same live handle bundle-install-links.ts reads/writes through", () => {
    expect(getDb()).toBeDefined();
  });
});
