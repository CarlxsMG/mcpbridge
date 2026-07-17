import { recordToolCall, proxyRequestDuration } from "./metrics.js";
import { recordUsage } from "./usage.js";

/**
 * Records the three terminal telemetry writes every dispatch path emits for a
 * finished tool call, in one place so their argument shapes can't drift apart:
 *   - the per-call duration histogram (proxyRequestDuration),
 *   - the aggregate tool-call counter (recordToolCall),
 *   - the per-key usage row (recordUsage).
 *
 * The duration histogram is emitted only when `method` is supplied. The
 * mock-response and response-cache short-circuits deliberately OMIT it: they
 * carry no real upstream latency, so feeding `0` into the latency histogram
 * would skew it — those paths pass no `method` and thus skip the observe, while
 * still counting the call and recording usage.
 */
export function recordCallOutcome(o: {
  client: string;
  tool: string;
  keyId: number | null;
  statusClass: string;
  isError: boolean;
  durationMs: number;
  /** Histogram method label ("MCP" / "WS" / the REST HTTP method). Omit to skip the duration histogram. */
  method?: string;
}): void {
  if (o.method !== undefined) {
    proxyRequestDuration.observe(
      { client: o.client, method: o.method, status_class: o.statusClass },
      o.durationMs / 1000,
    );
  }
  recordToolCall(o.durationMs, o.isError);
  recordUsage({
    clientName: o.client,
    toolName: o.tool,
    keyId: o.keyId,
    statusClass: o.statusClass,
    isError: o.isError,
    durationMs: o.durationMs,
  });
}
