import { ref } from "vue";
import { useConfirmAction } from "./useConfirmAction";
import { toErrorMessage } from "@/utils/errors";

/**
 * The "click Clear -> confirm -> clear the config -> reload" flow repeated across
 * ServerDetailCanary, ServerDetailOAuth, and ServerDetailUpstreamAuth: a single
 * yes/no confirmation (see useConfirmAction) wired to whatever API call actually
 * clears the config, followed by a reload via the resource's own `load` function.
 */
export function useClearableConfig(
  loadFn: () => Promise<unknown>,
  clearFn: () => Promise<unknown>,
  fallbackMessage = "Failed to clear.",
) {
  const error = ref("");
  const { pending: pendingClear, request, cancel: cancelClear, confirm } = useConfirmAction<true>();

  function requestClear() {
    request(true);
  }

  function confirmClear() {
    return confirm(async () => {
      try {
        await clearFn();
        await loadFn();
      } catch (err) {
        error.value = toErrorMessage(err, fallbackMessage);
      }
    });
  }

  return { pendingClear, requestClear, cancelClear, confirmClear, error };
}
