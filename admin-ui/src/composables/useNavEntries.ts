import { computed, readonly, ref, type ComputedRef } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import {
  navEntries,
  navEntryNameForPath,
  NAV_GROUP_KEYS,
  NAV_GROUP_ORDER,
  type NavGroup,
  type NavEntry,
} from "../navigation";

/**
 * Resolves the `labelKey`/`hintKey` fields on each `NavEntry` through the
 * active vue-i18n locale so the sidebar and command palette can render
 * translated labels without each consumer re-implementing `t()` lookups.
 *
 * The router (router/index.ts) does NOT use this — it consumes `navEntries`
 * directly and only reads path/name/component/meta. Translation is purely a
 * presentation concern; routing is a structural one, and decoupling them
 * means a missing translation key never breaks navigation.
 *
 * Pass `role` (the current user's role) to filter out entries that the user
 * is not authorised to see — same logic `TheSidebar.vue` and
 * `CommandPalette.vue` were each hand-writing before.
 */
export interface ResolvedNavEntry extends NavEntry {
  label: string;
  hint: string;
}

export function useNavEntries(opts?: { role?: "admin" | string | null }) {
  const { t, locale } = useI18n({ useScope: "global" });

  const role = opts?.role ?? null;

  const entries: ComputedRef<ResolvedNavEntry[]> = computed(() =>
    navEntries
      .filter((e) => !e.meta?.role || e.meta.role === role)
      .map((e) => ({
        ...e,
        label: t(e.labelKey),
        hint: t(e.hintKey),
      })),
  );

  function groupLabel(g: Exclude<NavGroup, null>): string {
    return t(NAV_GROUP_KEYS[g]);
  }

  return { entries, groupLabel, locale };
}

// Whether the disclosure is expanded is a per-browser PREFERENCE — the same class
// of state as the theme, the density and the onboarding checklist's dismissal
// flag, and the same storage. Which entries it holds deliberately is NOT (see
// useNavDisclosure below). Keys follow the `mcpbridge:` convention
// useTheme/useDensity/useDashboardLayout use.
export const NAV_ADVANCED_STORAGE_KEY = "mcpbridge:nav:advanced-open";

function readAdvancedOpen(): boolean {
  try {
    return localStorage.getItem(NAV_ADVANCED_STORAGE_KEY) === "1";
  } catch {
    // Storage disabled (private mode) — the disclosure still works, it just
    // starts collapsed on every load.
    return false;
  }
}

export interface NavSection {
  group: Exclude<NavGroup, null>;
  label: string;
  entries: ResolvedNavEntry[];
}

/**
 * Splits the nav into what a user sees immediately and what sits behind the
 * sidebar's "Advanced" disclosure. Only TheSidebar.vue uses this — the command
 * palette deliberately keeps consuming the flat `useNavEntries()` list so every
 * page stays one Ctrl-K away no matter how the sidebar is folded.
 *
 * The split is FIXED, and that is the design decision, not a missing feature. An
 * entry is shown when either objective thing is true:
 *   - it is `core` (see NavTier in navigation.ts) — a property of the product,
 *     identical for every user;
 *   - it is the page currently open, so the nav can never fail to represent
 *     where the user is.
 *
 * There WAS a third rule: an entry the user had opened before was promoted for
 * good, remembered in localStorage. It was dropped deliberately. It made the
 * sidebar differ between two colleagues, between one person's laptop and their
 * second browser, and between a normal window and a private one — differences
 * with no visible cause, and ones a user cannot be talked through. Nothing could
 * then say "click Schedules in the sidebar": not the docs, not a support reply,
 * not a colleague pointing at their own screen. Predictability is worth more here
 * than adaptivity, because a nav's whole job is being describable.
 *
 * (The signal that would have justified adapting is "this entity already has
 * rows" — a fact about the INSTANCE, the same for everyone, and it would surface
 * a feature a teammate configured. `/admin-api/overview` returns no per-entity
 * counts, so it was never available; "visited" was a stand-in for it and quietly
 * had none of its properties. If those counts ever exist, adding that rule is a
 * different, defensible change from restoring this one.)
 *
 * What a browser DOES remember is whether the disclosure is expanded — a genuine
 * preference about how much to show, which says nothing about which pages exist.
 */
export function useNavDisclosure(opts?: { role?: "admin" | string | null }) {
  const { entries, groupLabel } = useNavEntries(opts);
  const route = useRoute();

  const advancedOpen = ref(readAdvancedOpen());

  const activeName = computed(() => navEntryNameForPath(route.path));

  function isPromoted(entry: ResolvedNavEntry): boolean {
    return entry.tier === "core" || entry.name === activeName.value;
  }

  function sectionsOf(list: ResolvedNavEntry[]): NavSection[] {
    return NAV_GROUP_ORDER.map((group) => ({
      group,
      label: groupLabel(group),
      entries: list.filter((e) => e.group === group),
    })).filter((section) => section.entries.length > 0);
  }

  const primarySections = computed(() => sectionsOf(entries.value.filter((e) => isPromoted(e))));
  const advancedSections = computed(() => sectionsOf(entries.value.filter((e) => !isPromoted(e))));
  const advancedCount = computed(() =>
    advancedSections.value.reduce((total, section) => total + section.entries.length, 0),
  );

  function toggleAdvanced(): void {
    advancedOpen.value = !advancedOpen.value;
    try {
      localStorage.setItem(NAV_ADVANCED_STORAGE_KEY, advancedOpen.value ? "1" : "0");
    } catch {
      // Storage disabled — the toggle still works for this session.
    }
  }

  return { primarySections, advancedSections, advancedCount, advancedOpen: readonly(advancedOpen), toggleAdvanced };
}
