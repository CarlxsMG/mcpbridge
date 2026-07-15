import { ref, computed, type Ref } from "vue";
import { useLoadState } from "./useResource";
import type { PaginatedResult } from "@/types/api";

/**
 * Generalizes the cursorStack/nextCursor/currentCursor trio hand-rolled the
 * same way in ServersPage/TracesPage/TrafficPage (prev/next pager), plus
 * AuditLogPage's simpler append-only "load more" variant — both share the
 * same fetch signature, they just differ in what happens to `items` and
 * whether a stack is involved.
 *
 * Router-query sync is deliberately left to the caller: each page's filter
 * shape differs, so `onCursorChange` is a plain callback rather than this
 * composable reaching into vue-router itself.
 */
export function useCursorPagination<T>(
  fetchPage: (cursor: string | undefined) => Promise<PaginatedResult<T>>,
  options?: { initialCursor?: string; onCursorChange?: (cursor: string | undefined) => void; fallbackMessage?: string },
) {
  const items = ref<T[]>([]) as Ref<T[]>;
  const nextCursor = ref<string | undefined>();
  const cursorStack = ref<(string | undefined)[]>([]);
  const currentCursor = ref<string | undefined>(options?.initialCursor);
  const { loading, errorMessage, run } = useLoadState(options?.fallbackMessage);

  // Split from `load` so next()/prev() can pass an explicit cursor — including
  // `undefined`, meaning "go back to the very first, cursor-less page" — without
  // tripping a default parameter. `cursor: T = x` applies `x` whenever the
  // argument is `undefined`, whether omitted or passed explicitly, so a plain
  // `load(cursor)` here would silently ignore prev()'s popped `undefined` and
  // reload the current page instead of navigating back to page one.
  async function fetchAndApply(cursor: string | undefined) {
    const result = await run(() => fetchPage(cursor));
    if (result === undefined) return;
    items.value = result.items;
    nextCursor.value = result.nextCursor;
    currentCursor.value = cursor;
  }

  async function load(cursor: string | undefined = currentCursor.value) {
    await fetchAndApply(cursor);
  }

  function reset() {
    cursorStack.value = [];
    currentCursor.value = undefined;
  }

  async function next() {
    if (!nextCursor.value) return;
    cursorStack.value.push(currentCursor.value);
    const cursor = nextCursor.value;
    options?.onCursorChange?.(cursor);
    await fetchAndApply(cursor);
  }

  async function prev() {
    if (cursorStack.value.length === 0) return;
    const cursor = cursorStack.value.pop();
    options?.onCursorChange?.(cursor);
    await fetchAndApply(cursor);
  }

  // Appends instead of replacing — AuditLogPage's "Load more" button, no cursorStack involved.
  async function loadMore() {
    if (!nextCursor.value) return;
    const cursor = nextCursor.value;
    const result = await run(() => fetchPage(cursor));
    if (result === undefined) return;
    items.value = [...items.value, ...result.items];
    nextCursor.value = result.nextCursor;
  }

  return {
    items,
    loading,
    errorMessage,
    load,
    reset,
    next,
    prev,
    loadMore,
    hasPrev: computed(() => cursorStack.value.length > 0),
    hasNext: computed(() => !!nextCursor.value),
  };
}
