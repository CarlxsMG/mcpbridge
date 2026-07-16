import { ref, computed, watch, type Ref } from "vue";
import { toErrorMessage } from "@/utils/errors";

/**
 * Generalizes the draft/dirty/save trio hand-rolled per-field in
 * BundleDetailPage/CompositeDetailPage (description, tools, schema, steps).
 * `dirty` compares against `source()` live (not a snapshot taken at
 * construction), so it stays correct if the source reloads out from under
 * an untouched draft. Call `sync()` after a successful reload to pull a
 * fresh value in explicitly instead.
 *
 * `syncIfUntouched()` is the safe choice for a shared reload path where a
 * SIBLING field's save triggered the reload: it compares the draft against
 * the value it was last synced to (not the live, just-reloaded `source()`),
 * so it only overwrites the draft if the user hasn't edited it since that
 * last sync. Comparing against live `source()` instead — the seemingly
 * obvious shortcut — is wrong even on the very first load: before any data
 * has arrived, `draft` and the last-synced value both equal the same
 * pre-load default, so they still match and the sync correctly proceeds.
 */
export function useFieldDraft<T>(
  source: () => T,
  save: (value: T) => Promise<unknown>,
  options?: { fallbackMessage?: string; isEqual?: (a: T, b: T) => boolean },
) {
  const isEqual = options?.isEqual ?? ((a: T, b: T) => a === b);
  const draft = ref<T>(source()) as Ref<T>;
  const lastSynced = ref<T>(source()) as Ref<T>;
  const dirty = computed(() => !isEqual(draft.value, source()));
  const saving = ref(false);
  const errorMessage = ref("");

  function sync() {
    draft.value = source();
    lastSynced.value = draft.value;
  }

  function syncIfUntouched() {
    if (isEqual(draft.value, lastSynced.value)) sync();
  }

  async function commit() {
    if (!dirty.value) return;
    saving.value = true;
    errorMessage.value = "";
    try {
      await save(draft.value);
    } catch (err) {
      errorMessage.value = toErrorMessage(err, options?.fallbackMessage ?? "Failed to save.");
    } finally {
      saving.value = false;
    }
  }

  return { draft, dirty, saving, errorMessage, sync, syncIfUntouched, commit };
}

/**
 * Generalizes the `ref(transform(props.x)) + watch(() => props.x, v => draft.value
 * = transform(v))` pair repeated across the GuardEditorXxx.vue section components.
 * The transform lives inside the `source` getter the caller passes (e.g.
 * `usePropDraft(() => (props.redactPaths ?? []).join("\n"))`), so this stays generic.
 * Unlike `useFieldDraft`, there's no dirty/save tracking here — callers that need
 * that pair this with their own save call (e.g. `usePatchTool`).
 */
export function usePropDraft<T>(source: () => T): Ref<T> {
  const draft = ref<T>(source()) as Ref<T>;
  watch(source, (v) => {
    draft.value = v;
  });
  return draft;
}
