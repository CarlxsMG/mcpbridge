import { ref } from "vue";
import { api } from "./useApi";
import { toErrorMessage } from "@/utils/errors";

/** Callers decide whether/when to reload after a successful patch — unlike the hand-rolled functions this replaces, which always reloaded. */
export function usePatchResource(resourcePath: () => string | undefined) {
  const saving = ref(false);
  const error = ref("");

  async function run(action: (path: string) => Promise<unknown>, fallbackMessage: string): Promise<boolean> {
    const path = resourcePath();
    if (path === undefined) return false;
    saving.value = true;
    error.value = "";
    try {
      await action(path);
      return true;
    } catch (err) {
      error.value = toErrorMessage(err, fallbackMessage);
      return false;
    } finally {
      saving.value = false;
    }
  }

  const patchFields = (body: Record<string, unknown>, fallbackMessage: string) =>
    run((path) => api.patch(path, body), fallbackMessage);
  const patchField = (key: string, value: unknown, fallbackMessage: string) =>
    patchFields({ [key]: value }, fallbackMessage);

  return { saving, error, run, patchField, patchFields };
}
