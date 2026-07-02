import { describe, test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { parseFlags } from "../cli/args.js";
import { loadGatewayFile, saveGatewayFile, type GatewayFile } from "../cli/config-file.js";
import { diffConfigs } from "../config-diff.js";

describe("parseFlags", () => {
  test("parses --flag value, --flag=value, and boolean flags", () => {
    const { positionals, flags } = parseFlags(["apply", "--file", "gateway.yaml", "--dry-run", "--foo=bar"]);
    expect(positionals).toEqual(["apply"]);
    expect(flags.file).toBe("gateway.yaml");
    expect(flags["dry-run"]).toBe(true);
    expect(flags.foo).toBe("bar");
  });

  test("a flag immediately followed by another flag is treated as boolean", () => {
    const { flags } = parseFlags(["--a", "--b", "value"]);
    expect(flags.a).toBe(true);
    expect(flags.b).toBe("value");
  });
});

describe("gateway.yaml load/save round-trip", () => {
  let dir = "";

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("round-trips servers + config through YAML", async () => {
    dir = await mkdtemp(join(tmpdir(), "gateway-cli-test-"));
    const path = join(dir, "gateway.yaml");
    const file: GatewayFile = {
      version: 1,
      servers: [{ name: "svc", kind: "rest", health_url: "https://svc.example.com/health", openapi_url: "https://svc.example.com/openapi.json" }],
      config: { version: 1, exportedAt: 0, bundles: [], alertRules: [], clients: [], guardrails: [], consumers: [] },
    };
    await saveGatewayFile(path, file);
    const loaded = await loadGatewayFile(path);
    expect(loaded).toEqual(file);
  });

  test("throws a helpful error for a missing file", async () => {
    dir = await mkdtemp(join(tmpdir(), "gateway-cli-test-"));
    await expect(loadGatewayFile(join(dir, "missing.yaml"))).rejects.toThrow(/gateway pull/);
  });

  test("throws for a file missing the top-level version", async () => {
    dir = await mkdtemp(join(tmpdir(), "gateway-cli-test-"));
    const path = join(dir, "gateway.yaml");
    await saveGatewayFile(path, { servers: [] } as unknown as GatewayFile);
    await expect(loadGatewayFile(path)).rejects.toThrow(/not a valid gateway.yaml/);
  });

  test("two exports of the same config differ only in exportedAt — plan must not treat that as drift", () => {
    const base = { version: 1, bundles: [], alertRules: [], clients: [], guardrails: [], consumers: [] };
    const exportA = { ...base, exportedAt: 1000 };
    const exportB = { ...base, exportedAt: 2000 };
    // Raw diff sees the timestamp change (proves the field really does vary).
    expect(diffConfigs(exportA, exportB)).toHaveLength(1);
    // planCommand strips exportedAt before diffing for exactly this reason.
    const { exportedAt: _a, ...strippedA } = exportA;
    const { exportedAt: _b, ...strippedB } = exportB;
    expect(diffConfigs(strippedA, strippedB)).toEqual([]);
  });

  test("pull then plan (no edits) is a no-op: diffConfigs of an unchanged round-trip is empty", async () => {
    const config = {
      version: 1,
      exportedAt: 12345,
      bundles: [{ name: "b1", description: null, enabled: true, tools: [{ client: "svc", tool: "get-x" }] }],
      alertRules: [],
      clients: [{ name: "svc", enabled: true, guards: null, tools: [{ name: "get-x", enabled: true, guards: null, override: null }] }],
      guardrails: [],
      consumers: [{ name: "team", monthlyQuota: 100, endUserRateLimitPerMin: null }],
    };
    dir = await mkdtemp(join(tmpdir(), "gateway-cli-test-"));
    const path = join(dir, "gateway.yaml");
    await saveGatewayFile(path, { version: 1, config });
    const roundTripped = (await loadGatewayFile(path)).config!;
    // Same canonicalization diffConfigs itself uses — proves the YAML
    // round-trip (key/array reordering) doesn't introduce spurious diffs.
    expect(diffConfigs(config, roundTripped)).toEqual([]);
  });
});
