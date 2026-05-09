import Ajv from "ajv";
import addFormats from "ajv-formats";
import { registry } from "./registry.js";
import { config } from "./config.js";
import { log } from "./logger.js";
import { getCircuitBreaker } from "./circuit-breaker.js";
import { recordToolCall } from "./routes/metrics.js";
import {
  proxyBodyCapRejections,
  proxyRetryAttempts,
  proxyRequestDuration,
} from "./observability/metrics.js";
import { refreshPinIfStale } from "./security/ip-validator.js";
import type { PinnedIp } from "./security/ip-validator.js";
import { isDeleting } from "./registry.js";

// ---------------------------------------------------------------------------
// Ajv singleton — shared across all tool calls
// ---------------------------------------------------------------------------
const ajv = new Ajv({
  allErrors: false,       // first error is enough for tool calls
  strict: false,           // tolerate vendor extensions in JSON Schema
  removeAdditional: "all", // strip unknown keys (replicates prior manual behaviour)
  useDefaults: true,       // apply defaults if specified in schema
  coerceTypes: false,      // do NOT auto-coerce — surface real type errors
});
addFormats(ajv);

// Cache compiled validators per client+tool key (stable for the lifetime of a registration).
const validatorCache = new Map<string, ReturnType<typeof ajv.compile>>();

function getOrCompile(
  clientName: string,
  toolName: string,
  schema: Record<string, unknown>
): ReturnType<typeof ajv.compile> {
  const key = `${clientName}::${toolName}`;
  let validate = validatorCache.get(key);
  if (!validate) {
    validate = ajv.compile(schema);
    validatorCache.set(key, validate);
  }
  return validate;
}

// ---------------------------------------------------------------------------
// TTL-based pinned IP cache — module-level Map keyed on client name
// ---------------------------------------------------------------------------
const pinnedIpCache = new Map<string, PinnedIp>();

// Track in-flight requests per client for cancellation
const inflightControllers = new Map<string, Set<AbortController>>();

function trackRequest(clientName: string): AbortController {
  const controller = new AbortController();
  if (!inflightControllers.has(clientName)) {
    inflightControllers.set(clientName, new Set());
  }
  inflightControllers.get(clientName)!.add(controller);
  return controller;
}

function untrackRequest(clientName: string, controller: AbortController): void {
  inflightControllers.get(clientName)?.delete(controller);
}

export function abortClientRequests(clientName: string): void {
  const controllers = inflightControllers.get(clientName);
  if (controllers) {
    for (const ctrl of controllers) {
      ctrl.abort();
    }
    controllers.clear();
  }
}

/**
 * Parse a Retry-After header value into a wait duration in milliseconds.
 * Handles both integer-seconds ("120") and HTTP-date ("Wed, 21 Oct 2025 07:28:00 GMT") forms.
 * Returns null when the value cannot be parsed or exceeds `config.retryAfterMaxMs`.
 */
function parseRetryAfter(headerValue: string | null): number | null {
  if (!headerValue) return null;

  // 1) Integer seconds form
  const seconds = parseInt(headerValue, 10);
  if (Number.isFinite(seconds)) {
    const ms = seconds * 1000;
    if (ms >= 0 && ms <= config.retryAfterMaxMs) return ms;
    return null;
  }

  // 2) HTTP-date form
  const dateMs = Date.parse(headerValue);
  if (!isNaN(dateMs)) {
    const ms = dateMs - Date.now();
    if (ms >= 0 && ms <= config.retryAfterMaxMs) return ms;
    return null;
  }

  return null;
}

function httpStatusClass(status: number): string {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  return "5xx";
}

/**
 * Read the response body as a stream, enforcing `config.maxResponseBytes`.
 * Returns the raw text on success, or null when the limit is exceeded (after cancelling the reader).
 */
