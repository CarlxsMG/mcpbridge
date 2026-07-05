import { computed, type ComputedRef } from "vue";
import { useI18n } from "vue-i18n";
import { navEntries, NAV_GROUP_KEYS, type NavGroup, type NavEntry } from "../navigation";

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
