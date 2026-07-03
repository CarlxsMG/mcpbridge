// Flat ESLint config for the backend (src/, scripts/, e2e/). Admin-ui has its
// own eslint.config.js (Vue needs eslint-plugin-vue + vue-eslint-parser) and
// is intentionally NOT covered here — see admin-ui/eslint.config.js.
//
// This is a first lint pass on a previously-unlinted codebase: we stick to
// typescript-eslint's non-type-checked "recommended" preset (no tsconfig
// project-service wiring required — scripts/ and e2e/ aren't part of the
// root tsconfig.json's `include`, so type-aware linting would need extra
// project plumbing for little payoff at this stage) plus eslint-config-prettier
// last, so ESLint never fights Prettier over formatting.
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
      // src/transports.ts — the close error is never actionable there.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Prefixing an intentionally-unused parameter/binding with `_` is a
      // common, readable convention (e.g. Express error-handling middleware
      // signatures that must keep an unused `next`).
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  eslintConfigPrettier,
);
