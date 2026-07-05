// Flat ESLint config for the admin-ui Vue app. Kept separate from the root
// eslint.config.js because Vue needs its own parser (vue-eslint-parser,
// which in turn delegates <script setup lang="ts"> blocks to the
// typescript-eslint parser) and plugin (eslint-plugin-vue). First lint pass
// on a previously-unlinted codebase: eslint-plugin-vue's flat/recommended +
// typescript-eslint's non-type-checked recommended, with eslint-config-prettier
// last so ESLint never fights Prettier over formatting.
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import pluginVue from "eslint-plugin-vue";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["dist/**", "dist-demo/**", "node_modules/**", "coverage/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs["flat/recommended"],
  {
    files: ["src/**/*.ts", "src/**/*.vue"],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: [".vue"],
      },
      // typescript-eslint's `recommended` preset turns off core no-undef for
      // *.ts files (TS's own checker covers it more reliably), but that
      // override's `files` glob doesn't match *.vue SFCs, so without browser
      // globals here plain DOM/browser identifiers (window, document,
      // HTMLElement, ResizeObserver, ...) used inside <script> blocks would
      // false-positive as undefined.
      globals: globals.browser,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // Build / maintenance scripts (e.g. scripts/check-i18n.mjs) live outside
    // src/ — they need Node globals (console, process) and ESM dynamic import,
    // but they're plain JS/TS so they don't need the Vue parser or browser
    // globals. Separate block keeps the strict src/ rules from flagging false
    // positives in tooling.
    files: ["scripts/**/*.mjs", "scripts/**/*.ts"],
    languageOptions: {
      sourceType: "module",
      globals: { ...globals.node, console: "readonly", process: "readonly" },
    },
  },
  eslintConfigPrettier,
);
