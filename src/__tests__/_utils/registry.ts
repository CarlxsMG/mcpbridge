/**
 * Shared registry fixtures for backend tests.
 *
 * Before this module existed, every test file that needed a registered client
 * carried its own copy of the same three things — a `makeTool()` builder, a
 * `reg()` wrapper over `registry.register(...)`, and the unregister-everything
 * cleanup loop. The copies had drifted into a dozen incompatible signatures
 * (`makeTool()` / `makeTool(name)` / `makeTool(overrides)`), and the cleanup
 * line alone appeared 229 times across 131 files.
 *
 * DELIBERATELY NOT AUTOMATIC. `clearRegistry()` is a function a test calls from
 * its own `beforeEach`, not a hook this module installs. CLAUDE.md's rule is
 * that the per-test reset in `test-isolation.ts` is a safety net rather than a
 * licence, and a test must pin the state it depends on itself — hiding setup
 * inside an auto-installed hook is exactly how this suite became
 * order-dependent before (green on Windows, two different failures on two
 * Linux orderings). Keep the setup visible at the call site.
 */
import { registry } from "../../mcp/registry.js";
import type { RestToolDefinition } from "../../mcp/types.js";

/**
 * The canonical fake backend every test registers against: a public hostname
 * with a public resolved IP, so the SSRF guard accepts it without needing
 * `config.allowPrivateIps`. These exact values are the ones already dominant
 * across the suite (118 files use `example.com` + `1.2.3.4`).
 *
 * Nothing asserts on these — they exist to satisfy `register()`'s signature.
 * A test that genuinely cares about the URL should pass its own and say why.
 */
export const TEST_BACKEND = {
  healthUrl: "http://example.com/health",
  baseUrl: "http://example.com",
  resolvedIp: "1.2.3.4",
} as const;

/**
 * Build a REST tool definition. Everything is derived from the name so two
 * tools built from different names never accidentally collide on endpoint,
 * and any field can be overridden for the case under test.
 */
export function makeTool(overrides: Partial<RestToolDefinition> = {}): RestToolDefinition {
  const name = overrides.name ?? "get-users";
  return {
    name,
    method: "GET",
    endpoint: `/${name}`,
    description: name,
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

/** Build N tools at once, one per name. */
export function makeTools(...names: string[]): RestToolDefinition[] {
  return names.map((name) => makeTool({ name }));
}

/**
 * Register a client against {@link TEST_BACKEND}. Defaults to one client named
 * "svc" exposing a single "get-users" tool — the shape most tests want.
 */
export async function registerTestClient(name = "svc", tools: RestToolDefinition[] = [makeTool()]): Promise<void> {
  await registry.register(
    name,
    tools,
    TEST_BACKEND.healthUrl,
    TEST_BACKEND.resolvedIp,
    TEST_BACKEND.baseUrl,
    TEST_BACKEND.resolvedIp,
  );
}

/**
 * Unregister every client currently in the registry.
 *
 * Call this from the test file's own `beforeEach`/`afterEach` — see the
 * module header for why it is not installed automatically.
 */
export async function clearRegistry(): Promise<void> {
  for (const client of registry.listClients()) {
    await registry.unregister(client.name);
  }
}
