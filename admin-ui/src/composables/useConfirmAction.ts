import { ref, type Ref } from "vue";
import { toErrorMessage } from "@/utils/errors";
import { i18n } from "../i18n";

/**
 * Generalizes the "click -> pending item -> ConfirmDialog -> run API call"
 * dance repeated across nearly every list/detail page. `T` is whatever
 * identifies the pending action (an id, a row object, or just `true` for
 * pages with a single yes/no confirmation and nothing else to carry).
 *
 * Error fallback strings resolve through the global i18n instance so locale
 * switches update the displayed message without re-instantiating the composable.
 */
export function useConfirmAction<T = true>() {
  const pending = ref<T | null>(null) as Ref<T | null>;
  const busy = ref(false);
  const errorMessage = ref("");

  function request(item: T) {
    errorMessage.value = "";
    pending.value = item;
  }

  function cancel() {
    pending.value = null;
  }

  async function confirm(action: (item: T) => Promise<void>) {
    if (pending.value === null) return;
    const item = pending.value;
    pending.value = null;
    busy.value = true;
    try {
      await action(item);
    } catch (err) {
      const fallback = (i18n.global.t as (key: string) => string)("errors.action_failed");
      errorMessage.value = toErrorMessage(err, fallback);
    } finally {
      busy.value = false;
    }
  }

  return { pending, busy, errorMessage, request, cancel, confirm };
}
