// Unit tests for the demo response localizer.
//
// The localizer is the single integration point between vue-i18n and the
// demo fixture layer: it walks whatever object `demoFetch()` returns and
// rewrites any `*Key` field on the response into the matching text field
// using the active locale.
//
// These tests cover the four behaviors that matter:
//   - simple swap (descriptionKey → description) when the key resolves
//   - unknown key falls back to the literal text field (no rewrite)
//   - nested detail_<field>Key rewrites the inner detail object
//   - arrays of items are recursed into
//
// Locale-switch reactivity is covered separately in useLocale.test.ts;
// here we test the resolution contract against whatever locale the active
// `i18n.global` instance is configured for.
import { describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { localize } from "../resolve";

/** Register an ad-hoc key on a specific locale message bundle. */
function registerKey(locale: "en" | "es", key: string, value: string) {
  // vue-i18n's `messages.value[locale]` is typed against the strongly-typed
  // shape built from the .json files at module load, but for test-only
  // dynamic keys we operate on an untyped deep-merge so the cast through
  // unknown is required.
  const current = (i18n.global.messages.value[locale] ?? {}) as unknown as Record<string, unknown>;
  // Walk the dotted path and set the leaf.
  const parts = key.split(".");
  const root: Record<string, unknown> = { ...current };
  let cursor = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = (cursor[parts[i]] as Record<string, unknown>) ?? {};
    cursor[parts[i]] = { ...next };
    cursor = cursor[parts[i]] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
  i18n.global.setLocaleMessage(locale, root as unknown as Parameters<typeof i18n.global.setLocaleMessage>[1]);
}

describe("demo/resolve.ts — localize()", () => {
  it("swaps descriptionKey into description when the key exists in the active locale", () => {
    const prevLocale = i18n.global.locale.value;
    try {
      registerKey("en", "__test_resolve__.hello", "Hello (EN)");
      (i18n.global.locale as unknown as { value: string }).value = "en";
      const out = localize({ descriptionKey: "__test_resolve__.hello", description: "fallback" });
      expect(out).toEqual({ description: "Hello (EN)" });
      expect("descriptionKey" in (out as object)).toBe(false);
    } finally {
      (i18n.global.locale as unknown as { value: string }).value = prevLocale;
    }
  });

  it("falls back to the literal text field when the key is missing in every locale", () => {
    const out = localize({ descriptionKey: "totally.unknown.key", description: "Hello" });
    expect(out).toEqual({ descriptionKey: "totally.unknown.key", description: "Hello" });
  });

  it("rewrites audit-log detail.<field> from detail_<field>Key", () => {
    const prevLocale = i18n.global.locale.value;
    try {
      registerKey("en", "__test_resolve__.ci", "CI (elevated)");
      (i18n.global.locale as unknown as { value: string }).value = "en";
      const out = localize({
        action: "mcpkey.create",
        detail_labelKey: "__test_resolve__.ci",
        detail: { label: "CI pipeline (elevated)" },
      });
      expect((out as { detail: { label: string } }).detail.label).toBe("CI (elevated)");
      // detail_*Key stays on the outer object — pages never read it and
      // the walker mutates detail, not the outer field.
      expect("detail_labelKey" in (out as object)).toBe(true);
    } finally {
      (i18n.global.locale as unknown as { value: string }).value = prevLocale;
    }
  });

  it("recurses through nested arrays of items (list endpoints)", () => {
    const prevLocale = i18n.global.locale.value;
    try {
      registerKey("en", "__test_resolve__.a", "AAAA");
      registerKey("en", "__test_resolve__.b", "BBBB");
      (i18n.global.locale as unknown as { value: string }).value = "en";
      const out = localize({
        items: [
          { descriptionKey: "__test_resolve__.a", description: "A-EN" },
          { descriptionKey: "__test_resolve__.b", description: "B-EN" },
        ],
      });
      expect(out).toEqual({ items: [{ description: "AAAA" }, { description: "BBBB" }] });
    } finally {
      (i18n.global.locale as unknown as { value: string }).value = prevLocale;
    }
  });

  it("is a no-op on primitives and null/undefined", () => {
    expect(localize(null)).toBe(null);
    expect(localize(undefined)).toBe(undefined);
    expect(localize("foo")).toBe("foo");
    expect(localize(42)).toBe(42);
    expect(localize(true)).toBe(true);
  });

  it("passes through objects that have no *Key fields (still recurses safely)", () => {
    const out = localize({
      items: [{ name: "foo", tags: ["read", "write"] }, { name: "bar" }],
      total: 2,
    });
    expect(out).toEqual({
      items: [{ name: "foo", tags: ["read", "write"] }, { name: "bar" }],
      total: 2,
    });
  });

  it("uses the active locale at call time, not at module load", () => {
    // Same shape, different keys per locale. The walker reads
    // `i18n.global.t` at call time, so flipping the locale ref between
    // two calls must produce different output — no caching.
    const prevLocale = i18n.global.locale.value;
    try {
      registerKey("en", "__test_locale__.dual", "EN-value");
      registerKey("es", "__test_locale__.dual", "ES-value");

      (i18n.global.locale as unknown as { value: string }).value = "en";
      expect(localize({ descriptionKey: "__test_locale__.dual", description: "fallback" })).toEqual({
        description: "EN-value",
      });

      (i18n.global.locale as unknown as { value: string }).value = "es";
      expect(localize({ descriptionKey: "__test_locale__.dual", description: "fallback" })).toEqual({
        description: "ES-value",
      });
    } finally {
      (i18n.global.locale as unknown as { value: string }).value = prevLocale;
    }
  });
});
