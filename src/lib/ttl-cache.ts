/**
 * Shared "fetch it, remember fetchedAt, refetch once stale" cache factored
 * out of three independently-converged implementations:
 *   - security/jwt.ts's module-level `jwksCache` (JWKS keys behind JWT_JWKS_URL)
 *   - security/oidc.ts's module-level `discoveryCache` (OIDC discovery
 *     document, additionally invalidated when the requested issuer changes —
 *     see that module's own bookkeeping around `reset()`)
 *   - backend-auth/oauth.ts's per-client `tokenCache` (outbound OAuth2 access
 *     tokens; one independent instance per client_oauth row, keyed in a Map)
 *
 * All three: hold a single value plus the timestamp it was fetched at; on
 * `get()`, return it unchanged if still within its TTL, otherwise await
 * `fetchFn` again and remember the new value/timestamp. A failed `fetchFn`
 * call (it throws) leaves any previously-cached value untouched and the
 * failure itself is never cached — callers that want a "null on failure"
 * contract (like oauth.ts) catch around `get()` themselves.
 */

export interface TtlCache<T, Arg = void> {
  /**
   * Returns the cached value if still within its TTL, otherwise awaits
   * `fetchFn(arg)`, caches the result (timestamped now), and returns it.
   * `arg` is passed straight through to `fetchFn` on a miss/refetch only —
   * it never participates in freshness checks, so callers that need
   * "invalidate when some key changes" (e.g. oidc.ts's per-issuer discovery
   * cache) handle that themselves via an explicit `reset()`.
   */
  get(arg?: Arg): Promise<T>;
  /** Clears the cached value, forcing the next `get()` to refetch regardless of age. */
  reset(): void;
}

export interface TtlCacheOptions {
  /** Injectable clock, mirroring this codebase's `__set*DepsForTesting` hooks. Defaults to `Date.now`. */
  nowFn?: () => number;
}

/**
 * Creates an independent TTL cache around `fetchFn`. `ttlMs` is either a
 * fixed duration or a function of the freshly-fetched value (e.g. oauth.ts
 * derives it from the token endpoint's `expires_in`, minus a safety skew) —
 * evaluated once per successful fetch and stored alongside that value, so a
 * later change to a *live* `ttlMs` function's inputs never retroactively
 * changes when an already-cached value goes stale.
 */
export function createTtlCache<T, Arg = void>(
  fetchFn: (arg: Arg) => Promise<T>,
  ttlMs: number | ((value: T) => number),
  opts: TtlCacheOptions = {},
): TtlCache<T, Arg> {
  const now = opts.nowFn ?? (() => Date.now());
  let cached: { value: T; fetchedAt: number; ttlMs: number } | null = null;

  return {
    async get(arg?: Arg): Promise<T> {
      const t = now();
      if (cached && t - cached.fetchedAt < cached.ttlMs) return cached.value;
      const value = await fetchFn(arg as Arg);
      cached = { value, fetchedAt: t, ttlMs: typeof ttlMs === "function" ? ttlMs(value) : ttlMs };
      return value;
    },
    reset(): void {
      cached = null;
    },
  };
}
