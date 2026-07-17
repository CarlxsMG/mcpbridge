import { parseFlags, wantsHelp } from "../args.js";
import { makeClient } from "../client.js";
import { saveGatewayFile, loadGatewayFile, type GatewayFile } from "../config-file.js";
import type { ConfigExport } from "../../admin/config/config-io.js";

export const USAGE = `Usage: gateway pull [--file gateway.yaml]`;

/** Writes the live config export into gateway.yaml's "config:" section, preserving any existing "servers:" list untouched (that section is hand-authored, not derived from the live gateway). */
export async function pullCommand(argv: string[]): Promise<number> {
  if (wantsHelp(argv)) {
    console.log(USAGE);
    return 0;
  }
  const { flags } = parseFlags(argv);
  const file = typeof flags.file === "string" ? flags.file : "gateway.yaml";

  const client = await makeClient();
  const config = await client.get<ConfigExport>("/admin-api/config/export");

  let servers: GatewayFile["servers"];
  try {
    servers = (await loadGatewayFile(file)).servers;
  } catch {
    servers = undefined; // no existing file — fine, pull only ever writes "config:"
  }

  await saveGatewayFile(file, { version: 1, ...(servers ? { servers } : {}), config });
  console.log(`Wrote ${file}`);
  return 0;
}
