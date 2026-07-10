import { describe, test, expect, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { loadGatewayFile, saveGatewayFile, type GatewayFile } from "../config-file.js";

/**
 * Mutation-testing backstop for src/cli/config-file.ts.
 *
 * src/cli/__tests__/cli.test.ts (existing, untouched) already covers:
 *   - a full servers+config round-trip through saveGatewayFile/loadGatewayFile
 *   - the "missing file" friendly error (readFile throws -> rejects /gateway pull/)
 *   - a file missing the top-level "version" key (an object, just no `version`)
 *   - loadGatewayFile's YAML round-trip not introducing spurious diffConfigs drift
 *
 * This file gap-fills loadGatewayFile's validation guard itself:
 *
 *   typeof parsed !== "object" || parsed === null || typeof parsed.version !== "number"
 *
 * Each of the three clauses is exercised independently (a non-object scalar, a
 * bare `null` document, and an object whose `version` is present but the wrong
 * type), plus the exact wording of both thrown error messages (since a
 * StringLiteral mutant that empties either message would otherwise survive
 * against a loose regex), plus a config-less/servers-less minimal file to
 * prove those fields are genuinely optional at runtime, not just in the type.
 */
describe("loadGatewayFile validation guard — gap-fill", () => {
  let dir = "";

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("a YAML document that parses to a scalar (not an object) is rejected", async () => {
    // typeof "42" (as parsed from bare YAML "42") is "number", which trips
    // the first clause (`typeof parsed !== "object"`) on its own — the
    // second (`=== null`) and third (`.version`) clauses can't even be
    // reached since a number has no `.version`.
    dir = await mkdtemp(join(tmpdir(), "gateway-cli-test-"));
    const path = join(dir, "gateway.yaml");
    await writeFile(path, "42\n", "utf-8");
    await expect(loadGatewayFile(path)).rejects.toThrow(
      `${path} is not a valid gateway.yaml (missing top-level "version")`,
    );
  });

  test("a YAML document that parses to a string scalar is rejected", async () => {
    dir = await mkdtemp(join(tmpdir(), "gateway-cli-test-"));
    const path = join(dir, "gateway.yaml");
    await writeFile(path, "just a plain string\n", "utf-8");
    await expect(loadGatewayFile(path)).rejects.toThrow(/not a valid gateway\.yaml/);
  });

  test("a YAML document that parses to an array is rejected", async () => {
    // typeof [] === "object", so this can only be caught by the third clause
    // (no `.version` on an array) — proves the first clause alone isn't
    // doing all the work, and that arrays aren't accidentally accepted as
    // "objects with a version".
    dir = await mkdtemp(join(tmpdir(), "gateway-cli-test-"));
    const path = join(dir, "gateway.yaml");
    await writeFile(path, "- a\n- b\n", "utf-8");
    await expect(loadGatewayFile(path)).rejects.toThrow(/not a valid gateway\.yaml/);
  });

  test("a bare `null` YAML document is rejected via the null clause, not a TypeError", async () => {
    // typeof null === "object", so the first clause is false here. Only the
    // `parsed === null` clause stops execution before `(parsed as
    // GatewayFile).version` would be evaluated on null and throw a raw
    // TypeError instead of the friendly, expected error.
    dir = await mkdtemp(join(tmpdir(), "gateway-cli-test-"));
    const path = join(dir, "gateway.yaml");
    await writeFile(path, "null\n", "utf-8");
    await expect(loadGatewayFile(path)).rejects.toThrow(
      `${path} is not a valid gateway.yaml (missing top-level "version")`,
    );
  });

  test("an empty YAML file (parses to null, like the explicit `null` case) is rejected, not a TypeError", async () => {
    dir = await mkdtemp(join(tmpdir(), "gateway-cli-test-"));
    const path = join(dir, "gateway.yaml");
    await writeFile(path, "", "utf-8");
    await expect(loadGatewayFile(path)).rejects.toThrow(
      `${path} is not a valid gateway.yaml (missing top-level "version")`,
    );
  });

  test("version present but the wrong type (a string, not a number) is rejected", async () => {
    dir = await mkdtemp(join(tmpdir(), "gateway-cli-test-"));
    const path = join(dir, "gateway.yaml");
    await writeFile(path, 'version: "1"\n', "utf-8");
    await expect(loadGatewayFile(path)).rejects.toThrow(
      `${path} is not a valid gateway.yaml (missing top-level "version")`,
    );
  });

  test("version: 0 is accepted — a falsy-but-numeric version must not be rejected", async () => {
    // Guards against a mutant that swaps `typeof x !== "number"` for a
    // truthiness check on `x` itself, which would incorrectly reject 0.
    dir = await mkdtemp(join(tmpdir(), "gateway-cli-test-"));
    const path = join(dir, "gateway.yaml");
    await writeFile(path, "version: 0\n", "utf-8");
    const loaded = await loadGatewayFile(path);
    expect(loaded.version).toBe(0);
  });

  test("the missing-file error message names the exact path and the pull command", async () => {
    dir = await mkdtemp(join(tmpdir(), "gateway-cli-test-"));
    const path = join(dir, "missing.yaml");
    await expect(loadGatewayFile(path)).rejects.toThrow(
      `Cannot read ${path} — run "gateway pull --file ${path}" first, or create it by hand.`,
    );
  });

  test("a minimal file with only version (no servers, no config) loads with both left undefined", async () => {
    dir = await mkdtemp(join(tmpdir(), "gateway-cli-test-"));
    const path = join(dir, "gateway.yaml");
    const file: GatewayFile = { version: 3 };
    await saveGatewayFile(path, file);
    const loaded = await loadGatewayFile(path);
    expect(loaded).toEqual({ version: 3 });
    expect(loaded.servers).toBeUndefined();
    expect(loaded.config).toBeUndefined();
  });

  test("saveGatewayFile persists real, re-readable YAML content to disk (not a no-op)", async () => {
    dir = await mkdtemp(join(tmpdir(), "gateway-cli-test-"));
    const path = join(dir, "gateway.yaml");
    await saveGatewayFile(path, { version: 7, servers: [{ name: "svc" }] });
    // Read the raw bytes back independently of loadGatewayFile to prove the
    // write actually happened and contains recognizable YAML, not that
    // loadGatewayFile is merely echoing back an in-memory object.
    const raw = await Bun.file(path).text();
    expect(raw).toContain("version: 7");
    expect(raw).toContain("name: svc");
  });

  test("saveGatewayFile then loadGatewayFile preserves multiple distinct servers (not just the first)", async () => {
    dir = await mkdtemp(join(tmpdir(), "gateway-cli-test-"));
    const path = join(dir, "gateway.yaml");
    const file: GatewayFile = {
      version: 1,
      servers: [
        { name: "svc-a", kind: "rest" },
        { name: "svc-b", kind: "mcp", mcp_url: "https://svc-b.example.com/mcp" },
      ],
    };
    await saveGatewayFile(path, file);
    const loaded = await loadGatewayFile(path);
    expect(loaded.servers).toHaveLength(2);
    expect(loaded.servers?.[0]?.name).toBe("svc-a");
    expect(loaded.servers?.[1]?.name).toBe("svc-b");
    expect(loaded.servers?.[1]?.kind).toBe("mcp");
  });
});
