import { ref } from "vue";
import { api, ApiError } from "./useApi";
import { toolPath } from "./apiPaths";

/** Callers decide whether/when to reload after a successful patch — unlike the hand-rolled functions this replaces, which always reloaded. */
export function usePatchTool(clientName: () => string, toolName: () => string | undefined) {
  const saving = ref(false);
  const error = ref("");

  async function run(action: (path: string) => Promise<unknown>, fallbackMessage: string): Promise<boolean> {
    const tool = toolName();
    if (tool === undefined) return false;
    saving.value = true;
    error.value = "";
    try {
      await action(toolPath(clientName(), tool));
      return true;
    } catch (err) {
      error.value = err instanceof ApiError ? err.message : fallbackMessage;
      return false;
    } finally {
      saving.value = false;
    }
  }

  const patchFields = (body: Record<string, unknown>, fallbackMessage: string) =>
    run((path) => api.patch(path, body), fallbackMessage);
  const patchField = (key: string, value: unknown, fallbackMessage: string) => patchFields({ [key]: value }, fallbackMessage);
  const putTags = (tags: string[], fallbackMessage: string) =>
    run((path) => api.put(`${path}/tags`, { tags }), fallbackMessage);
  const clearQuarantine = (fallbackMessage: string) =>
    run((path) => api.post(`${path}/quarantine/clear`), fallbackMessage);

  return { saving, error, patchField, patchFields, putTags, clearQuarantine };
}
