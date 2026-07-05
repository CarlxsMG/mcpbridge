/**
 * Shared concurrency + cache-hydration helpers factored out of code that had
 * independently converged on the exact same shapes in three places:
 *   - mcp/registry.ts's `Registry.withLock` (private `locks` Map + method)
 *   - admin/tool-composition/bundles.ts's module-level `withLock` (its own
 *     comment said it "mirrors registry.ts's withLock exactly")
 *   - admin/tool-composition/composites.ts's module-level `withLock` (its own
 *     comment said it "mirrors bundles.ts")
 * All three are the identical per-key async mutex below (`createKeyedMutex`).
 *
 * `reloadLiveCache` factors out the "clear a hot-path Map and repopulate it
 * from SQLite at boot" idiom shared by bundles.ts's initBundles(),
 * composites.ts's initComposites(), and ws-proxy.ts's loadWsProxyTargets() —
 * all three: a `Map<string, T>` that starts empty, is fully (re)hydrated from
 * SQLite by a dedicated boot function, and is then read on the hot path and
 * kept in sync incrementally by admin mutations.
 *
 * mcp/registry.ts's `clients` Map deliberately does NOT use reloadLiveCache:
 * unlike the other three, it has no single "load everything from SQL at
 * boot" function — it's populated incrementally as backends call
 * register()/registerMcp(), plus an opt-in periodic reconcileFromDb() for HA
 * — so the boot-hydration idiom doesn't genuinely apply there, even though
 * its per-client withLock mutex does (see createKeyedMutex usage in
 * registry.ts). ws-proxy.ts's `targets` Map has the cache shape but no mutex
 * at all today — left that way here since adding locking there would be a
 * behavior change beyond a pure structural refactor.
 */

export interface KeyedMutex {
  /**
   * Runs `fn` exclusively with respect to any other call to `withLock` made
   * with the same `key` on this mutex: concurrent calls for the SAME key are
   * queued and run strictly one at a time, in call order. Calls for
   * different keys never block each other.
   */
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Creates an independent per-key async mutex. Used to serialise concurrent
 * admin mutations against the same named entity (a registry client, a
 * bundle, a composite) without a single global lock that would also block
 * unrelated entities.
 */
export function createKeyedMutex(): KeyedMutex {
  const locks = new Map<string, Promise<unknown>>();

  async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    const lockEntry = prev.then(() => next);
    locks.set(key, lockEntry);
    try {
      await prev;
      return await fn();
    } finally {
      release();
      // Only delete when no later waiter has replaced the entry.
      if (locks.get(key) === lockEntry) {
        locks.delete(key);
      }
    }
  }

  return { withLock };
}

/**
 * Clears `cache` and repopulates it via `populate`, returning the resulting
 * size (handy for a boot log line). `cache` remains a plain `Map` afterwards
 * — every other call site's get/set/delete/iteration is untouched; this only
 * standardises the "clear, then rebuild from SQLite" step itself.
 */
export function reloadLiveCache<K, V>(cache: Map<K, V>, populate: (cache: Map<K, V>) => void): number {
  cache.clear();
  populate(cache);
  return cache.size;
}
