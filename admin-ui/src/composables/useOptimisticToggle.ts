import { ref } from "vue";
import { toErrorMessage } from "@/utils/errors";
import { tk } from "@/i18n";

/**
 * Generalizes the optimistic enable/disable toggle hand-rolled across
 * Dashboard/Bundles/Composites/Schedules pages: flip the field, PATCH, and
 * revert + record a per-row error on failure. Also guards against the
 * double-click race the hand-rolled versions didn't: a toggle already in
 * flight for a given key is ignored rather than re-fired.
 */
export function useOptimisticToggle<T>(keyOf: (item: T) => PropertyKey, fallbackMessage = tk("errors.update_failed")) {
  const rowError = ref<Record<PropertyKey, string>>({});
  const pendingKeys = new Set<PropertyKey>();

  async function toggle<F extends string>(item: T, field: F & keyof T, patch: (next: boolean) => Promise<unknown>) {
    const key = keyOf(item);
    if (pendingKeys.has(key)) return;
    pendingKeys.add(key);

    const previous = item[field] as boolean;
    const next = !previous;
    (item[field] as boolean) = next; // optimistic
    delete rowError.value[key];

    try {
      await patch(next);
    } catch (err) {
      (item[field] as boolean) = previous; // revert on failure
      rowError.value[key] = toErrorMessage(err, fallbackMessage);
    } finally {
      pendingKeys.delete(key);
    }
  }

  return { rowError, toggle, isPending: (item: T) => pendingKeys.has(keyOf(item)) };
}
