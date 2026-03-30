type CircuitState = "closed" | "open" | "half_open";

interface CircuitConfig {
  failureThreshold: number;
  resetTimeoutMs: number;
  halfOpenTimeoutMs: number;
}

const DEFAULT_CONFIG: CircuitConfig = {
  failureThreshold: 3,
  resetTimeoutMs: 30_000,
  halfOpenTimeoutMs: 5_000,
};

class CircuitBreaker {
  private state: CircuitState = "closed";
  private failureCount = 0;
  private lastFailureTime = 0;
  private config: CircuitConfig;
  private lastAccess = Date.now();

  constructor(_clientName: string, config?: Partial<CircuitConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  canRequest(): { allowed: boolean; timeout?: number } {
    this.lastAccess = Date.now();
    if (this.state === "closed") {
      return { allowed: true };
    }

    if (this.state === "open") {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.config.resetTimeoutMs) {
        this.state = "half_open";
        return { allowed: true, timeout: this.config.halfOpenTimeoutMs };
      }
      return { allowed: false };
    }

    // half_open — allow one probe
    return { allowed: true, timeout: this.config.halfOpenTimeoutMs };
  }

  recordSuccess(): void {
    this.failureCount = 0;
    this.state = "closed";
  }

  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.state === "half_open" || this.failureCount >= this.config.failureThreshold) {
      this.state = "open";
    }
  }

  getLastAccess(): number {
    return this.lastAccess;
  }

  getState(): CircuitState {
    // Re-evaluate in case timeout has elapsed
    if (this.state === "open") {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.config.resetTimeoutMs) {
        return "half_open";
      }
    }
    return this.state;
  }
}

const breakers = new Map<string, CircuitBreaker>();

export function getCircuitBreaker(clientName: string): CircuitBreaker {
  let breaker = breakers.get(clientName);
  if (!breaker) {
    breaker = new CircuitBreaker(clientName);
    breakers.set(clientName, breaker);
  }
  return breaker;
}

export function getAllCircuitStates(): Record<string, CircuitState> {
  const result: Record<string, CircuitState> = {};
  for (const [name, breaker] of breakers) {
    result[name] = breaker.getState();
  }
  return result;
}

export function removeCircuitBreaker(clientName: string): void {
  breakers.delete(clientName);
}

// Evict idle circuit breakers every 5 minutes
const BREAKER_IDLE_TTL = 5 * 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [name, breaker] of breakers) {
    if (now - breaker.getLastAccess() > BREAKER_IDLE_TTL) {
      breakers.delete(name);
    }
  }
}, BREAKER_IDLE_TTL);
