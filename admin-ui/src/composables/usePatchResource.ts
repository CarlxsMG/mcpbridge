import { ref } from "vue";
import { api } from "./useApi";
import { useErrorState } from "./useErrorState";

/** Callers decide whether/when to reload after a successful patch — unlike the hand-rolled functions this replaces, which always reloaded. */
export function usePatchResource(resourcePath: () => string | undefined) {
  const saving = ref(false);
  const { message: error, requestId: errorRequestId, capture, clear } = useErrorState();

  async function run(action: (path: string) => Promise<unknown>, fallbackMessage: string): Promise<boolean> {
    const path = resourcePath();
    if (path === undefined) return false;
    saving.value = true;
    clear();
    try {
      await action(path);
      return true;
    } catch (err) {
      capture(err, fallbackMessage);
      return false;
    } finally {
      saving.value = false;
    }
  }

  const patchFields = (body: Record<string, unknown>, fallbackMessage: string) =>
    run((path) => api.patch(path, body), fallbackMessage);
  const patchField = (key: string, value: unknown, fallbackMessage: string) =>
    patchFields({ [key]: value }, fallbackMessage);

  return { saving, error, errorRequestId, run, patchField, patchFields };
}
