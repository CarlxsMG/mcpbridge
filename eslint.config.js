// Flat ESLint config for the backend (src/, scripts/, e2e/). Admin-ui has its
// own eslint.config.js (Vue needs eslint-plugin-vue + vue-eslint-parser) and
// is intentionally NOT covered here — see admin-ui/eslint.config.js.
//
// The base pass uses typescript-eslint's non-type-checked "recommended" preset
// for everything (scripts/ and e2e/ aren't in the root tsconfig's `include`, so
// a project-wide type-aware parser would need extra plumbing). On top of that,
// the runtime src/** tree — which IS in the tsconfig — additionally gets two
// type-aware rules (no-floating-promises / no-misused-promises) as a backstop
// against a future missing `await` on this async, security-sensitive server;
// test files are excluded since they legitimately fire-and-forget. eslint-config
// -prettier stays last so ESLint never fights Prettier over formatting.
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "dist-demo/**",
      "admin-ui/**",
      "docs/**",
      "node_modules/**",
      "coverage/**",
      "data/**",
      "test-results/**",
      // .claude/ is already gitignored wholesale, but `eslint .` walks the
      // filesystem directly and doesn't consult .gitignore — without this,
      // any live git worktree checked out under .claude/worktrees/ (used by
      // parallel Workflow runs) gets swept in as a second copy of the whole
      // src/ tree, causing tsconfigRootDir ambiguity/parsing errors across
      // the entire real codebase. Same root cause as the .stryker-tmp/
      // sandbox-* entry below.
      ".claude/**",
      // .stryker-tmp/ is also gitignored, but for the same reason as above
      // ESLint doesn't consult .gitignore — a Stryker run's live sandbox
      // copy (.stryker-tmp/sandbox-*) was repeatedly getting swept in as a
      // second tsconfig root whenever `bun run lint` ran while a Stryker
      // scan was still mid-execution, producing hundreds of spurious
      // parsing errors. Previously worked around per-incident by waiting
      // for the sandbox to disappear; fixed permanently here instead.
      ".stryker-tmp/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "scripts/**/*.ts", "e2e/**/*.ts"],
    rules: {
      // The logger module (src/logger.ts) intentionally wraps console as the
      // sink for structured logs, and CLI/scripts legitimately print to
      // stdout/stderr — allow console usage repo-wide rather than sprinkling
      // per-file disables.
      "no-console": "off",
      // Best-effort cleanup (closing a transport/session on shutdown or after
      // an error) deliberately swallows failures with `catch {}` throughout
      // src/mcp/transports.ts — the close error is never actionable there.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Prefixing an intentionally-unused parameter/binding with `_` is a
      // common, readable convention (e.g. Express error-handling middleware
      // signatures that must keep an unused `next`).
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // Type-aware rules, scoped to runtime src/** only (the tree that IS in the
    // root tsconfig's `include`). Tests are excluded — they legitimately
    // fire-and-forget promises. scripts/ and e2e/ stay non-type-checked.
    files: ["src/**/*.ts"],
    ignores: ["src/**/__tests__/**", "src/**/*.test.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  eslintConfigPrettier,
);
