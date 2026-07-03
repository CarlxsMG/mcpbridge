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

const COMMANDS: Record<string, (argv: string[]) => Promise<number>> = {
  login: loginCommand,
  pull: pullCommand,
  plan: planCommand,
  apply: applyCommand,
  connect: connectCommand,
};

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const fn = cmd ? COMMANDS[cmd] : undefined;
  if (!fn) {
    console.error(
      `Usage: gateway <command> [...args]\n\nCommands:\n  login --url <gateway-url> --token <admin-api-key>\n  pull [--file gateway.yaml]\n  plan [--file gateway.yaml]\n  apply [--file gateway.yaml] [--dry-run]\n  connect --client <claude-desktop|cursor|windsurf|continue|generic-json> --scope <client|bundle|aggregated> [--name <clientOrBundleName>] [--out <file>]`,
    );
    return cmd ? 1 : 0;
  }
  try {
    return await fn(rest);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

process.exit(await main());
