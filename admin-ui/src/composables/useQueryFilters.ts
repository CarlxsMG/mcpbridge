import { ref, type Ref } from "vue";
import { useRoute, useRouter } from "vue-router";

/**
 * Generalizes the "seed filter refs from route.query on mount, sync back via
 * router.replace on change/pagination" trio hand-rolled in ServersPage,
 * TracesPage and TrafficPage (AuditLogPage's simpler append-only "load more"
 * pager never writes filters to the URL at all — see useCursorPagination).
 *
 * Deliberately one-way: `filters` is seeded from the current route once, at
 * composable-creation time, and nothing here re-derives it if the route
 * changes later. That matches every existing caller — none of them re-sync
 * from browser back/forward (no `router.afterEach`/route watcher does this
 * today); back/forward just re-runs the page's own `load()` against
 * whatever `route.query` cursor was seeded on that navigation. If a future
 * page needs live back/forward resync, it should `watch(() => route.query, ...)`
 * itself and re-assign the individual filter refs — that's a per-page
 * decision, not something to bake into every consumer here.
 */
export function useQueryFilters<K extends string>(
  keys: readonly K[],
): {
  filters: Record<K, Ref<string>>;
  toQuery(extra?: Record<string, string | undefined>): Record<string, string | undefined>;
  syncUrl(extra?: Record<string, string | undefined>): void;
} {
  const route = useRoute();
  const router = useRouter();

  const filters = {} as Record<K, Ref<string>>;
  for (const key of keys) {
    const raw = route.query[key];
    filters[key] = ref(typeof raw === "string" ? raw : "");
  }

  function toQuery(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
    const query: Record<string, string | undefined> = {};
    for (const key of keys) {
      query[key] = filters[key].value.trim() || undefined;
    }
    if (extra) {
      for (const [key, value] of Object.entries(extra)) {
        query[key] = value?.trim() || undefined;
      }
    }
    return query;
  }

  function syncUrl(extra?: Record<string, string | undefined>): void {
    router.replace({ query: toQuery(extra) });
  }

  return { filters, toQuery, syncUrl };
}
