/**
 * toolIndex — the fast canonical-key → (client, tool) lookup used by
 * `Registry.resolveTool` and the proxy/CI gates that read tool membership
 * after a name has been canonicalised through the alias index.
 *
 * Kept separate from `Registry` (where it lives as a field on the class) for
 * the same reason as `RegistryAliasIndex`: a god-class split that lets the
 * "is the tool still here?" lookup be reasoned about, initialised, and torn
 * down independently from the persistence / health / breaker concerns that
 * also live in the registry. Owned by `Registry` (constructed empty, mutated
 * on register / unregister / reconcile). The class itself is lock-free and
 * trusts the caller's `withLock(name)` serialisation contract.
 *
 * The canonical key is `${clientName}${TOOL_KEY_SEPARATOR}${toolName}` —
 * partition by client prefix is what lets `deleteForClient(name)` be a
 * single-pass prefix sweep, mirroring `RegistryAliasIndex.clearForClient`.
 */
import { TOOL_KEY_SEPARATOR, toolKey as toToolKey } from "../lib/identifier.js";

export interface ToolRef {
  clientName: string;
  toolName: string;
}

export class ToolIndex {
  private readonly byKey = new Map<string, ToolRef>();

  /** Set or replace the entry at `key`. */
  set(key: string, ref: ToolRef): void {
    this.byKey.set(key, ref);
  }

  /** Convenience: build the canonical key from name parts and set. */
  setTool(clientName: string, toolName: string): void {
    this.byKey.set(toToolKey(clientName, toolName), { clientName, toolName });
  }

  /** Returns the entry for `key`, or undefined. */
  get(key: string): ToolRef | undefined {
    return this.byKey.get(key);
  }

  /** Drop a single entry. No-op when absent. */
  delete(key: string): boolean {
    return this.byKey.delete(key);
  }

  /** Drop a single entry by name parts. No-op when absent. */
  deleteTool(clientName: string, toolName: string): boolean {
    return this.byKey.delete(toToolKey(clientName, toolName));
  }

  /**
   * Drop every entry whose key has the matching `clientName__` prefix.
   * Used on unregister / teardown for O(n) cleanup in one pass.
   */
  deleteForClient(clientName: string): number {
    const prefix = `${clientName}${TOOL_KEY_SEPARATOR}`;
    let removed = 0;
    for (const key of Array.from(this.byKey.keys())) {
      if (key.startsWith(prefix)) {
        this.byKey.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** Empty the index entirely — used by tests and reset paths. */
  clearAll(): void {
    this.byKey.clear();
  }

  /** Diagnostic size. */
  size(): number {
    return this.byKey.size;
  }
}
