import { computed, ref, type ComputedRef, type Ref } from "vue";
import { toErrorMessage, toErrorRequestId } from "@/utils/errors";

export interface ErrorState {
  /** The human-readable message. Same `Ref<string>` the composables have always exposed as `error`/`errorMessage`. */
  message: Ref<string>;
  /** Correlation id of the request behind `message`, or null when there is none to show. Pass to `<ErrorNote>`. */
  requestId: ComputedRef<string | null>;
  /** Records a thrown value: message via `toErrorMessage`, id via `toErrorRequestId`. */
  capture: (err: unknown, fallback: string) => void;
  /** Clears both. */
  clear: () => void;
}

/**
 * The error half of every load/mutate composable in this directory, which had
 * all grown the same three lines independently:
 *
 *     error.value = "";                                  // at the start
 *     error.value = toErrorMessage(err, fallback);       // in the catch
 *
 * Owning it here is what let the request correlation id be added once instead
 * of eight times (useResource, useCreateForm, useEntityForm, usePatchResource,
 * useDetailPageDelete, useConfirmAction, useClearableConfig, useFieldDraft).
 *
 * `requestId` is a computed, not a plain ref, on purpose. Several callers
 * assign to `message` directly for client-side validation failures
 * (`useCreateForm` does this with its `validate()` result), which would
 * otherwise leave the id from a *previous* API failure on screen next to an
 * unrelated message. Deriving it from "is `message` still the exact string we
 * captured the id for" makes that impossible without having to audit — or
 * constrain — every assignment site.
 */
export function useErrorState(): ErrorState {
  const message = ref("");
  const capturedId = ref<string | null>(null);
  const capturedFor = ref<string | null>(null);

  const requestId = computed(() =>
    capturedFor.value !== null && capturedFor.value === message.value ? capturedId.value : null,
  );

  function capture(err: unknown, fallback: string): void {
    message.value = toErrorMessage(err, fallback);
    capturedId.value = toErrorRequestId(err);
    capturedFor.value = message.value;
  }

  function clear(): void {
    message.value = "";
    capturedId.value = null;
    capturedFor.value = null;
  }

  return { message, requestId, capture, clear };
}
