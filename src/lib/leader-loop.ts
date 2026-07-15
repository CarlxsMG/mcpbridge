/**
 * Shared "setInterval + swallow/log errors + return a stop() function"
 * scaffold factored out of five independently-converged background loops:
 *   - observability/health.ts's `startHealthCheckLoop`
 *   - observability/alerts.ts's `startAlertLoop`
 *   - admin/entities/schedules.ts's `startScheduleLoop`
 *   - middleware/circuit-breaker.ts's `startCircuitBreakerCleanup`
 *   - middleware/rate-limiter.ts's `startRateLimiterCleanup`
 *
 * Two variants:
 *   - `startPeriodicSweep` — plain interval, no leader gating. Correct for
 *     the circuit-breaker/rate-limiter cleanup loops, which only ever touch
 *     this process's own local, uncoordinated in-memory state — every
 *     instance must sweep its own maps independently.
 *   - `startLeaderGatedInterval` — only invokes `fn` when `isLeader()` is
 *     true (see db/leader-lease.ts), for cross-instance-duplicated work
 *     (health probing, alert evaluation, schedule firing) where a
 *     horizontally-scaled deployment must do the work exactly once. Runs
 *     `fn` immediately on start, then every `intervalMs` (health.ts's
 *     documented, test-depended-on behavior — the other two loops silently
 *     lacked this and are normalized to match), and `.unref()`s its timer
 *     so it never keeps the process alive on its own (already the majority
 *     behavior among the loops being merged here).
 *
 * Both variants swallow and log any error `fn` throws/rejects with so one
 * failed run never kills subsequent ticks or crashes the process via an
 * unhandled rejection; this is a backstop only — call sites that need a
 * specific log message or metric increment on failure (e.g. health.ts's
 * `healthLoopErrorsTotal`) should still catch inside their own `fn`.
 */
import { log } from "../logger.js";
import { isLeader } from "../db/leader-lease.js";

type LoopFn = () => void | Promise<void>;

async function runSafely(fn: LoopFn, errorMessage: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log("error", errorMessage, { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Starts a plain periodic sweep over this process's own local state.
 * Not leader-gated, and does not run `fn` immediately (matches the
 * pre-existing circuit-breaker/rate-limiter cleanup behavior of waiting a
 * full interval before the first sweep). Returns a stop function.
 */
export function startPeriodicSweep(fn: LoopFn, intervalMs: number): () => void {
  const timer = setInterval(() => {
    void runSafely(fn, "Periodic sweep encountered an unhandled error");
  }, intervalMs);
  if (timer.unref) timer.unref(); // never keep the process alive on its own (parity with the gated loop)
  return () => clearInterval(timer);
}

/**
 * Starts a leader-gated periodic loop: runs `fn` immediately, then again
 * every `intervalMs`, but only when `isLeader()` is true. Returns a stop
 * function.
 */
export function startLeaderGatedInterval(fn: LoopFn, intervalMs: number): () => void {
  const tick = (): void => {
    if (!isLeader()) return;
    void runSafely(fn, "Leader-gated loop encountered an unhandled error");
  };

  tick();

  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}