async function readBodyWithCap(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) {
    // Fallback for environments where body is not a ReadableStream
    return response.text();
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      totalBytes += value.byteLength;
      if (totalBytes > config.maxResponseBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

export async function proxyToolCall(
  mcpToolName: string,
  args: Record<string, unknown> = {}
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const resolved = registry.resolveTool(mcpToolName);

  if (resolved === undefined) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${mcpToolName}` }],
      isError: true,
    };
  }

  const { client, tool } = resolved;

  if (isDeleting(client.name)) {
    return {
      isError: true,
      content: [{ type: "text", text: "Client is being unregistered" }],
    };
  }

  if (client.status === "unreachable") {
    return {
      content: [{ type: "text", text: `Client '${client.name}' is unreachable` }],
      isError: true,
    };
  }

  // Circuit breaker check
  const breaker = getCircuitBreaker(client.name);
  const circuitCheck = breaker.canRequest();
  if (!circuitCheck.allowed) {
    return {
      content: [{ type: "text", text: `Circuit breaker OPEN for client '${client.name}' — failing fast` }],
      isError: true,
    };
  }

  // Use shorter timeout if half-open probe
  const effectiveTimeout = circuitCheck.timeout ?? config.toolCallTimeoutMs;

  // Build URL with path param substitution
  const remainingArgs = { ...args };
  const resolvedPath = tool.endpoint.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, paramName) => {
    const value = remainingArgs[paramName];
    if (value !== undefined) {
      delete remainingArgs[paramName];
      return encodeURIComponent(String(value));
    }
    return `:${paramName}`;
  });

  // Fix 2 — Path traversal rejection post-substitution.
  // Check the resolved path segments for ".." or "." after decoding.
  // This catches endpoint templates that themselves contain traversal segments
  // (e.g. "/users/:id/../admin") since encodeURIComponent never encodes "/".
  // Note: encodeURIComponent applied to arg values cannot introduce "/" so a user
  // supplying id="../admin" produces the safe literal segment "..%2Fadmin" —
  // the real threat is the operator-supplied template containing ".." directly.
  {
    const pathToCheck = resolvedPath.split("?")[0]; // strip any inline query string
    const segments = pathToCheck.split("/");
    for (const seg of segments) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(seg);
      } catch {
        decoded = seg;
      }
      if (decoded === ".." || decoded === ".") {
        return {
          content: [{ type: "text", text: "Tool endpoint resolved to invalid path" }],
          isError: true,
        };
      }
    }
  }

  // Validate args against inputSchema via Ajv (handles enum, format, null, nested objects, etc.)
  // removeAdditional:"all" on the Ajv instance means unknown keys are stripped from remainingArgs.
  {
    const validate = getOrCompile(client.name, tool.name, tool.inputSchema);
    const valid = validate(remainingArgs);
    if (!valid) {
      const firstError = validate.errors?.[0];
      return {
        isError: true,
        content: [{
          type: "text",
          text: `Argument validation failed: ${firstError ? `${firstError.instancePath || "/"}: ${firstError.message}` : "unknown error"}`,
        }],
      };
    }
  }

  // Build URL with pinned IP to prevent DNS rebinding.
  // Periodically re-resolve via TTL cache to mitigate IP-pin TOCTOU.
  const parsedBase = new URL(`${client.base_url}${resolvedPath}`);
  const originalHost = parsedBase.host;
  const hostname = parsedBase.hostname;

  // Seed the pin cache from the registry value on first access.
  if (!pinnedIpCache.has(client.name)) {
    pinnedIpCache.set(client.name, { ip: client.resolved_ip, resolvedAt: Date.now() });
  }

  let pin = pinnedIpCache.get(client.name)!;

  // Only attempt re-resolution for hostnames (not raw IP literals).
  const isRawIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith("[") || hostname.includes(":");
  if (!isRawIp) {
    try {
      pin = await refreshPinIfStale(hostname, pin);
      pinnedIpCache.set(client.name, pin);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `Backend hostname now resolves to private IP: ${reason}` }],
      };
    }
  }

  parsedBase.hostname = pin.ip;
  let url = parsedBase.toString();

  const method = tool.method.toUpperCase();
  let body: string | undefined;

  if (isDeleting(client.name)) {
    return {
      isError: true,
      content: [{ type: "text", text: "Client is being unregistered" }],
    };
  }

  const reqController = trackRequest(client.name);

  if (method === "GET" || method === "DELETE") {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(remainingArgs)) {
      params.append(key, String(value));
    }
    const queryString = params.toString();
    if (queryString) {
      url = `${url}?${queryString}`;
    }
  } else {
    body = JSON.stringify(remainingArgs);
  }

  const startTime = Date.now();

  // GET / HEAD / OPTIONS are always retried.
  // DELETE / PUT are only retried when the client opts in via retry_non_safe_methods.
  const alwaysSafe = method === "GET" || method === "HEAD" || method === "OPTIONS";
  const optedIn = client.retry_non_safe_methods === true && (method === "DELETE" || method === "PUT");
  const isIdempotent = alwaysSafe || optedIn;

  const RETRYABLE_STATUSES = new Set([408, 429, 502, 503, 504]);
  const MAX_RETRIES = config.retryMaxAttempts;
  const BASE_DELAY = config.retryBaseDelayMs;

  let lastError: string | undefined;
  let lastStatus: number | undefined;

  try {
  for (let attempt = 0; attempt <= (isIdempotent ? MAX_RETRIES : 0); attempt++) {
    if (attempt > 0) {
      // Don't retry if circuit is now open
      if (!breaker.canRequest().allowed) break;
      const delay = BASE_DELAY * Math.pow(2, attempt - 1) + Math.random() * BASE_DELAY;
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    // A1: build a fresh composed signal per attempt so the timeout is renewed each time.
    // reqController.signal stays persistent (external client cancellation).
    const attemptSignal = AbortSignal.any([reqController.signal, AbortSignal.timeout(effectiveTimeout)]);

    const fetchOptions: RequestInit = body !== undefined
      ? { method, headers: { "Content-Type": "application/json", "Host": originalHost }, body, redirect: "error" as RequestRedirect, signal: attemptSignal }
      : { method, headers: { "Content-Type": "application/json", "Host": originalHost }, redirect: "error" as RequestRedirect, signal: attemptSignal };

    try {
      const response = await fetch(url, fetchOptions);

      if (response.ok) {
        breaker.recordSuccess();

        // A2: read body with streaming cap
        const rawText = await readBodyWithCap(response);
        if (rawText === null) {
          proxyBodyCapRejections.inc({ client: client.name });
          log("warn", "Upstream response exceeded size limit", { tool: mcpToolName, client: client.name, limit: config.maxResponseBytes });
          recordToolCall(Date.now() - startTime, true);
          proxyRequestDuration.observe({ client: client.name, method, status_class: "2xx" }, (Date.now() - startTime) / 1000);
          return {
            isError: true,
            content: [{ type: "text", text: "Upstream response exceeded MAX_RESPONSE_BYTES limit" }],
          };
        }

        const durationSuccess = (Date.now() - startTime) / 1000;
        proxyRequestDuration.observe({ client: client.name, method, status_class: "2xx" }, durationSuccess);
        if (attempt > 0) {
          proxyRetryAttempts.inc({ client: client.name, method, outcome: "success" });
        }
        log("info", "Tool call succeeded", { tool: mcpToolName, client: client.name, status: response.status, duration_ms: Date.now() - startTime, attempts: attempt + 1 });
        recordToolCall(Date.now() - startTime, false);

        // Fix 1 — Response header allowlist (no-op confirmation).
        // Only `content-type` is read internally to format the body; no upstream
        // response headers (Set-Cookie, Authorization, WWW-Authenticate, etc.) are
        // forwarded to the MCP caller. The return value carries only the body text,
        // so sensitive headers cannot leak through this code path.
        // Safe-to-forward allowlist (for future reference if headers are ever added):
        //   content-type, content-length, content-encoding, content-language,
        //   cache-control, etag, last-modified, retry-after
        const contentType = response.headers.get("content-type") ?? "";
        let responseText = rawText;
        if (contentType.includes("application/json")) {
          try {
            responseText = JSON.stringify(JSON.parse(rawText), null, 2);
          } catch {
            // leave as raw text
          }
        }

        return {
          content: [{ type: "text", text: responseText }],
        };
      }

      lastStatus = response.status;

      // Check if retryable
      if (isIdempotent && RETRYABLE_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
        proxyRetryAttempts.inc({ client: client.name, method, outcome: "retry" });
        // A3: handle Retry-After header (integer seconds OR HTTP-date)
        if (response.status === 429) {
          const waitMs = parseRetryAfter(response.headers.get("retry-after"));
          if (waitMs !== null && waitMs > 0) {
            await new Promise(resolve => setTimeout(resolve, waitMs));
          }
        }
        continue;
      }

      // Non-retryable error response
      proxyRequestDuration.observe({ client: client.name, method, status_class: httpStatusClass(response.status) }, (Date.now() - startTime) / 1000);
      breaker.recordFailure();
      log("warn", "Tool call returned error", { tool: mcpToolName, client: client.name, status: response.status, duration_ms: Date.now() - startTime, attempts: attempt + 1 });
      recordToolCall(Date.now() - startTime, true);
      // Fix 3 — cap error-response body via the same readBodyWithCap helper used for
      // success responses, preventing a malicious upstream from OOM-ing the bridge with
      // an oversized error body (e.g. a 400 with a 10 GB payload).
      const errorBody = await readBodyWithCap(response);
      const errorBodyText = errorBody === null
        ? `[body truncated — exceeded ${config.maxResponseBytes} byte limit]`
        : errorBody;
      return {
        content: [{ type: "text", text: `REST API returned ${response.status}: ${errorBodyText}` }],
        isError: true,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (!isIdempotent || attempt >= MAX_RETRIES) {
        proxyRequestDuration.observe({ client: client.name, method, status_class: "error" }, (Date.now() - startTime) / 1000);
        breaker.recordFailure();
        log("error", "Tool call failed", { tool: mcpToolName, client: client.name, error: lastError, duration_ms: Date.now() - startTime, attempts: attempt + 1 });
        recordToolCall(Date.now() - startTime, true);
        return {
          content: [{ type: "text", text: `Failed to reach ${client.name}: ${lastError}` }],
          isError: true,
        };
      }
      proxyRetryAttempts.inc({ client: client.name, method, outcome: "retry" });
    }
  }

  // Exhausted retries
  proxyRetryAttempts.inc({ client: client.name, method, outcome: "exhausted" });
  proxyRequestDuration.observe({ client: client.name, method, status_class: lastError ? "error" : httpStatusClass(lastStatus ?? 0) }, (Date.now() - startTime) / 1000);
  breaker.recordFailure();
  const errorMsg = lastError || `REST API returned ${lastStatus}`;
  log("error", "Tool call failed after retries", { tool: mcpToolName, client: client.name, error: errorMsg, duration_ms: Date.now() - startTime, attempts: MAX_RETRIES + 1 });
  recordToolCall(Date.now() - startTime, true);
  return {
    content: [{ type: "text", text: `Failed after ${MAX_RETRIES + 1} attempts to reach ${client.name}: ${errorMsg}` }],
    isError: true,
  };
  } finally {
    untrackRequest(client.name, reqController);
  }
}
