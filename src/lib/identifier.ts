/**
 * Shared identifier-shape primitives for the two distinct naming rules used
 * across this codebase. These are deliberately kept as two separate exports
 * — they validate different kinds of names for different reasons, and
 * merging them would silently loosen (or tighten) one of them.
 */

/**
 * Tool/client/backend identifier shape: lowercase-only, starts with a
 * lowercase letter or digit, then up to 62 more lowercase
 * letters/digits/hyphens/underscores (63 chars max total).
 *
 * This is the shape required for every identifier that is used as a URL path
 * segment and/or a DB/registry key — client names, tool names, bundle names,
 * composite names, ws-proxy target names, and tool-alias `displayName`s.
 * Lowercase-only and space-free so these compose safely into the
 * `client__tool` key separator and into URL segments without encoding.
 */
export const TOOL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** Tests `name` against {@link TOOL_NAME_RE}. */
export function isValidToolName(name: string): boolean {
  return TOOL_NAME_RE.test(name);
}

/**
 * Admin entity display-name shape: starts with a letter or digit (either
 * case), then up to 62 more letters/digits/spaces/hyphens/underscores (63
 * chars max total).
 *
 * This is the shape for human-facing admin entity display names (e.g. team
 * names) that are never used as URL segments or DB/registry keys directly —
 * so, unlike {@link TOOL_NAME_RE}, mixed case and interior spaces are
 * intentionally allowed. This is a deliberately different rule from
 * `TOOL_NAME_RE`, not a bug; do not conflate the two.
 */
export const ADMIN_ENTITY_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,62}$/;

/** Tests `name` against {@link ADMIN_ENTITY_NAME_RE}. */
export function isValidAdminEntityName(name: string): boolean {
  return ADMIN_ENTITY_NAME_RE.test(name);
}

/**
 * Separator between client name and tool name in the composite MCP tool
 * key (`clientName__toolName`). Two underscores are used because: (a) a
 * single underscore is permitted inside either segment by {@link TOOL_NAME_RE},
 * so a one-character boundary couldn't be unambiguously distinguished from a
 * legitimate character; (b) two underscores is visually distinctive enough to
 * surface in logs and error messages without parsing. Adjusting this would
 * silently migrate every persisted alias / bundle / install-link / override
 * — there's no migration path, only a hard cutover.
 */
export const TOOL_KEY_SEPARATOR = "__";

/** Joins `clientName` and `toolName` into the canonical MCP composite key. */
export function toolKey(clientName: string, toolName: string): string {
  return `${clientName}${TOOL_KEY_SEPARATOR}${toolName}`;
}
