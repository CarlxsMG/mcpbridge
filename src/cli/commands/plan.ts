import { parseFlags } from "../args.js";
import { makeClient, clientExists } from "../client.js";
import { loadGatewayFile } from "../config-file.js";
import { diffConfigs } from "../../admin/config/config-diff.js";
import type { ConfigExport } from "../../admin/config/config-io.js";

/** Drops fields that legitimately differ between any two exports (a fresh timestamp) so they never register as config drift. */
function stripVolatile(c: ConfigExport): Omit<ConfigExport, "exportedAt"> {
  const { exportedAt: _exportedAt, ...rest } = c;
  return rest;
}

/** Shows what `apply` would change, without changing anything. Exits non-zero when there's drift, so CI can gate on it (e.g. `gateway plan --file gateway.yaml || echo "drift detected"`). */
export async function planCommand(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv);
  const file = typeof flags.file === "string" ? flags.file : "gateway.yaml";
  const gatewayFile = await loadGatewayFile(file);
  const client = await makeClient();

  let drift = false;

  for (const s of gatewayFile.servers ?? []) {
    const exists = await clientExists(client, s.name);
    console.log(exists ? `  = ${s.name} (already registered)` : `  + ${s.name} (would be registered)`);
    if (!exists) drift = true;
  }

  if (gatewayFile.config) {
    const live = await client.get<ConfigExport>("/admin-api/config/export");
    const entries = diffConfigs(stripVolatile(live), stripVolatile(gatewayFile.config));
    if (entries.length === 0) {
      console.log("config: no drift");
    } else {
      drift = true;
      console.log(`config: ${entries.length} diff(s)`);
      for (const e of entries) {
        console.log(`  ${e.kind.toUpperCase().padEnd(8)} ${e.path}`);
      }
    }
  }

  if (!drift) console.log("Up to date.");
  return drift ? 1 : 0;
}
