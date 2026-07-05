/**
 * Pure, dependency-free structural diff over two config documents — extracted
 * out of config-versions.ts so the CLI (src/cli/) can import it without
 * dragging in getDb()/config-io.ts/registry.ts. No imports at all here on
 * purpose: this file must stay safe to load from a process that never opens
 * the SQLite DB.
 */

export interface ConfigDiffEntry {
  path: string;
  kind: "added" | "removed" | "changed";
  before: unknown;
  after: unknown;
}

/**
 * Canonicalizes a config document so index/key ordering can't produce spurious
 * diffs: object keys are sorted, and arrays whose elements all carry a `name`
 * are sorted by it (clients / bundles / alertRules / tools).
 */
function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) {
    const arr = v.map(canonicalize);
    if (
      arr.length > 0 &&
      arr.every((x) => x !== null && typeof x === "object" && "name" in (x as Record<string, unknown>))
    ) {
      arr.sort((a, b) => String((a as { name: unknown }).name).localeCompare(String((b as { name: unknown }).name)));
    }
    return arr;
  }
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort())
      out[k] = canonicalize((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

function walk(a: unknown, b: unknown, path: string[], out: ConfigDiffEntry[]): void {
  if (a === b) return;
  const aIsObj = a !== null && typeof a === "object";
  const bIsObj = b !== null && typeof b === "object";
  if (!aIsObj || !bIsObj) {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    const kind: ConfigDiffEntry["kind"] = a === undefined ? "added" : b === undefined ? "removed" : "changed";
    out.push({ path: path.join(".") || "(root)", kind, before: a, after: b });
    return;
  }
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  for (const k of keys) {
    walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], [...path, k], out);
  }
}

/** Structured leaf-level diff between two config documents (order-insensitive). */
export function diffConfigs(a: unknown, b: unknown): ConfigDiffEntry[] {
  const out: ConfigDiffEntry[] = [];
  walk(canonicalize(a), canonicalize(b), [], out);
  return out;
}
