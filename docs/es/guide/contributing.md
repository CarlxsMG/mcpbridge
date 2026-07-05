# Contributing

Root [`CONTRIBUTING.md`](https://github.com/aico-dot-team-code/mcpbridge/blob/main/CONTRIBUTING.md)
is the canonical, GitHub-native reference (it's what GitHub links from the "new PR" banner and
the repo's Community Standards). This page is the searchable, cross-linked version for readers
already in the docs site — a superset that links out to Architecture/Configuration/Security
rather than re-explaining them, so keep both in sync if you change either.

## Before you start

Read **[Architecture →](/guide/architecture)** and **[Concepts & glossary →](/guide/concepts)**
first — the request-path mental model (every policy enforced at dispatch, never as HTTP
middleware) explains a lot of decisions you'll otherwise have to re-derive from the code. For
anything beyond a small fix, open an issue to discuss the approach before writing code — it
saves rework on both sides.

## Dev environment setup

### Prerequisites

- [Bun](https://bun.sh) `1.x` — the gateway uses Bun's built-ins (`bun:sqlite`, `Bun.dns`,
  `Bun.password`) directly, so Node.js is not a substitute.

### Clone, install, configure

```bash
git clone https://github.com/aico-dot-team-code/mcpbridge.git
cd mcpbridge
bun install
cp .env.example .env                 # then set BOOTSTRAP_ADMIN_PASSWORD (min 12 chars)

cd admin-ui && bun install && cd ..
```

Set `ADMIN_API_KEYS` in `.env` too if you'll be scripting against `/register` or `/admin-api`
directly rather than only using the UI — see [Getting started →](/guide/getting-started) for
the full first-run walkthrough (including the exact env vars each local option needs).

### Run the full stack

```bash
bun run dev:all      # backend :8790 + admin UI :8791, both with hot reload
```

## Running tests, typecheck & lint

| Command                            | What it runs                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| `bun test`                         | Backend test suite (`src/**/__tests__/`). Should be 100% green.                                     |
| `bun run typecheck`                | Backend typecheck (`tsc --noEmit`)                                                                  |
| `cd admin-ui && bun run test`      | Admin UI component/unit tests (Vitest)                                                              |
| `cd admin-ui && bun run typecheck` | Admin UI typecheck (`vue-tsc -b --noEmit`)                                                          |
| `cd admin-ui && bun run build`     | Admin UI production build — catches a few things typecheck alone doesn't (e.g. unused Vite imports) |
| `bun run test:e2e`                 | Playwright end-to-end smoke test (`e2e/`)                                                           |

### The root-vs-package gotcha

Backend and admin UI are **separate TypeScript projects** with their own `lint`/`typecheck`
scripts — running only the package you touched is not the same as the repo's actual CI gate.
In particular, **`bun run format:check` (Prettier) is a root-level script only** — admin-ui's
own `package.json` has no `format`/`format:check` of its own. It's easy to run
`cd admin-ui && bun run lint && bun run typecheck && bun run test && bun run build`, see
everything pass, and still have formatting drift that only the root check catches.

### One command before you push

```bash
bun run check
```

Runs the full gate in order — format check → root lint → admin-ui lint → root typecheck →
root tests → admin-ui typecheck → admin-ui tests → admin-ui build — stopping at the first
failure. This is what CI runs; treat a clean `bun run check` as the actual bar for "ready to
open a PR," not just a green package-scoped run.

## Code style & conventions

- No enforced personal style beyond ESLint + Prettier — match the formatting, naming, and file
  organization already present in the module you're editing.
- TypeScript is **strict** on both projects — don't work around type errors with `any` or
  non-null assertions unless there's no reasonable alternative; prefer narrowing/guards over
  casts.
- Keep modules focused: security-sensitive logic lives under `src/security/`, route handlers
  under `src/routes/`, DB access under `src/db/`. Admin UI components live under
  `admin-ui/src/components/{ui,charts,guard-editor,server-detail,layout}/` by role.
- **Every policy is enforced at the dispatch point (`proxyToolCall`), never as HTTP
  middleware** — MCP multiplexes many tools over one `POST /mcp` route, so the bridge has to
  know which tool is being called before it can apply per-tool rules. Don't add a new guard as
  Express middleware; wire it into the dispatch pipeline instead.

### A known gotcha worth not rediscovering

Don't set `display` (`flex`/`grid`/etc.) directly on a `<td>` in an admin-ui table — it
overrides the default `table-cell` display and visually breaks the row layout (column sizing
and alignment collapse). Wrap the cell's content in a child `<div>` and apply the
display-changing class to that instead; the `<td>` itself stays bare.

## Database migrations

Schema changes live in `src/db/migrations.ts`, exported as an **append-only, ordered array**
of `{ id, name, sql }` objects.

- **Never edit or renumber an existing migration.** Once merged to `main`, its `id` and `sql`
  are frozen — fix a mistake with a new migration that alters/repairs the schema.
- **Migrations are forward-only.** There's no down-migration mechanism — write the SQL
  defensively (`CREATE TABLE IF NOT EXISTS`, additive `ALTER TABLE`) and think about what
  happens to existing rows/databases when it runs.
- **IDs are sequential integers**, applied in ascending order at startup, each inside its own
  transaction. Check the tail of `src/db/migrations.ts` for the current highest `id` before
  adding a new one.
- Test a new migration locally against a throwaway DB (`DB_PATH=:memory:` or a scratch file)
  before committing — see [Deployment →](/guide/deployment) for the upgrade/backup story this
  feeds into in production.

## Branch, commit & PR conventions

Commits follow a `type(scope): summary` convention (the `(scope)` is optional):

- `feat:` / `feat(scope):` — new functionality
- `fix:` / `fix(scope):` — bug fixes, including hardening passes
- `docs:` — documentation-only changes
- `chore:` — tooling/config changes with no runtime behavior change
- `refactor:` — internal restructuring with no behavior change
- `test:` — test-only additions/changes

**Feat-then-harden.** Larger changes frequently land as a `feat` commit followed by one or more
`fix` commits that harden it (edge cases found on review) — rather than one giant diff, or
folding hardening back into the feature commit after the fact.

**Priority tiers.** PR descriptions and hardening commits in this repo often use
`[P0]`/`[P1]`/`[P2]` suffixes — P0 = correctness/security-critical, P1 = important robustness,
P2 = polish. Not required, but consistent with the project's history if you want to signal
urgency:

```
fix(admin-ui): stop the .field input recipe double-bordering child components' own inputs [P2]
```

Keep PRs scoped to one logical change. Reference the issue you discussed the approach in, if
there was one.

## PR checklist

- [ ] `bun run check` passes (this is the actual CI gate — see the root-vs-package note above)
- [ ] New/changed schema is a new, appended `src/db/migrations.ts` entry, tested against a
      fresh DB — never an edit to an existing one
- [ ] Docs updated if user-facing behavior, config, or API changed
- [ ] Commit messages follow the `type(scope): summary` convention above
- [ ] Screenshots included for any admin-ui visual change

Next: **[Changelog →](/guide/changelog)** · **[Security policy →](/guide/security-policy)**
