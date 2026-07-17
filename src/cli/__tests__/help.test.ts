import { describe, test, expect } from "bun:test";
import { join } from "path";

// End-to-end regression test for finding #14: `gateway <subcommand> --help`
// used to fall through to the command and attempt real I/O (a cryptic
// file-not-found / connection error, non-zero exit) instead of printing usage.
// These spawn the actual CLI so the whole dispatch path (index.ts -> the
// per-command wantsHelp early-return) is exercised, not just the command
// functions in isolation. No admin API / credentials are needed precisely
// BECAUSE help must return before any I/O — that's the property under test.

const CLI = join(import.meta.dir, "..", "index.ts");

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("gateway CLI help (end-to-end via the real process)", () => {
  const SUBCOMMANDS = ["login", "pull", "plan", "apply", "connect"] as const;

  for (const cmd of SUBCOMMANDS) {
    test(`\`${cmd} --help\` prints that command's usage to stdout and exits 0`, async () => {
      const { code, stdout, stderr } = await runCli([cmd, "--help"]);

      expect(code).toBe(0);
      expect(stdout).toContain(`Usage: gateway ${cmd}`);
      // The old bug surfaced as an error written to stderr before a non-zero
      // exit — assert the help path is clean.
      expect(stderr).toBe("");
    });

    test(`\`${cmd} -h\` prints that command's usage to stdout and exits 0`, async () => {
      const { code, stdout } = await runCli([cmd, "-h"]);

      expect(code).toBe(0);
      expect(stdout).toContain(`Usage: gateway ${cmd}`);
    });
  }

  test("top-level `--help` prints the overview usage and exits 0", async () => {
    const { code, stdout } = await runCli(["--help"]);

    expect(code).toBe(0);
    expect(stdout).toContain("Usage: gateway <command>");
  });

  test("no arguments at all prints the overview usage and exits 0", async () => {
    const { code, stdout } = await runCli([]);

    expect(code).toBe(0);
    expect(stdout).toContain("Usage: gateway <command>");
  });

  test("an unknown command reports it on stderr and exits 1", async () => {
    const { code, stderr } = await runCli(["frobnicate"]);

    expect(code).toBe(1);
    expect(stderr).toContain("unknown command 'frobnicate'");
  });
});
