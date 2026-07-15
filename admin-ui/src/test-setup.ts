// Test-only environment shims. jsdom doesn't implement ResizeObserver, but
// TimeSeriesChart uses one to track its container width — stub it so mounting
// the component in tests doesn't throw "ResizeObserver is not defined".
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

// jsdom implements Blob but not URL.createObjectURL/revokeObjectURL (throws
// "Not implemented"), which utils/download.ts relies on — stub with an
// in-memory blob: URL registry so tests can call the real download code path.
if (typeof URL.createObjectURL === "undefined") {
  const objectUrls = new Map<string, Blob>();
  let nextId = 0;
  URL.createObjectURL = ((blob: Blob) => {
    const url = `blob:mock/${nextId++}`;
    objectUrls.set(url, blob);
    return url;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => {
    objectUrls.delete(url);
  }) as typeof URL.revokeObjectURL;
}

// Make vue-i18n available to component tests. We register the messages
// directly (avoiding the ESM json-import dance) and force the active locale
// to EN so tests can assert against English source strings — what component
// snapshots / `getByText` look for.
//
// `globalInjection: true` + `legacy: false` makes `t()` available globally
// inside templates, but `useI18n()` still requires the i18n instance to be
// installed via `app.use(i18n)`. We install it as a default plugin on every
// @vue/test-utils mount via the library's `config.global.plugins` API, so
// existing tests don't need to change their mount calls. Components are
// loaded by Vitest in alphabetical order; this setup file runs as a
// `setupFiles` entry BEFORE any test file, so the registration is in place
// before the first mount happens.
import { createI18n } from "vue-i18n";
import { config as vtuConfig } from "@vue/test-utils";
import en from "./locales/en.json";
import es from "./locales/es.json";

const testI18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: "en",
  fallbackLocale: "en",
  // See admin-ui/src/i18n.ts: under `legacy: false` these are the Composer-mode
  // option names that actually suppress "Not found key" console warnings —
  // `silentFallbackWarn`/`silentTranslationWarn` are legacy-mode-only and are
  // silently ignored here.
  fallbackWarn: false,
  missingWarn: false,
  messages: { en, es },
});

// Install on the global mount config. vtuConfig is the same object that
// vue-test-utils' mount() reads each call — mutating `global.plugins` once
// here applies to every subsequent mount in the test run.
const existingGlobal = vtuConfig.global.plugins ?? [];
vtuConfig.global.plugins = [...existingGlobal, testI18n];

// Also expose on globalThis so any test that wants to access the instance
// directly (e.g. for locale-switching assertions) can do so without an
// extra import.
(globalThis as Record<string, unknown>).__testI18n = testI18n;
