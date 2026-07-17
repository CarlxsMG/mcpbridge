/**
 * Hand-rolled flag parser — no commander/yargs dependency, matching this
 * project's existing precedent for small tooling (see scripts/dev-all.ts's
 * "Dependency-free — no `concurrently`"). The CLI's command surface is small
 * and shallow enough that a ~20-line parser is less code than wiring up a
 * package's API.
 */
export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function parseFlags(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) {
        flags[a.slice(2)] = argv[++i];
      } else {
        flags[a.slice(2)] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

/**
 * True when `argv` asks for help (`-h` or `--help`). The parser above turns
 * `--help` into `flags.help` but leaves a single-dash `-h` as a positional, so
 * help detection can't rely on `flags` alone — it scans the raw argv for
 * either spelling. Commands call this BEFORE any I/O so `--help` prints usage
 * and exits 0 instead of running (and failing) the real command.
 */
export function wantsHelp(argv: string[]): boolean {
  return argv.includes("-h") || argv.includes("--help");
}
