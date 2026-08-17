/**
 * Every published docs page must carry its own meta description, and no two may
 * share one.
 *
 * This is a regression gate, not a style rule. The site shipped for months with
 * all 60 pages inheriting the single site-wide `description` from
 * `docs/.vitepress/config.mts`, which is what a search engine reads as "these
 * pages are duplicates of each other". Nothing surfaced it: VitePress happily
 * falls back, the build is green, and the only symptom is invisible — the site
 * not ranking for its own name.
 *
 * The `titleTemplate` case pins a subtler one. VitePress's `createTitleTemplate`
 * drops the suffix entirely when a page's template equals the site title, so
 * `titleTemplate: MCP REST Bridge` on a site titled "MCP REST Bridge" rendered a
 * home page whose <title> contained no brand at all. It reads like the most
 * explicit way to ask for the brand and does the exact opposite.
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";

const ROOT = join(import.meta.dir, "..", "..");
const DOCS = join(ROOT, "docs");

/** Site title, per `docs/.vitepress/config.mts` — a `titleTemplate` equal to it is the trap above. */
const SITE_TITLE = "MCP REST Bridge";

/** Build output and dependencies, not pages. */
const SKIP_DIRS = new Set(["node_modules", ".vitepress", "public"]);

/**
 * Google truncates a description around 160 characters, and anything much
 * shorter wastes the slot. The band is wide on purpose: it catches an empty or
 * runaway value, not prose it has no business judging.
 */
const MIN_LENGTH = 80;
const MAX_LENGTH = 180;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (entry.endsWith(".md")) yield full;
  }
}

/** The leading `---` block, or null when the page has no frontmatter at all. */
function frontmatter(source: string): Record<string, unknown> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!match) return null;
  const parsed: unknown = parse(match[1]!);
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
}

const pages = [...walk(DOCS)].map((file) => ({
  path: relative(ROOT, file).replace(/\\/g, "/"),
  frontmatter: frontmatter(readFileSync(file, "utf8")),
}));

describe("docs SEO", () => {
  test("the page walk found the whole site", () => {
    // A floor, so a bad SKIP_DIRS entry fails loudly instead of silently
    // scanning nothing and passing.
    expect(pages.length).toBeGreaterThan(50);
  });

  test("every page has a description of its own", () => {
    const offenders = pages
      .filter((page) => {
        const description = page.frontmatter?.description;
        return typeof description !== "string" || description.trim().length === 0;
      })
      .map((page) => page.path);

    expect(
      offenders,
      `Pages with no \`description:\` frontmatter — each would inherit the site-wide one:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  test("no two pages share a description", () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const page of pages) {
      const description = page.frontmatter?.description;
      if (typeof description !== "string") continue;
      const first = seen.get(description);
      if (first) duplicates.push(`${page.path} duplicates ${first}`);
      else seen.set(description, page.path);
    }

    expect(duplicates, `Duplicate meta descriptions:\n${duplicates.join("\n")}`).toEqual([]);
  });

  test("descriptions stay inside the length a search result shows", () => {
    const offenders = pages
      .filter((page) => {
        const description = page.frontmatter?.description;
        return typeof description === "string" && (description.length < MIN_LENGTH || description.length > MAX_LENGTH);
      })
      .map((page) => `${page.path} — ${String(page.frontmatter?.description).length} chars`);

    expect(offenders, `Descriptions outside ${MIN_LENGTH}-${MAX_LENGTH} characters:\n${offenders.join("\n")}`).toEqual(
      [],
    );
  });

  test("no page sets titleTemplate to the site title", () => {
    const offenders = pages.filter((page) => page.frontmatter?.titleTemplate === SITE_TITLE).map((page) => page.path);

    expect(
      offenders,
      `VitePress drops the suffix when titleTemplate === the site title, leaving these pages with no ` +
        `brand in <title>. Put the brand in \`title\` and set \`titleTemplate: false\`:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  test("every English page has a Spanish counterpart, and the reverse", () => {
    const all = new Set(pages.map((page) => page.path));
    const missing: string[] = [];
    for (const { path } of pages) {
      // hreflang is only emitted where the counterpart file exists (pointing at a
      // 404 makes Google drop the whole annotation cluster), so a page without one
      // silently loses its locale annotation.
      const counterpart = path.startsWith("docs/es/")
        ? `docs/${path.slice("docs/es/".length)}`
        : `docs/es/${path.slice("docs/".length)}`;
      if (!all.has(counterpart)) missing.push(`${path} has no ${counterpart}`);
    }

    expect(missing, `Pages with no locale counterpart:\n${missing.join("\n")}`).toEqual([]);
  });
});
