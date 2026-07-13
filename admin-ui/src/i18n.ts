import { createI18n } from "vue-i18n";
import en from "./locales/en.json";
import es from "./locales/es.json";

/**
 * Locale contract:
 *   - "en" = English   (default, matches committed source strings)
 *   - "es" = Spanish
 *
 * Persistence and detection live in `composables/useLocale.ts` — this module
 * only configures the vue-i18n instance. The instance is created once at app
 * boot and shared via Vue's plugin system (`app.use(i18n)` in `main.ts`).
 *
 * Why English-as-source-of-truth: i18n extraction is complete — every user-facing
 * string across the pages/components is routed through `t()`, and both `en.json`
 * and `es.json` are fully populated, with EN as the canonical key set. Flipping the
 * locale to "es" swaps every string; if a key is missing in ES it falls back to EN
 * — surfacing real "you forgot to translate this" coverage gaps instead of silently
 * showing the raw key.
 */
export type AppLocale = "en" | "es";

export const SUPPORTED_LOCALES: ReadonlyArray<AppLocale> = ["en", "es"] as const;

export const DEFAULT_LOCALE: AppLocale = "en";

export const LOCALE_STORAGE_KEY = "mcpbridge:locale";

export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: DEFAULT_LOCALE,
  fallbackLocale: DEFAULT_LOCALE,
  // Fallback to EN when a key is missing in ES — `missing()` would log to
  // console in production builds and confuse users; silent fallback is the
  // documented vue-i18n pattern for "key present in EN, missing in ES".
  silentFallbackWarn: true,
  silentTranslationWarn: true,
  messages: {
    en,
    es,
  },
});

/**
 * Compose-time translation helper for use *outside* setup() — e.g. as a default
 * arg to a composable, or in a top-level constant. Inside `<script setup>` or
 * `<template>`, prefer `useI18n({ useScope: "global" })` so the call is
 * reactive on locale change.
 *
 * Captures the i18n instance at module load time and resolves keys via its
 * global `t`. Use this only when reactivity doesn't matter (fallback strings,
 * placeholders that never change once the app boots) — UNLESS the call itself
 * happens inside a reactive scope (a Vue `computed`/render function), in which
 * case the internal read of `i18n.global.locale` is still tracked normally and
 * the result *does* update on locale change (see e.g. widgetCatalog.ts's `get()`
 * functions, which run inside each widget's `computed()`).
 *
 * Two call shapes:
 *   - `tk(key, fallbackString)` — resolves `key`; if missing, returns
 *     `fallbackString` instead of the raw key.
 *   - `tk(key, namedParams)` — resolves `key` with vue-i18n named
 *     interpolation (`{param}` placeholders in the message), e.g.
 *     `tk("utils.cron.every_day_at", { time })`.
 */
type NamedParams = Record<string, unknown>;

export function tk(key: string): string;
export function tk(key: string, fallback: string): string;
export function tk(key: string, params: NamedParams): string;
export function tk(key: string, arg?: NamedParams | string): string {
  // vue-i18n v10 exposes `t` on the global instance once created.
  const t = (i18n as unknown as { global: { t: (k: string, arg?: NamedParams | string) => string } }).global.t;
  if (arg !== undefined && typeof arg !== "string") {
    // Named-params interpolation — no "missing key" fallback handling here;
    // the key is expected to exist (this shape is for real i18n messages, not
    // ad-hoc fallback strings).
    return t(key, arg);
  }
  // `t` returns the key itself when missing, which is what we want for the
  // "no fallback supplied" case — but we want a real fallback string when the
  // caller passed one. vue-i18n handles this via the second arg.
  const resolved = t(key, arg ?? key);
  return resolved === key && arg !== undefined ? arg : resolved;
}
