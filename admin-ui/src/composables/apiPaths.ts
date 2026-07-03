/**
 * Centralized /admin-api path builders. Existing pages hand-type
 * `/admin-api/clients/${encodeURIComponent(props.name)}/...` at 42+ call
 * sites — every one of those independently has to remember to encode the
 * name/tool segment but NOT the fixed literals ("tools", "tags",
 * "quarantine/clear", ...) that follow it. Centralizing that here means the
 * encoding rule only has to be right once.
 */

function resourcePath(base: string, name: string, ...segments: string[]): string {
  return [`/admin-api/${base}/${encodeURIComponent(name)}`, ...segments].join("/");
}

export const clientPath = (name: string, ...segments: string[]) => resourcePath("clients", name, ...segments);

export const toolPath = (name: string, tool: string, ...segments: string[]) =>
  clientPath(name, "tools", encodeURIComponent(tool), ...segments);

export const bundlePath = (name: string, ...segments: string[]) => resourcePath("bundles", name, ...segments);

export const compositePath = (name: string, ...segments: string[]) => resourcePath("composites", name, ...segments);
