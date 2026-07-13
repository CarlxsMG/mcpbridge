import { ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "./useApi";
import { useConfirmAction } from "./useConfirmAction";
import { toErrorMessage } from "@/utils/errors";

/**
 * Generalizes the delete-with-confirmation flow hand-rolled in
 * BundleDetailPage/CompositeDetailPage: request -> ConfirmDialog -> DELETE
 * -> redirect on success, or surface an error and stay put on failure.
 * `deletePath` is a getter (not a plain string) so it re-reads whatever
 * identifies the record at confirm-time rather than at setup-time.
 */
export function useDetailPageDelete(
  deletePath: () => string,
  redirectTo: string,
  fallbackMessage = "Failed to delete.",
) {
  const router = useRouter();
  const { pending: pendingDelete, request, cancel: cancelDelete, confirm } = useConfirmAction<true>();
  const deleting = ref(false);
  const deleted = ref(false);
  const error = ref("");

  function requestDelete() {
    request(true);
  }

  function confirmDelete() {
    return confirm(async () => {
      error.value = "";
      deleting.value = true;
      try {
        await api.delete(deletePath());
        deleted.value = true;
        // Best-effort redirect after a successful delete — don't await it, so a
        // navigation guard's redirect/abort can't fall into the catch below and
        // masquerade as a delete failure.
        void router.push(redirectTo);
      } catch (err) {
        error.value = toErrorMessage(err, fallbackMessage);
        deleting.value = false;
      }
    });
  }

  return { pendingDelete, requestDelete, cancelDelete, confirmDelete, deleting, deleted, error };
}

/**
 * Awaits `loadDetail()` (from useResource) and, if it landed, pulls each
 * draft field back in sync with the freshly-loaded record.
 */
export async function syncAfterLoad<T>(loadDetail: () => Promise<T | undefined>, ...syncFns: Array<() => void>) {
  const result = await loadDetail();
  if (result) {
    for (const sync of syncFns) sync();
  }
}
