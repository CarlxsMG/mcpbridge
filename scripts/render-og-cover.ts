/**
 * Renders scripts/og-cover.html to docs/public/og-cover.png at exactly
 * 1200×630 — the social-share card referenced as og:image / twitter:image in
 * docs/.vitepress/config.mts.
 *
 * The card is kept as HTML (og-cover.html) rather than a hand-edited binary so
 * it stays regenerable and every string in it — the headline, the URL — is
 * grep-able. Run this after editing that file:
 *
 *   bun run og:render
 *
 * Reuses the Chromium that Playwright already vendors for the e2e suite, so it
 * needs no extra dependency. NOTE the npm script runs this under **node**, not
 * bun: Playwright's browser transport hangs when driven from Bun, so `bun
 * scripts/render-og-cover.ts` never completes — always go through `bun run
 * og:render` (or `node scripts/render-og-cover.ts`). Node 24 strips the TS
 * types natively. Waits for webfonts to finish loading before the shot,
 * otherwise the headline renders in a fallback face.
 */
import { chromium } from "playwright";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = resolve(here, "og-cover.html");
const outPath = resolve(here, "..", "docs", "public", "og-cover.png");

const WIDTH = 1200;
const HEIGHT = 630;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });
  // `load` rather than `networkidle`: the latter can hang indefinitely behind a
  // font CDN that keeps a warm connection open. We wait for fonts explicitly.
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load", timeout: 30_000 });
  // Block until the linked webfonts are ready — but never forever: if the font
  // CDN is unreachable, fall through after 10s and render with the fallback face
  // rather than hanging the whole script.
  await page.evaluate(async () => {
    await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 10_000))]);
  });
  await page.screenshot({
    path: outPath,
    clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
  });
  console.log(`[og-cover] wrote ${outPath} (${WIDTH}×${HEIGHT})`);
} finally {
  await browser.close();
}
