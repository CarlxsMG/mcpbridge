import { ref, computed, type Ref } from "vue";
import { ApiError } from "./useApi";

/**
 * Generalizes the draft/dirty/save trio hand-rolled per-field in
 * BundleDetailPage/CompositeDetailPage (description, tools, schema, steps).
 * `dirty` compares against `source()` live (not a snapshot taken at
 * construction), so it stays correct if the source reloads out from under
 * an untouched draft. Call `sync()` after a successful reload to pull a
 * fresh value in explicitly instead.
 */
export function useDraftField<T>(
  source: () => T,
  save: (value: T) => Promise<unknown>,
  options?: { fallbackMessage?: string; isEqual?: (a: T, b: T) => boolean },
) {
  const draft = ref<T>(source()) as Ref<T>;
  const isEqual = options?.isEqual ?? ((a: T, b: T) => a === b);
  const dirty = computed(() => !isEqual(draft.value, source()));
  const saving = ref(false);
  const errorMessage = ref("");

  function sync() {
    draft.value = source();
  }

  async function commit() {
    if (!dirty.value) return;
    saving.value = true;
    errorMessage.value = "";
    try {
      await save(draft.value);
    } catch (err) {
      errorMessage.value = err instanceof ApiError ? err.message : (options?.fallbackMessage ?? "Failed to save.");
    } finally {
      saving.value = false;
    }
  }

  return { draft, dirty, saving, errorMessage, sync, commit };
}
