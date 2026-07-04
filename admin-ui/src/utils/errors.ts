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
