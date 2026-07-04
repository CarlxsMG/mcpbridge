import { api } from "./useApi";
import { toolPath } from "@/utils/apiPaths";
import { usePatchResource } from "./usePatchResource";

/** Callers decide whether/when to reload after a successful patch — unlike the hand-rolled functions this replaces, which always reloaded. */
export function usePatchTool(clientName: () => string, toolName: () => string | undefined) {
  const resource = usePatchResource(() => {
    const tool = toolName();
    return tool === undefined ? undefined : toolPath(clientName(), tool);
  });

  const putTags = (tags: string[], fallbackMessage: string) =>
    resource.run((path) => api.put(`${path}/tags`, { tags }), fallbackMessage);
  const clearQuarantine = (fallbackMessage: string) =>
    resource.run((path) => api.post(`${path}/quarantine/clear`), fallbackMessage);

  return { ...resource, putTags, clearQuarantine };
}
