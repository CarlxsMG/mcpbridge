/**
 * Display-name alias index for the live registry.
 *
 * MCP callers see tools under composite `clientName__toolName` keys. With
 * per-tool display-name overrides, an advertised name might be a non-canonical
 * alias that must transparently resolve back to the canonical key the rest of
 * the gate stack (scope, key, bundle membership, proxyToolCall) operates on.
 *
 * This module owns ONLY that map + the three operations that keep it in
 * lockstep with the rest of the registry on register / unregister /
 * tool-override. It deliberately knows nothing about SQLite, sessions,
 * breakers, or any other persistent state — it is a pure in-memory index
 * populated and torn down by `Registry`. Kept in lockstep with `toolIndex`
 * exactly the same way Registry has always done it; the change from the
 * pre-extraction version is purely structural.
 *
 * Invariant: every alias key has the prefix `${clientName}__`, so cross-
 * client aliases can NEVER collide (the `__` separator is also used by
 * `toolIndex`, ensuring both structures use the same partitioning). The
 * canonical key is always the tool's real name, regardless of whether any
 * alias points at it.
 */
import { TOOL_KEY_SEPARATOR } from "../lib/identifier.js";
import type { RegisteredTool } from "./types.js";

/**
 * Keeps every display-name alias for every client up-to-date in one in-memory
 * Map. Constructed empty; entries are added by `rebuildForClient` /
 * `setAlias`, removed by `clearForClient` and `reset`.
 *
 * Thread-safety: the caller (Registry) wraps all mutating operations in
 * `withLock(name)` so concurrent registrations of the same client are
 * serialised; different clients run in parallel. The class itself is
 * lock-free and trusts that contract.
 */
export class RegistryAliasIndex {
  /** Advertised alias → canonical `${clientName}__toolName}` key. */
  private readonly byAdvertised = new Map<string, string>();

  /** Rebuilds all alias entries for a client from its freshly-registered tool list. */
  rebuildForClient(clientName: string, tools: readonly RegisteredTool[]): void {
    this.clearForClient(clientName);
    for (const tool of tools) {
      const dn = tool.override?.displayName;
      if (dn) this.setAlias(clientName, tool.name, dn);
    }
  }

  /**
   * Drops every alias entry belonging to a client. Only advertised keys with
   * the `clientName__` prefix are removed; structural lookups under canonical
   * keys that happen to share a substring with the prefix are left alone.
   */
  clearForClient(clientName: string): void {
    const prefix = `${clientName}${TOOL_KEY_SEPARATOR}`;
    for (const alias of this.byAdvertised.keys()) {
      if (alias.startsWith(prefix)) this.byAdvertised.delete(alias);
    }
  }

  /**
   * Removes any existing alias for one tool, then (re)adds it when a
   * displayName is set. Aliasing a tool to its own name is a no-op by design
   * (the alias key would equal the canonical key, so we'd be overwriting a
   * non-existent entry with itself).
   */
  setAlias(clientName: string, toolName: string, displayName: string | undefined): void {
    const canonical = `${clientName}${TOOL_KEY_SEPARATOR}${toolName}`;
    for (const [alias, target] of this.byAdvertised) {
      if (target === canonical) this.byAdvertised.delete(alias);
    }
    if (displayName && displayName !== toolName) {
      this.byAdvertised.set(`${clientName}${TOOL_KEY_SEPARATOR}${displayName}`, canonical);
    }
  }

  /**
   * Translates an advertised tool name (possibly an alias) to its canonical
   * `clientName__toolName`. A non-alias name is returned unchanged so callers
   * can pass either form. Used at the single MCP call entry point so every
   * downstream check operates on the canonical identity.
   */
  resolve(name: string): string {
    return this.byAdvertised.get(name) ?? name;
  }

  /** Empty the index entirely — used by tests and reset paths. */
  clearAll(): void {
    this.byAdvertised.clear();
  }

  /** Diagnostic — number of active alias entries across all clients. */
  size(): number {
    return this.byAdvertised.size;
  }
}
