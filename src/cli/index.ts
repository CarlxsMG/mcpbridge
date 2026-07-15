#!/usr/bin/env bun
/**
 * "gateway" CLI — config-as-code for this project's admin API. Thin wrapper
 * around existing HTTP endpoints (POST /register, /admin-api/config/export
 * and /import); no server-side logic lives here. Invoke via
 * `bun run cli -- <command> [...args]`.
 */
import { loginCommand } from "./commands/login.js";
import { pullCommand } from "./commands/pull.js";
import { planCommand } from "./commands/plan.js";
import { applyCommand } from "./commands/apply.js";
import { connectCommand } from "./commands/connect.js";
import { errorMessage } from "../lib/error-message.js";
// Static import so the version resolves identically under `bun run cli` and a
// `bun build --compile` standalone binary (see the note in src/mcp/mcp-server.ts).
import pkg from "../../package.json";

const COMMANDS: Record<string, (argv: string[]) => Promise<number>> = {
  login: loginCommand,
  pull: pullCommand,
  plan: planCommand,
  apply: applyCommand,
  connect: connectCommand,
};

const USAGE = `gateway ${pkg.version} — config-as-code for the MCP REST Bridge admin API

Usage: gateway <command> [...args]

Commands:
  login --url <gateway-url> --token <admin-api-key>
  pull [--file gateway.yaml]
  plan [--file gateway.yaml]
  apply [--file gateway.yaml] [--dry-run]
  connect --client <claude-desktop|cursor|windsurf|continue|generic-json> --scope <client|bundle|system> [--name <clientOrBundleName>] [--out <file>]
  version

Flags:
  -h, --help     Show this help
  -v, --version  Show the version

Every subcommand prints its own usage on missing/invalid arguments.`;

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return 0;
  }
  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    console.log(pkg.version);
    return 0;
  }

  const fn = COMMANDS[cmd];
  if (!fn) {
    console.error(`gateway: unknown command '${cmd}'\n\n${USAGE}`);
    return 1;
  }
  try {
    return await fn(rest);
  } catch (err) {
    console.error(errorMessage(err));
    return 1;
  }
}

process.exit(await main());
