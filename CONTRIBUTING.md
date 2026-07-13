# Contributing to MCP REST Bridge

Thanks for your interest in improving MCP REST Bridge! This doc covers dev setup,
how to run the checks CI runs, code style expectations, how the database migration
system works, and the branch/PR conventions used in this repo.

Contributions are welcome. For anything beyond a small fix, please open an issue
first to discuss the approach — it saves everyone rework.

## Dev setup

This project is a [Bun](https://bun.sh) + TypeScript monorepo-of-sorts: the gateway
lives at the repo root, and the admin UI is a separate Vue 3 + Vite app in `admin-ui/`.

```bash
# install root (gateway) dependencies
bun install

# install admin UI dependencies
cd admin-ui && bun install
```

Common scripts (run from the repo root unless noted):

| Command           | What it does                                                        |
| ----------------- | ------------------------------------------------------------------- |
| `bun run dev`     | Start the gateway with `--watch` (auto-restart on change)           |
| `bun run dev:ui`  | Start the admin UI dev server (`vite`, run from `admin-ui/`)        |
| `bun run dev:all` | Start both the gateway and admin UI together (`scripts/dev-all.ts`) |
| `bun run start`   | Start the gateway without watch mode                                |
| `bun run cli`     | Run the bundled CLI (`src/cli/index.ts`)                            |

## Running tests

Backend tests use Bun's built-in test runner. Always use `bun run test` (not bare
`bun test`, which sweeps up the admin-ui Vitest and e2e Playwright specs and fails):

```bash
bun run test
```

This should be 100% green before you open a PR. Tests live under `src/**/__tests__/`.

The admin UI has its own test suite (Vitest):

```bash
cd admin-ui && bun run test        # single run
cd admin-ui && bun run test:watch  # watch mode
```

End-to-end tests run a real browser + backend with Playwright:

```bash
bun run test:e2e        # Playwright (e2e/): smoke, MCP-protocol, auth-fail-closed
```

On top of those, the suite is kept honest with **[Stryker](https://stryker-mutator.io)
mutation testing** — it injects faults into the source and checks the tests catch them, so
coverage reflects _effectiveness_, not just line execution:

```bash
bun run test:mutate     # stryker run (config: stryker.config.mjs)
```

Mutation runs are much heavier than a normal test pass — scope them to the files you're
changing while iterating (see `stryker.config.mjs`).

## Typechecking

Backend and admin UI are typechecked separately, since they're different
TypeScript projects with different `tsconfig.json` files:

```bash
bun run typecheck                       # backend (tsc --noEmit)
cd admin-ui && bun run typecheck        # admin UI (vue-tsc -b --noEmit)
```

Both must be clean. The admin UI build (`cd admin-ui && bun run build`) is also
worth running locally before a PR touching the UI — it catches a few things
`typecheck` alone doesn't (e.g. unused Vite imports).

## Code style

ESLint and Prettier are configured at the repo root and in `admin-ui/` (separate configs,
same conventions):

```bash
bun run format          # prettier --write . (root)
bun run lint            # eslint . (root)
cd admin-ui && bun run lint   # eslint . (admin-ui, vue-eslint-parser + typescript-eslint)
```

`bun run check` (see above) runs `format:check` and both `lint` steps before typecheck/tests,
so a formatting or lint error is caught first. Beyond that:

- Match the formatting, naming, and file organization already present in the
  module you're editing rather than introducing a new personal style.
- TypeScript is strict (`strict: true`) on both the backend and admin UI — don't
  work around type errors with `any` or non-null assertions unless there's no
  reasonable alternative, and prefer narrowing/guards over casts.
- Keep modules focused: security-sensitive logic lives under `src/security/`,
  route handlers under `src/routes/`, DB access under `src/db/`.

## Database migrations

Schema changes live in `src/db/migrations.ts`, exported as an **append-only,
ordered array** of `{ id, name, sql }` objects. Rules that are load-bearing for
the migration runner:

- **Never edit or renumber an existing migration.** Once a migration has shipped
  (merged to `main`), its `id` and `sql` are frozen. Fixing a mistake means adding
  a new migration that alters/repairs the schema, not rewriting history.
- **Migrations are forward-only.** There is no down-migration mechanism — write
  the SQL defensively (e.g. `CREATE TABLE IF NOT EXISTS`, additive `ALTER TABLE`)
  and think about what happens to existing rows/databases when it runs.
- **IDs are sequential integers**, applied in ascending order. Check the tail of
  `src/db/migrations.ts` for the current highest `id` before adding a new one —
  your new migration's `id` should be the next integer after it.
- Give each migration a short, descriptive `name` (used in logs when it's applied).

## Branch & PR conventions

Commit messages in this repo follow a `type(scope): summary` convention (the
`(scope)` is optional), consistent with the git history:

- `feat: ...` / `feat(scope): ...` — new functionality
- `fix: ...` / `fix(scope): ...` — bug fixes, including hardening passes
- `docs: ...` — documentation-only changes
- `chore: ...` — tooling/config changes with no runtime behavior change
- `refactor: ...` — internal restructuring with no behavior change
- `test: ...` — test-only additions/changes

Larger changes are frequently landed as a `feat` commit followed by one or more
`fix` commits that harden it (fixing edge cases found on review). If your PR
description references priority tiers, this repo uses `[P0]`/`[P1]`/`[P2]`
suffixes (P0 = correctness/security-critical, P1 = important robustness, P2 =
polish) — feel free to use them, but they're not required.

Keep PRs scoped to one logical change. Reference the issue you discussed the
change in, if there was one.

### PR checklist

Before opening a PR, please confirm:

- [ ] `bun run check` passes — the one-shot local CI gate (format:check → root lint →
      admin-ui lint → admin-ui i18n parity → root typecheck → root tests → admin-ui typecheck →
      admin-ui tests → admin-ui build, in order). Run this before opening a PR; it's what CI actually checks.
- [ ] If `bun run check` fails, the granular commands below can help narrow down which stage:
  - [ ] `bun run test` passes (backend)
  - [ ] `bun run typecheck` passes (backend)
  - [ ] `cd admin-ui && bun run typecheck` passes (if you touched the admin UI)
  - [ ] `cd admin-ui && bun run test` passes (if you touched the admin UI)
- [ ] New/changed schema goes through a new, appended `src/db/migrations.ts` entry
      (not an edit to an existing one)
- [ ] Commit messages follow the `type(scope): summary` convention above

## Releasing

Cutting a tagged, published release (slug sweep, `bun run version:bump`, then a `v*` tag that
builds the signed GHCR image and standalone binaries) is a maintainer task with its own
runbook: see [`RELEASING.md`](RELEASING.md).
