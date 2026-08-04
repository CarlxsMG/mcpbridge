import { ApiError } from "@/composables/useApi";
import { tk } from "@/i18n";

/**
 * Standalone version of the `err instanceof ApiError ? err.message : fallback`
 * pattern duplicated across composables (useResource, useConfirmAction) and
 * page-local catch blocks (AuditLogPage, ConfigPage, ...). ApiError messages
 * come from the backend and are safe to surface to the user; anything else
 * (network failure, thrown non-Error value) falls back to a caller-supplied
 * generic message instead of leaking implementation details.
 *
 * ── Localization ────────────────────────────────────────────────────────────
 * Every error envelope carries a stable `code` (catalogued in the backend at
 * src/routes/error-codes.ts, published at docs/guide/error-codes.md), and the
 * bundles carry an `errors.api.<CODE>` sentence for most of them. The server's
 * own `message` is English-only and always will be — it is written at the call
 * site, not in a locale bundle — so without this the app renders a Spanish
 * interface with English failures on every page.
 *
 * Codes whose message carries request-specific detail (which field failed
 * validation, which upstream refused, which tool is unknown) deliberately have
 * NO key: a generic translated sentence would be a downgrade from a precise
 * English one. Those are marked `verbatim: true` in the backend catalog, and
 * the catalog test asserts they have no key here — so the choice is recorded
 * in one place instead of being re-litigated per string.
 */
export function toErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback;
  return tk(`errors.api.${err.code}`, err.message);
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
