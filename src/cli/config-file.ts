import { readFile, writeFile } from "fs/promises";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ConfigExport } from "../admin/config/config-io.js";

/**
 * "servers:" entries are CLI-only — they aren't part of ConfigExport (which
 * only covers policy/config for already-registered clients). Ensuring a
 * server exists is a separate operation (POST /register) from applying
 * config, so this section is applied first, before "config:", by `apply`.
 */
export interface GatewayServerEntry {
  name: string;
  kind?: "rest" | "mcp" | "graphql";
  health_url?: string;
  base_url?: string;
  openapi_url?: string;
  include_tags?: string[];
  exclude_operations?: string[];
  graphql_url?: string;
  include_mutations?: boolean;
  mcp_url?: string;
  mcp_transport?: "streamable-http" | "sse";
}

export interface GatewayFile {
  version: number;
  servers?: GatewayServerEntry[];
  /** Verbatim ConfigExport shape — byte-for-byte what GET /admin-api/config/export returns. */
  config?: ConfigExport;
}

export async function loadGatewayFile(path: string): Promise<GatewayFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    throw new Error(`Cannot read ${path} — run "gateway pull --file ${path}" first, or create it by hand.`);
  }
  const parsed = parseYaml(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as GatewayFile).version !== "number") {
    throw new Error(`${path} is not a valid gateway.yaml (missing top-level "version")`);
  }
  return parsed as GatewayFile;
}

export async function saveGatewayFile(path: string, file: GatewayFile): Promise<void> {
  await writeFile(path, stringifyYaml(file), "utf-8");
}
