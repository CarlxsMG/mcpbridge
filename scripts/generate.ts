#!/usr/bin/env bun
/**
 * Writes every DERIVED artifact in this repo from its single source, and — with
 * `--check` — proves the committed copies still match.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 * Two kinds of content here are inherently duplicated and were both maintained
 * by hand, guarded by nothing but a comment asking politely:
 *
 *   - **Cross-package source.** admin-ui deliberately shares zero dependencies
 *     with the backend (own package.json, own build), so anything both need is
 *     copied, not imported. `connectTemplates.ts` was ~200 lines duplicated
 *     verbatim; the two copies had already diverged by one export.
 *   - **Reference docs derived from code.** The error-code tables in
 *     docs/guide/error-codes.md restate src/routes/error-codes.ts, in two
 *     languages. Hand-written, they drift the moment a code is added.
 *
 * `--check` (wired into `bun run check`) is what makes this real: a source edit
 * without a regenerate fails the build instead of shipping a stale copy. The
 * committed artifacts stay in git on purpose — they are read by humans and by
 * tools (vite, VitePress) that must not depend on a generation step having run.
 *
 * Output is run through Prettier with the repo's own config, so generated files
 * pass `format:check` like anything else. Do NOT hand-format the strings below
 * to match — let Prettier settle it.
 *
 * Usage:
 *   bun run generate           # write
 *   bun run generate --check   # compare only, non-zero exit on drift
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import prettier from "prettier";
import { ERROR_CODES, ERROR_CODE_LIST } from "../src/routes/error-codes.js";

const ROOT = join(import.meta.dir, "..");
const check = process.argv.includes("--check");

interface Artifact {
  /** Repo-relative path of the file to write. */
  path: string;
  /** Repo-relative path(s) it derives from — reported when drift is found. */
  from: string;
  build: () => string;
}

// ─── admin-ui mirror of the connect templates ───────────────────────────────

/**
 * Strips `#region backend-only` … `#endregion backend-only` blocks, so the
 * source can carry code with no browser consumer without it landing in the
 * admin-ui bundle.
 */
