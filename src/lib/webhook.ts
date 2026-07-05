/**
 * Shared "validate, then fetch with a timeout, never throw" dispatch mechanics
 * factored out of four independently-converged webhook notifiers:
 *   - admin/entities/approvals.ts's `notifyApproval` (operator webhook on a
 *     new approval ticket)
 *   - admin/audit/audit.ts's `streamAuditEvent` (best-effort SIEM sink)
 *   - observability/alerts.ts's `dispatchWebhook` (alert-rule webhook, the
 *     one that already carried the SSRF check every call site now shares)
 *   - observability/monitor.ts's `notifyMonitor` (synthetic-monitor webhook)
 *
 * All four: SSRF-validate the destination URL with the same check used to
 * guard proxied backend calls (`validateBackendUrl`), then POST a JSON body
 * with a hard timeout, refusing redirects. Delivery is always fire-and-forget
 * from the caller's perspective — a rejected URL or a failed fetch is logged
 * and swallowed, never thrown, so a webhook hiccup never breaks the request
 * it's describing. Each call site keeps its own payload shape and log
 * messages/context; only this validate-then-fetch mechanism is shared.
 */
import { config } from "../config.js";
import { log } from "../logger.js";
import { validateBackendUrl } from "../net/ip-validator.js";

export interface DispatchWebhookOptions {
  /** AbortSignal timeout (ms) applied to the fetch. */
  timeoutMs: number;
  /** Log message used when the destination fails SSRF validation. */
  rejectedLogMessage: string;
  /** Log message used when the fetch itself throws (network error, timeout, non-2xx is NOT treated as failure here). */
  failedLogMessage: string;
  /** Extra fields merged into both log calls (e.g. `{ rule: rule.name }`). */
  logContext?: Record<string, unknown>;
}

/**
 * Validates `url` against the SSRF blocklist (private/loopback/link-local IPs,
 * and `allowedHosts` when configured), then POSTs `payload` as JSON. Returns
 * `true` on a dispatched request, `false` on a rejected URL or delivery
 * failure — it never throws.
 */
export async function dispatchWebhook(
  url: string,
  payload: unknown,
  options: DispatchWebhookOptions,
): Promise<boolean> {
  const validation = await validateBackendUrl(url, config.allowPrivateIps, config.allowedHosts);
  if (!validation.valid) {
    log("warn", options.rejectedLogMessage, { ...options.logContext, reason: validation.reason });
    return false;
  }
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    return true;
  } catch (err) {
    log("warn", options.failedLogMessage, {
      ...options.logContext,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
