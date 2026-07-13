import { parseFlags } from "../args.js";
import { makeClient, clientExists, CliApiError } from "../client.js";
import { loadGatewayFile, type GatewayServerEntry } from "../config-file.js";
import { errorMessage } from "../../lib/error-message.js";

interface ImportResult {
  dryRun: boolean;
  applied: Record<string, number>;
  skipped: { type: string; id: string; reason: string }[];
}

function toRegistrationPayload(s: GatewayServerEntry): Record<string, unknown> {
  if (s.kind === "mcp") {
    return { kind: "mcp", name: s.name, mcp_url: s.mcp_url, mcp_transport: s.mcp_transport };
  }
  if (s.kind === "graphql") {
    return {
      kind: "graphql",
      name: s.name,
      graphql_url: s.graphql_url,
      health_url: s.health_url,
      include_mutations: s.include_mutations,
    };
  }
  return {
    name: s.name,
    health_url: s.health_url,
    base_url: s.base_url,
    openapi_url: s.openapi_url,
    include_tags: s.include_tags,
    exclude_operations: s.exclude_operations,
  };
}

/**
 * Applies a gateway.yaml: registers any "servers:" entry not already present,
 * THEN applies "config:" via /admin-api/config/import. This order is a hard
 * rule — importConfig only configures already-registered clients, so a file
 * that both registers a server and sets its guards in the same run would
 * silently no-op the guard-setting if applied the other way around.
 */
export async function applyCommand(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv);
  const file = typeof flags.file === "string" ? flags.file : "gateway.yaml";
  const dryRun = flags["dry-run"] === true;
  const gatewayFile = await loadGatewayFile(file);
  const client = await makeClient();

  // Phase 1 — ensure servers[] exist.
  let anyServerFailed = false;
  for (const s of gatewayFile.servers ?? []) {
    if (await clientExists(client, s.name)) {
      console.log(`  = ${s.name} (already registered, skipping)`);
      continue;
    }
    if (dryRun) {
      console.log(`  + ${s.name} (would register)`);
      continue;
    }
    try {
      await client.post("/register", toRegistrationPayload(s));
      console.log(`  + ${s.name} (registered)`);
    } catch (err) {
      anyServerFailed = true;
      console.error(`  x ${s.name} (failed: ${errorMessage(err)})`);
    }
  }

  // Phase 2 — apply policy/guardrail/bundle config via the existing, idempotent endpoint.
  let importFailed = false;
  if (gatewayFile.config) {
    try {
      const result = await client.post<ImportResult>("/admin-api/config/import", { dryRun, data: gatewayFile.config });
      console.log(`config: applied ${JSON.stringify(result.applied)}`);
      if (result.skipped.length > 0) {
        importFailed = true;
        console.error(`config: ${result.skipped.length} entrie(s) skipped:`);
        for (const s of result.skipped) console.error(`  - ${s.type} ${s.id}: ${s.reason}`);
      }
    } catch (err) {
      importFailed = true;
      if (err instanceof CliApiError && /unsupported export version/i.test(err.message)) {
        console.error(
          `config: ${file} was exported from a different gateway version — run "gateway pull --file ${file}" to refresh, then re-apply your edits.`,
        );
      } else {
        console.error(`config: import failed: ${errorMessage(err)}`);
      }
    }
  }

  return anyServerFailed || importFailed ? 1 : 0;
}
