import { useConfirmAction } from "./useConfirmAction";
import { useErrorState } from "./useErrorState";
import { tk } from "@/i18n";

/**
 * The "click Clear -> confirm -> clear the config -> reload" flow repeated across
 * ServerDetailCanary, ServerDetailOAuth, and ServerDetailUpstreamAuth: a single
 * yes/no confirmation (see useConfirmAction) wired to whatever API call actually
 * clears the config, followed by a reload via the resource's own `load` function.
 */
export function useClearableConfig(
  loadFn: () => Promise<unknown>,
  clearFn: () => Promise<unknown>,
  fallbackMessage = tk("errors.clear_failed"),
) {
  const { message: error, requestId: errorRequestId, capture } = useErrorState();
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
        capture(err, fallbackMessage);
      }
    });
  }

  return { pendingClear, requestClear, cancelClear, confirmClear, error, errorRequestId };
}
