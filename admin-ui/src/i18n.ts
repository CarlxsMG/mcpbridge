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
 * Why English-as-source-of-truth: the committed EN strings in the codebase
 * match the keys in `en.json` 1:1 (no `t()` calls in components yet during the
 * phase 0 scaffold), so flipping locale to "es" must still render identical
 * strings until extraction in later phases. If a key is missing in ES it falls
 * back to EN — surfacing real "you forgot to translate this" coverage gaps
 * instead of silently showing the raw key.
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
