import { ref, type Ref } from "vue";
import { toErrorMessage } from "@/utils/errors";
import { tk } from "@/i18n";

/**
 * Lowest-level building block: wraps the loading/error-message boilerplate
 * around an arbitrary async block, without committing to any particular
 * shape for what gets fetched or how it's stored.
 *
 * Most pages that fetch exactly one thing should use `useResource` below
 * instead. Reach for `useLoadState` directly when a single "load" needs to
 * populate more than one ref (e.g. two parallel requests assigned to two
 * separate refs, or conditional/stale-guarded assignment) — see
 * ApprovalsPage, KeysPage, PoliciesPage, UsagePage for real examples.
 */
export function useLoadState(fallbackMessage = tk("errors.load_failed")) {
  const loading = ref(false);
  const errorMessage = ref("");

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    loading.value = true;
    errorMessage.value = "";
    try {
      return await fn();
    } catch (err) {
      errorMessage.value = toErrorMessage(err, fallbackMessage);
      return undefined;
    } finally {
      loading.value = false;
    }
  }

  return { loading, errorMessage, run };
}

/**
 * The common case: `load()` fetches one value and stores it in `data`.
 *
 * - Previous `data` is left in place while a reload is in flight, and also
 *   left in place (stale) if a reload fails — only `errorMessage` changes.
 *   This matches the hand-rolled `try { x.value = await ... } catch {}`
 *   pattern every page used: `x` was only ever reassigned on success.
 * - `initialValue` fixes the type of `data` (e.g. `[]` for a list page,
 *   `null` for a detail page that has nothing to show before the first
 *   load resolves) so templates don't need extra null-guards beyond what
 *   the page already had.
 * - `load()` resolves to the fetched value on success or `undefined` on
 *   failure, so callers that need to know whether it actually landed (e.g.
 *   to re-sync a local draft from freshly-loaded detail) can branch on it
 *   instead of re-deriving success from `errorMessage`.
 */
export function useResource<T>(fetcher: () => Promise<T>, initialValue: T, fallbackMessage = tk("errors.load_failed")) {
  const { loading, errorMessage, run } = useLoadState(fallbackMessage);
  const data = ref(initialValue) as Ref<T>;

  async function load(): Promise<T | undefined> {
    const result = await run(fetcher);
    if (result !== undefined) data.value = result;
    return result;
  }

  return { data, loading, errorMessage, load };
}
