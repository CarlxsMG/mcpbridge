import { ref } from "vue";
import { useRouter } from "vue-router";
import { toErrorMessage } from "@/utils/errors";
import { tk } from "@/i18n";

/**
 * Generalizes the "create-page submit cycle" hand-rolled identically across
 * the 11 New*Page.vue routes — see NewTeamPage.vue for the cleanest worked
 * example (`name`/`error`/`creating` + a `createTeam()` that clears `error`,
 * validates, sets `creating`, awaits `api.post`, `router.push`es away on
 * success, `toErrorMessage`s into `error` on failure, resets `creating` in a
 * `finally`).
 *
 * Deliberately does NOT own per-field validation (NewAlertPage's
 * `nameError`/`urlError`, NewCompositePage's `schemaError`/`stepsError`,
 * NewConsumerPage's per-field errors, ...) — same reasoning as
 * useEntityForm.ts. Two different shapes of "abort before submitting" exist
 * across the 11 pages, and they map onto two different places to put the
 * check:
 *   - A check that must abort *silently* (its own field-level ref is already
 *     rendered inline, e.g. NewCompositePage's computed `nameError` shown
 *     under the name field) — do this in the page's own wrapper function,
 *     *before* it calls `run()` at all, so `run` is never invoked.
 *   - A check that should show its message in the shared `error` paragraph
 *     (NewTeamPage's "name is required", NewAlertPage's threshold parsing)
 *     — return the message string from the `validate` callback passed to
 *     `run()`; returning null/undefined proceeds to `submit`.
 */
export function useCreateForm<T>(options: {
  /**
   * Performs the create call. Free to run side effects on success before
   * resolving (e.g. NewApiKeyPage stashes the minted secret into a local ref
   * instead of navigating away) — whatever it resolves to is what
   * `redirectTo`'s function form receives.
   */
  submit: () => Promise<T>;
  /**
   * Where to navigate after a successful submit: a static path, or a
   * function of the resolved result (e.g. a freshly created bundle's own
   * name: `(bundle) => \`/bundles/${encodeURIComponent(bundle.name)}\``).
   * Omit entirely for a page that stays put and renders its own success
   * state instead of navigating away (NewApiKeyPage).
   */
  redirectTo?: string | ((result: T) => string);
  /**
   * i18n key resolved via `tk()` for the generic "create failed" message —
   * used when the thrown error isn't an `ApiError` carrying its own
   * backend-provided message.
   */
  fallbackKey: string;
}) {
  const router = useRouter();
  const creating = ref(false);
  const error = ref("");

  async function run(validate?: () => string | null | undefined): Promise<boolean> {
    error.value = "";
    const validationError = validate?.();
    if (validationError) {
      error.value = validationError;
      return false;
    }
    creating.value = true;
    try {
      const result = await options.submit();
      if (options.redirectTo !== undefined) {
        const target = typeof options.redirectTo === "function" ? options.redirectTo(result) : options.redirectTo;
        await router.push(target);
      }
      return true;
    } catch (err) {
      error.value = toErrorMessage(err, tk(options.fallbackKey));
      return false;
    } finally {
      creating.value = false;
    }
  }

  return { creating, error, run };
}
