import { computed, readonly, watchEffect } from "vue";
import { useI18n } from "vue-i18n";
import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, SUPPORTED_LOCALES, type AppLocale, i18n } from "../i18n";

/**
 * Locale switching follows the same pattern as `useTheme.ts`:
 *   - Read the persisted locale on first access (browser localStorage),
 *   - Fall back to `navigator.language` if it matches a supported locale,
 *   - Otherwise fall back to `DEFAULT_LOCALE` ("en").
 *
 * `setLocale()` validates the requested value against `SUPPORTED_LOCALES`,
 * persists it, and updates the vue-i18n singleton. The SPA is client-side
 * routed so there's no SSR/SEO concern driving a `/es/` URL strategy; locale
 * lives entirely in localStorage.
 *
 * Components import `useLocale()` (the composable) — they should NOT import
 * `i18n` directly. Translating strings uses vue-i18n's `useI18n()` composable
 * (returns `t`, `d`, `n`, `locale`).
 */
function readInitialLocale(): AppLocale {
  if (typeof localStorage === "undefined") return DEFAULT_LOCALE;
  const stored = localStorage.getItem(LOCALE_STORAGE_KEY) as AppLocale | null;
  if (stored && (SUPPORTED_LOCALES as ReadonlyArray<string>).includes(stored)) {
    return stored;
  }
  const browser = typeof navigator !== "undefined" ? navigator.language : null;
  if (browser) {
    const lower = browser.toLowerCase();
    if (lower.startsWith("es")) return "es";
  }
  return DEFAULT_LOCALE;
}

function isSupported(value: string): value is AppLocale {
  return (SUPPORTED_LOCALES as ReadonlyArray<string>).includes(value);
}

// Apply the detected locale eagerly so that components rendered before any
// user's `useLocale()` call still see the correct strings. This matters for
// `<DemoRibbon />` and `<Sidebar />` which render in the same tick as `App`.
// Also sync `document.documentElement.lang` here so screen readers / search
// engines / browser UI (e.g. translate-this-page prompts) see the right locale
// from the very first paint, not just after the user clicks the switcher.
if (typeof window !== "undefined") {
  const initial = readInitialLocale();
  // vue-i18n v10 type narrowing: `locale.value` is the active locale in
  // composition-api mode. Cast through unknown to avoid the LiteralString
  // property type narrowing; the supported set is checked above.
  (i18n.global.locale as unknown as { value: AppLocale }).value = initial;
  document.documentElement.lang = initial;
}

export function useLocale() {
  const { locale } = useI18n({ useScope: "global" });

  // Always re-derive the current locale from localStorage on call, so a test
  // or another tab that wrote the key after module load still sees the right
  // value. Cheap (one localStorage read) and keeps `locale` as the single
  // source of truth via vue-i18n's ref.
  const current = computed(() => {
    if (typeof localStorage !== "undefined") {
      const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
      if (stored && isSupported(stored)) return stored;
    }
    return locale.value as AppLocale;
  });

  function setLocale(next: AppLocale): void {
    if (!isSupported(next)) return;
    locale.value = next;
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    }
    if (typeof document !== "undefined") {
      document.documentElement.lang = next;
    }
  }

  // Mirror vue-i18n's locale into the <html lang> attribute as a safety net
  // for any code path that mutates it directly without going through
  // `setLocale` (currently none in the codebase, but future-proof).
  if (typeof document !== "undefined") {
    watchEffect(() => {
      document.documentElement.lang = current.value;
    });
  }

  return {
    locale: current,
    locales: SUPPORTED_LOCALES,
    setLocale,
  };
}

// Touching `readonly` so the import survives tree-shake when only the
// value side is consumed elsewhere in the app.
export const __locale_readonly_marker = readonly;
