// Integration test: flipping the locale on the vue-i18n global MUST cause
// the very next demoFetch() response to return localized strings. This
// covers the full chain — fixture data, demo/resolve.ts walker, vue-i18n
// global — end-to-end.
//
// Note on test mechanics: we mutate `i18n.global.locale.value` directly
// rather than going through useLocale().setLocale() because the harness
// path is async and timing-sensitive in jsdom. The reactivity itself is
// covered separately in useLocale.test.ts — here we test the resolver's
// contract against whatever locale the active instance is configured for.
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { demoFetch } from "../demo";

afterEach(() => {
  (i18n.global.locale as unknown as { value: string }).value = "en";
});

interface ToolListResp {
  items: Array<{ tool: string; description: string }>;
}

interface BundleListResp {
  items: Array<{ description: string | null }>;
}

interface KeyListResp {
  items: Array<{ label: string }>;
}

interface AlertListResp {
  items: Array<{ name: string }>;
}

interface ConsumerListResp {
  items: Array<{ name: string }>;
}

interface TeamListResp {
  items: Array<{ name: string }>;
}

async function fetchIn<T>(locale: "en" | "es", path: string): Promise<T> {
  (i18n.global.locale as unknown as { value: string }).value = locale;
  return demoFetch<T>(path);
}

describe("demoFetch() — locale reactivity", () => {
  it("returns EN tool descriptions when locale is EN", async () => {
    const res = await fetchIn<ToolListResp>("en", "/admin-api/tools");
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.items[0].description.length).toBeGreaterThan(0);
    expect(res.items[0].description).not.toMatch(/^demo\.fixtures\./);
  });

  it("returns ES tool descriptions when locale flips to ES", async () => {
    const esRes = await fetchIn<ToolListResp>("es", "/admin-api/tools");
    const enRes = await fetchIn<ToolListResp>("en", "/admin-api/tools");
    // At least one tool description must differ between EN and ES — this
    // proves the walker actually swapped translations in, instead of
    // silently falling back to the literal EN fallback.
    const changed = esRes.items.some((esItem, i) => esItem.description !== enRes.items[i].description);
    expect(changed).toBe(true);
  });

  it("localizes bundle descriptions (catalog-level page)", async () => {
    const esRes = await fetchIn<BundleListResp>("es", "/admin-api/bundles");
    const enRes = await fetchIn<BundleListResp>("en", "/admin-api/bundles");
    const changedCount = esRes.items.filter((b, i) => b.description !== enRes.items[i].description).length;
    expect(changedCount).toBeGreaterThan(0);
  });

  it("localizes API key labels (consumer page)", async () => {
    const esRes = await fetchIn<KeyListResp>("es", "/admin-api/mcp-keys");
    const enRes = await fetchIn<KeyListResp>("en", "/admin-api/mcp-keys");
    // "CI pipeline (elevated)" → "Pipeline de CI (elevado)" — the most
    // obvious case the walker should handle.
    const elevatedEs = esRes.items.find((k) => k.label.includes("CI"));
    const elevatedEn = enRes.items.find((k) => k.label.includes("CI"));
    expect(elevatedEs).toBeDefined();
    expect(elevatedEn).toBeDefined();
    expect(elevatedEs!.label).not.toBe(elevatedEn!.label);
  });

  it("localizes consumer names (consumer page)", async () => {
    const esRes = await fetchIn<ConsumerListResp>("es", "/admin-api/consumers");
    const enRes = await fetchIn<ConsumerListResp>("en", "/admin-api/consumers");
    const changedCount = esRes.items.filter((b, i) => b.name !== enRes.items[i].name).length;
    expect(changedCount).toBeGreaterThan(0);
  });

  it("localizes team names (teams page)", async () => {
    const esRes = await fetchIn<TeamListResp>("es", "/admin-api/teams");
    const enRes = await fetchIn<TeamListResp>("en", "/admin-api/teams");
    // "Platform" → "Plataforma"
    const changedCount = esRes.items.filter((b, i) => b.name !== enRes.items[i].name).length;
    expect(changedCount).toBeGreaterThan(0);
  });

  it("localizes alert names (alerts page)", async () => {
    const esRes = await fetchIn<AlertListResp>("es", "/admin-api/alerts");
    const enRes = await fetchIn<AlertListResp>("en", "/admin-api/alerts");
    const changedCount = esRes.items.filter((a, i) => a.name !== enRes.items[i].name).length;
    expect(changedCount).toBeGreaterThan(0);
  });

  it("strips the descriptionKey field from the response after resolving", async () => {
    // Cast to an extended shape for the assertion — the response contract
    // shouldn't carry descriptionKey out to consumers, but we want to
    // verify the walker actually dropped it.
    const res = (await fetchIn<unknown>("es", "/admin-api/tools")) as {
      items: Array<{ description: string; descriptionKey?: string }>;
    };
    const anyLeaking = res.items.some((it) => it.descriptionKey !== undefined);
    expect(anyLeaking).toBe(false);
  });

  it("does not mutate the underlying fixture (immutability)", async () => {
    // Fetch twice — once in each locale. If the walker were mutating the
    // fixture in place, the second fetch would see the first fetch's
    // locale's text regardless of what locale was active at fetch time.
    // Both fetches returning their respective locales' text proves the
    // walker is producing fresh trees on every call.
    const a = await fetchIn<ToolListResp>("es", "/admin-api/tools");
    const b = await fetchIn<ToolListResp>("en", "/admin-api/tools");
    expect(a.items[0].description).toContain("Buscar");
    expect(b.items[0].description).toContain("Search");
  });
});
