import { config } from "../config.js";
import { log } from "../logger.js";
import { breakerStateTransitions, breakerProbeRejected } from "../observability/metrics.js";
import { startPeriodicSweep } from "../lib/leader-loop.js";

type CircuitState = "closed" | "open" | "half_open";

export interface CircuitConfig {
  failureThreshold: number;
  resetTimeoutMs: number;
  halfOpenTimeoutMs: number;
  windowMs: number;
}

const DEFAULT_CONFIG: CircuitConfig = {
  failureThreshold: config.circuitBreakerFailureThreshold,
  resetTimeoutMs: config.circuitBreakerResetTimeoutMs,
  halfOpenTimeoutMs: config.circuitBreakerHalfOpenTimeoutMs,
  windowMs: config.circuitBreakerWindowMs,
};

class CircuitBreaker {
  private state: CircuitState = "closed";
  /** True while exactly one probe is in-flight during half_open. */
  private probeInFlight = false;
  /** Sliding window of failure timestamps within windowMs. */
  private failureTimestamps: number[] = [];
  private lastFailureTime = 0;
  private cfg: CircuitConfig;
  private lastAccess = Date.now();
  readonly clientName: string;

  constructor(clientName: string, cfg?: Partial<CircuitConfig>) {
    this.clientName = clientName;
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
  }

  canRequest(): { allowed: boolean; timeout?: number; reason?: string } {
    this.lastAccess = Date.now();

    if (this.state === "closed") {
      return { allowed: true };
    }

    if (this.state === "open") {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.cfg.resetTimeoutMs) {
        // Transition open → half_open; always reset probeInFlight before evaluating probe.
        this.state = "half_open";
        this.probeInFlight = false;
        breakerStateTransitions.inc({ client: this.clientName, from_state: "open", to_state: "half_open" });
        // Fall through to half_open handling below.
      } else {
        return { allowed: false };
      }
    }

    // half_open — admit exactly one probe atomically.
    if (this.probeInFlight) {
      breakerProbeRejected.inc({ client: this.clientName });
      return { allowed: false, reason: "Probing" };
    }
    this.probeInFlight = true;
    return { allowed: true, timeout: this.cfg.halfOpenTimeoutMs };
  }

  recordSuccess(): void {
    if (this.state === "half_open") {
      // Probe succeeded — close the breaker and clear window.
      this.failureTimestamps = [];
      this.probeInFlight = false;
      this.state = "closed";
      breakerStateTransitions.inc({ client: this.clientName, from_state: "half_open", to_state: "closed" });
      log("info", "Circuit breaker closed after successful probe", { client: this.clientName });
    }
    // In closed state, success does NOT wipe the window — failures already
    // inside the window remain relevant until they age out naturally.
  }

  recordFailure(): void {
    const now = Date.now();
    this.lastFailureTime = now;

    if (this.state === "half_open") {
      // Probe failed — go back to open immediately.
      this.probeInFlight = false;
      this.state = "open";
      breakerStateTransitions.inc({ client: this.clientName, from_state: "half_open", to_state: "open" });
      log("warn", "Circuit breaker re-opened after failed probe", { client: this.clientName });
      return;
    }

    // Append to sliding window and prune stale entries.
    this.failureTimestamps.push(now);
    this.failureTimestamps = this.failureTimestamps.filter((ts) => now - ts < this.cfg.windowMs);

    if (this.failureTimestamps.length >= this.cfg.failureThreshold) {
      this.state = "open";
      breakerStateTransitions.inc({ client: this.clientName, from_state: "closed", to_state: "open" });
      log("warn", "Circuit breaker opened", {
        client: this.clientName,
        failures: this.failureTimestamps.length,
        windowMs: this.cfg.windowMs,
      });
    }
  }

  getLastAccess(): number {
    return this.lastAccess;
  }

  /**
   * Applies admin guard overrides to an already-created breaker without
   * resetting its current state (open/half_open/failure window are
   * untouched — only the thresholds change, prospectively).
   */
  updateConfig(overrides: Partial<CircuitConfig>): void {
    this.cfg = { ...this.cfg, ...overrides };
  }

  /**
   * Returns the logical circuit state for reporting purposes.
   * Pure read — never mutates internal state. The actual open→half_open
   * transition (with probeInFlight reset) only occurs inside canRequest().
   */
  getState(): CircuitState {
    if (this.state === "open") {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.cfg.resetTimeoutMs) {
        return "half_open";
      }
    }
    return this.state;
  }
}

const breakers = new Map<string, CircuitBreaker>();

const BREAKER_IDLE_TTL = 5 * 60_000;

/**
 * Returns a circuit breaker singleton for the given client name.
 * Creates one on first access. `overrideCfg` (an admin-configured guard, if
 * any) is only applied at creation time — for an already-live breaker, use
 * `updateCircuitBreakerConfig` to apply an edited guard immediately.
 */
export function getCircuitBreaker(clientName: string, overrideCfg?: Partial<CircuitConfig>): CircuitBreaker {
  let breaker = breakers.get(clientName);
  if (!breaker) {
    breaker = new CircuitBreaker(clientName, overrideCfg);
    breakers.set(clientName, breaker);
  }
  return breaker;
}

/**
 * Propagates an admin guard edit into an already-created breaker without
 * resetting its current state. No-op if the breaker doesn't exist yet — the
 * next `getCircuitBreaker(name, overrideCfg)` call will seed it correctly.
 */
export function updateCircuitBreakerConfig(clientName: string, overrides: Partial<CircuitConfig>): void {
  breakers.get(clientName)?.updateConfig(overrides);
}

export function getAllCircuitStates(): Record<string, CircuitState> {
  const result: Record<string, CircuitState> = {};
  for (const [name, breaker] of breakers) {
    result[name] = breaker.getState();
  }
  return result;
}

const STATE_GAUGE_VALUE: Record<CircuitState, number> = {
  closed: 0,
  half_open: 1,
  open: 2,
};

/**
 * Returns per-client gauge values for Prometheus scrape snapshots.
 * 0 = closed, 1 = half_open, 2 = open.
 */
export function getAllBreakerStateGauges(): Array<{ client: string; value: number }> {
  const result: Array<{ client: string; value: number }> = [];
  for (const [name, breaker] of breakers) {
    result.push({ client: name, value: STATE_GAUGE_VALUE[breaker.getState()] });
  }
  return result;
}

/**
 * Removes the circuit breaker for a client (called on client unregistration).
 */
export function removeCircuitBreaker(clientName: string): void {
  breakers.delete(clientName);
}

/**
 * Starts the background idle-eviction loop for circuit breakers.
 * Returns a stop function; call it during graceful shutdown.
 */
export function startCircuitBreakerCleanup(): () => void {
  return startPeriodicSweep(() => {
    const now = Date.now();
    for (const [name, breaker] of breakers) {
      if (now - breaker.getLastAccess() > BREAKER_IDLE_TTL) {
        breakers.delete(name);
      }
    }
  }, BREAKER_IDLE_TTL);
}