function stripBackendOnly(source: string): string {
  return source.replace(/^[ \t]*\/\/ #region backend-only[\s\S]*?^[ \t]*\/\/ #endregion backend-only[ \t]*\r?\n/gm, "");
}

const GENERATED_BANNER = (from: string) => `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Written by scripts/generate.ts from ${from}. Edit that file and run
 * \`bun run generate\`; \`bun run check\` fails if this copy is stale.
 *
 * It lives in git (rather than being produced at build time) because admin-ui
 * builds and type-checks as a standalone package with no view of the backend.
 */
`;

function connectTemplatesMirror(): string {
  const source = readFileSync(join(ROOT, "src", "cli", "connect-templates.ts"), "utf8");
  return GENERATED_BANNER("src/cli/connect-templates.ts") + stripBackendOnly(source);
}

// ─── Error-code reference docs ──────────────────────────────────────────────

interface DocStrings {
  frontTitle: string;
  intro: string;
  envelopeHeading: string;
  envelopeBody: string;
  tableHeading: string;
  colCode: string;
  colMeaning: string;
  footer: string;
}

function errorCodeDoc(lang: "en" | "es", s: DocStrings): string {
  const rows = ERROR_CODE_LIST.map((code) => `| \`${code}\` | ${ERROR_CODES[code][lang]} |`).join("\n");
  return `<!-- GENERATED FILE — DO NOT EDIT. Written by scripts/generate.ts from src/routes/error-codes.ts. -->

# ${s.frontTitle}

${s.intro}

## ${s.envelopeHeading}

${s.envelopeBody}

\`\`\`json
{
  "error": {
    "code": "CLIENT_NOT_FOUND",
    "message": "Client not found",
    "request_id": "01J8Z5X9WQ4H0T6C3N2K7M1P8R"
  }
}
\`\`\`

## ${s.tableHeading}

| ${s.colCode} | ${s.colMeaning} |
| --- | --- |
${rows}

${s.footer}
`;
}

const EN_DOC: DocStrings = {
  frontTitle: "Error codes",
  intro:
    "Every error this gateway returns carries a stable, machine-readable `code`. Match on the code, " +
    "not on the message: messages are written for humans, carry request-specific detail, and are " +
    "free to change. Codes are part of the API contract.",
  envelopeHeading: "The envelope",
  envelopeBody:
    "Errors share one shape across the admin API, the MCP planes and the WebSocket proxy. `request_id` " +
    "is repeated in the `X-Request-ID` response header and in the audit log, so an operator can tie a " +
    "message a user is looking at to the exact request that produced it.",
  tableHeading: "Codes",
  colCode: "Code",
  colMeaning: "Meaning",
  footer:
    "The HTTP status is deliberately not listed: several codes are emitted at more than one status. " +
    "`CLIENT_NOT_FOUND`, for instance, is the 404 for a client that does not exist **and** — by design — " +
    "the identical 404 for one that belongs to another team, so a scoped caller cannot probe for its " +
    "existence.",
};

const ES_DOC: DocStrings = {
  frontTitle: "Códigos de error",
  intro:
    "Todos los errores que devuelve la pasarela llevan un `code` estable y legible por máquina. " +
    "Actúa sobre el código, no sobre el mensaje: los mensajes están escritos para personas, llevan " +
    "detalles concretos de cada petición y pueden cambiar. Los códigos forman parte del contrato de la API.",
  envelopeHeading: "El sobre",
  envelopeBody:
    "Los errores comparten una misma forma en la API de administración, en los planos MCP y en el proxy " +
    "WebSocket. El `request_id` se repite en la cabecera de respuesta `X-Request-ID` y en el registro de " +
    "auditoría, así que puedes enlazar el mensaje que ve un usuario con la petición exacta que lo produjo.",
  tableHeading: "Códigos",
  colCode: "Código",
  colMeaning: "Significado",
  footer:
    "El estado HTTP no aparece a propósito: varios códigos se emiten con más de un estado. " +
    "`CLIENT_NOT_FOUND`, por ejemplo, es el 404 de un cliente que no existe **y** —por diseño— el 404 " +
    "idéntico de uno que pertenece a otro equipo, de forma que quien llama con ámbito de equipo no pueda " +
    "sondear su existencia.",
};

// ─── demo fixture strings inside the admin-UI locale catalogs ───────────────

/**
 * Rebuilds the `demo.fixtures.*` block of a locale catalog from
 * scripts/demo-i18n/fixtures.{en,es}.json.
 *
 * The demo build (VITE_DEMO=true) renders mock data whose user-visible strings must
 * localize like everything else, so fixtures carry `*Key` fields that demo/resolve.ts
 * swaps for text at request time — the literals live in the catalogs, not the fixture
 * modules. Keeping them in their own source file makes the set reviewable, and lets
 * `--check` catch a fixture string added to one language but not the other.
 *
 * This replaces two Python scripts (seed-demo-i18n.py / translate-demo-i18n.py) that
 * did the same job. They were the only Python in a Bun/TypeScript repo: a contributor
 * needed a Python install for a documented workflow step, nothing in `bun run check`
 * could see them, and on Windows they wrote CRLF, dirtying both catalogs with
 * line-ending churn on every run. Output here is byte-compared against theirs and is
 * semantically identical — the sole difference is that JS orders integer-like object
 * keys numerically, which JSON lookup does not care about.
 *
 * Entity ids escape `.` to `__`, mirroring admin-ui/src/demo/i18n-keys.ts, so
 * vue-i18n's nested-path walker resolves them: the tool `github.search_issues` is
 * stored as `github__search_issues` and read as
 * `t("demo.fixtures.tools.github__search_issues.description")`.
 */
type JsonObject = { [key: string]: JsonObject | string };

function readJson(path: string): JsonObject {
  return JSON.parse(readFileSync(join(ROOT, path), "utf8")) as JsonObject;
}

/** Recursively merges `overlay` into `base`, mutating `base`. */
function deepMerge(base: JsonObject, overlay: JsonObject): JsonObject {
  for (const [key, value] of Object.entries(overlay)) {
    const existing = base[key];
    if (typeof existing === "object" && typeof value === "object") deepMerge(existing, value);
    else base[key] = value;
  }
  return base;
}

function demoFixtureCatalog(locale: "en" | "es"): string {
  const catalog = readJson(`admin-ui/src/locales/${locale}.json`);
  const demo = (catalog.demo ??= {}) as JsonObject;

  // REPLACE rather than merge: fixtures.en.json is the canonical source of this key
  // namespace, so merging would strand keys whenever the namespace changes (as it did
  // when entity ids started escaping `.` to `__`). Everything outside demo.fixtures is
  // read straight back out untouched.
  demo.fixtures = structuredClone(readJson("scripts/demo-i18n/fixtures.en.json"));

  // ES then overrides the English literals it has a translation for; anything missing
  // stays English, the same visible fallback vue-i18n would apply anyway.
  if (locale === "es") deepMerge(demo.fixtures, readJson("scripts/demo-i18n/fixtures.es.json"));

  return JSON.stringify(catalog, null, 2) + "\n";
}

const artifacts: Artifact[] = [
  {
    path: join("admin-ui", "src", "utils", "connectTemplates.ts"),
    from: "src/cli/connect-templates.ts",
    build: connectTemplatesMirror,
  },
  {
    path: join("admin-ui", "src", "locales", "en.json"),
    from: "scripts/demo-i18n/fixtures.en.json",
    build: () => demoFixtureCatalog("en"),
  },
  {
    path: join("admin-ui", "src", "locales", "es.json"),
    from: "scripts/demo-i18n/fixtures.{en,es}.json",
    build: () => demoFixtureCatalog("es"),
  },
  {
    path: join("docs", "guide", "error-codes.md"),
    from: "src/routes/error-codes.ts",
    build: () => errorCodeDoc("en", EN_DOC),
  },
  {
    path: join("docs", "es", "guide", "error-codes.md"),
    from: "src/routes/error-codes.ts",
    build: () => errorCodeDoc("es", ES_DOC),
  },
];

// ─── Run ────────────────────────────────────────────────────────────────────

const prettierConfig = await prettier.resolveConfig(join(ROOT, ".prettierrc"));
const stale: string[] = [];

for (const artifact of artifacts) {
  const absolute = join(ROOT, artifact.path);
  const formatted = await prettier.format(artifact.build(), { ...prettierConfig, filepath: absolute });
  const display = relative(ROOT, absolute).replace(/\\/g, "/");

  if (check) {
    // A missing file counts as drift, same as a stale one — that is the state
    // right after someone deletes a generated artifact "to regenerate it later".
    let current: string | null;
    try {
      current = readFileSync(absolute, "utf8");
    } catch {
      current = null;
    }
    if (current !== formatted) {
      stale.push(`${display} (from ${artifact.from})`);
      console.error(`[generate] ✗ ${display} is stale`);
    } else {
      console.log(`[generate] ✓ ${display}`);
    }
  } else {
    writeFileSync(absolute, formatted);
    console.log(`[generate] wrote ${display}`);
  }
}

if (check && stale.length > 0) {
  console.error(
    `\n[generate] ${stale.length} generated file(s) out of date:\n` +
      stale.map((s) => `  - ${s}`).join("\n") +
      `\n\nRun \`bun run generate\` and commit the result. Do not edit generated files directly.`,
  );
  process.exit(1);
}

console.log(check ? "[generate] all generated files are up to date" : "[generate] done");
