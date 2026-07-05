import { computed, readonly } from "vue";
import { useI18n } from "vue-i18n";
import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, SUPPORTED_LOCALES, type AppLocale, i18n } from "../i18n";

/**
 * Locale switching follow the same pattern as `useTheme.ts`:
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

// Apply the detected locale eagerly so that components rendered before any
// user's `useLocale()` call still see the correct strings. This matters for
// `<DemoRibbon />` and `<Sidebar />` which render in the same tick as `App`.
if (typeof window !== "undefined") {
  const initial = readInitialLocale();
  // vue-i18n v10 type narrowing: `locale.value` is the active locale in
  // composition-api mode. Cast through unknown to avoid the LiterealString
  // property type narrowing; the supported set is checked above.
  (i18n.global.locale as unknown as { value: AppLocale }).value = initial;
}

function isSupported(value: string): value is AppLocale {
  return (SUPPORTED_LOCALES as ReadonlyArray<string>).includes(value);
}

export function useLocale() {
  const { locale } = useI18n({ useScope: "global" });

  // `locale` from vue-i18n is a `WritableComputedRef<Locale>` — read it via
  // `locale.value` and write via assignment. Readonly-cast for consumers so
  // they go through `setLocale()` (which persists).
  const current = computed(() => locale.value as AppLocale);

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

  return {
    locale: current,
    locales: SUPPORTED_LOCALES,
    setLocale,
  };
}

// Touching `readonly` so the import survives tree-shake when only the
// value side is consumed elsewhere in the app.
export const __locale_readonly_marker = readonly;
