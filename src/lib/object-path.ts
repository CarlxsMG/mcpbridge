/**
 * Shared object dot-path helpers (read + write), the single implementation
 * behind per-tool request/response transforms (`proxy/transform.ts`), response
 * redaction (`content-filtering/redaction.ts`), response-pagination aggregation
 * (`tool-policies/pagination.ts`), and composite argument templating
 * (`admin/tool-composition/composites.ts`). These used to be three subtly
 * divergent copies; keeping one implementation means an edge-case fix reaches
 * every caller.
 *
 * Prototype-pollution safety: every segment named `__proto__`, `constructor`,
 * or `prototype` is refused — on read it yields `undefined`, on write the whole
 * operation is a no-op. Combined with the validator-level rejection at the admin
 * boundary, an operator-supplied dot-path can never walk into the prototype
 * chain and mutate `Object.prototype` for the process (a cross-tenant escape,
 * since these configs are operator/team-scoped). The guard lives in the writers
 * too, so a caller that skips validation is still safe.
 */

/** Segments that could reach the prototype chain and pollute global state. */
const UNSAFE_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/** True when a single path segment is prototype-polluting. */
export function isUnsafeSegment(segment: string): boolean {
  return UNSAFE_SEGMENTS.has(segment);
}

/** True when any `.`-separated segment of a dot-path is prototype-polluting. */
export function hasUnsafeSegment(path: string): boolean {
  return path.split(".").some(isUnsafeSegment);
}

/**
 * Reads the value at a dot-path. An empty path returns the root unchanged.
 * Array steps require an integer index (a named segment on an array yields
 * `undefined`); any prototype segment anywhere yields `undefined`.
 */
export function getByPath(root: unknown, path: string): unknown {
  if (path === "") return root;
  let node: unknown = root;
  for (const segment of path.split(".")) {
    if (node === null || node === undefined) return undefined;
    if (isUnsafeSegment(segment)) return undefined;
    if (Array.isArray(node)) {
      const idx = Number(segment);
      node = Number.isInteger(idx) ? node[idx] : undefined;
    } else if (typeof node === "object") {
      node = (node as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return node;
}

/**
 * Sets `value` at a dot-path, creating intermediate plain objects as needed
 * (an intermediate that is null / a non-object / an array is replaced with a
 * fresh object — the writers address object shapes). A no-op if any segment is
 * prototype-polluting.
 */
export function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  if (keys.some(isUnsafeSegment)) return;
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    const child = cur[k];
    if (child === null || typeof child !== "object" || Array.isArray(child)) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
}

/**
 * Deletes the value at a dot-path. A no-op if the path is absent or any segment
 * is prototype-polluting.
 */
export function removeByPath(obj: Record<string, unknown>, path: string): void {
  const keys = path.split(".");
  if (keys.some(isUnsafeSegment)) return;
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const child = cur[keys[i]];
    if (child === null || typeof child !== "object") return;
    cur = child as Record<string, unknown>;
  }
  delete cur[keys[keys.length - 1]];
}
