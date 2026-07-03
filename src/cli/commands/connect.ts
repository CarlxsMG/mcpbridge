import { writeFile } from "fs/promises";
import { parseFlags } from "../args.js";
import { makeClient, loadCliCredentials, CliApiError } from "../client.js";
import {
  CONNECT_CLIENT_IDS,
  CONNECT_TEMPLATES,
  isConnectClientId,
  resolveGatewayEndpoint,
  type ConnectScope,
} from "../connect-templates.js";

const USAGE = `Usage: gateway connect --client <${CONNECT_CLIENT_IDS.join("|")}> --scope <client|bundle|aggregated> [--name <clientOrBundleName>] [--out <file>]`;

interface ClientDetailLike {
  enabled: boolean;
}
interface BundleDetailLike {
  enabled: boolean;
}

/**
 * Generates a ready-to-paste MCP client connection config (claude_desktop_config.json /
 * .cursor/mcp.json / etc. — see ../connect-templates.ts) for a registered
 * client, a curated bundle, or the full aggregated /mcp endpoint. Confirms
 * the target actually exists (and is enabled) via the real admin API rather
 * than trusting the name blindly — see the 404/disabled handling below.
 */
export async function connectCommand(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv);
  const clientFlag = typeof flags.client === "string" ? flags.client : "";
  const scopeFlag = typeof flags.scope === "string" ? flags.scope : "";
  const name = typeof flags.name === "string" ? flags.name : "";
  const out = typeof flags.out === "string" ? flags.out : "";

  if (!isConnectClientId(clientFlag)) {
    console.error(`Unknown or missing --client "${clientFlag}".\n${USAGE}`);
    return 1;
  }
  if (scopeFlag !== "client" && scopeFlag !== "bundle" && scopeFlag !== "aggregated") {
    console.error(`Unknown or missing --scope "${scopeFlag}".\n${USAGE}`);
    return 1;
  }
  const scope: ConnectScope = scopeFlag;
  if ((scope === "client" || scope === "bundle") && !name) {
    console.error(`--name is required for --scope ${scope}.\n${USAGE}`);
    return 1;
  }

  const { url: gatewayUrl } = await loadCliCredentials();
  const apiClient = await makeClient();

  if (scope === "client") {
    try {
      const detail = await apiClient.get<ClientDetailLike>(`/admin-api/clients/${encodeURIComponent(name)}`);
      if (!detail.enabled) {
        console.error(
          `Warning: client "${name}" exists but is currently disabled — its tools won't be callable until it's re-enabled.`,
        );
      }
    } catch (err) {
      if (err instanceof CliApiError && err.status === 404) {
        console.error(
          `Client "${name}" was not found on ${gatewayUrl} — check the name in the admin UI's Servers page.`,
        );
        return 1;
      }
      throw err;
    }
  } else if (scope === "bundle") {
    try {
      const detail = await apiClient.get<BundleDetailLike>(`/admin-api/bundles/${encodeURIComponent(name)}`);
      if (!detail.enabled) {
        console.error(
          `Warning: bundle "${name}" exists but is currently disabled — its endpoint won't serve tools until it's re-enabled.`,
        );
      }
    } catch (err) {
      if (err instanceof CliApiError && err.status === 404) {
        console.error(
          `Bundle "${name}" was not found on ${gatewayUrl} — check the name in the admin UI's Bundles page.`,
        );
        return 1;
      }
      throw err;
    }
  }

  // Every scope this gateway exposes (sharded per-client/-bundle, and the
  // legacy aggregated /mcp) is Streamable HTTP only — see the file-level
  // comment in ../connect-templates.ts for why this is fixed rather than
  // fetched per client.
  const transport = "streamable-http" as const;
  const url = resolveGatewayEndpoint(gatewayUrl, scope, name || undefined);
  const template = CONNECT_TEMPLATES[clientFlag];
  const result = template.generate({
    name: name || "gateway",
    url,
    transport,
    apiKeyPlaceholder: "<YOUR_MCP_API_KEY>",
  });

  const output = [
    `# ${template.label} — save as ${result.filename}`,
    ...result.instructions.map((line, i) => `# ${i + 1}. ${line}`),
    "",
    result.snippet,
    "",
  ].join("\n");

  if (out) {
    await writeFile(out, output, "utf-8");
    console.log(`Wrote ${out}`);
  } else {
    console.log(output);
  }
  return 0;
}
