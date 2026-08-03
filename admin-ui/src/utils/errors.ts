import { ApiError } from "@/composables/useApi";

/**
 * Standalone version of the `err instanceof ApiError ? err.message : fallback`
 * pattern duplicated across composables (useResource, useConfirmAction) and
 * page-local catch blocks (AuditLogPage, ConfigPage, ...). ApiError messages
 * come from the backend and are safe to surface to the user; anything else
 * (network failure, thrown non-Error value) falls back to a caller-supplied
 * generic message instead of leaking implementation details.
 */
export function toErrorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * Companion to {@link toErrorMessage} for the correlation id, kept separate so
 * the message stays a clean human sentence and the id can be rendered as its
 * own copyable affordance (see `components/ui/ErrorNote.vue`) rather than
 * being concatenated into the prose.
 *
 * Returns null for anything that isn't an ApiError, and for ApiErrors raised
 * before a response existed — a network failure has no request to correlate.
 */
export function toErrorRequestId(err: unknown): string | null {
  return err instanceof ApiError ? err.requestId : null;
}
