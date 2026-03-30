import { registry } from "./registry.js";
import { config } from "./config.js";
import { log } from "./logger.js";
import { getCircuitBreaker } from "./circuit-breaker.js";
import { recordToolCall } from "./routes/metrics.js";

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

  // Validate args against inputSchema
  if (tool.inputSchema?.properties && typeof tool.inputSchema.properties === "object") {
    const schemaProps = tool.inputSchema.properties as Record<string, { type?: string }>;
    const validKeys = new Set(Object.keys(schemaProps));

    // Strip unknown keys
    for (const key of Object.keys(args)) {
      if (!validKeys.has(key)) {
        delete remainingArgs[key];
      }
    }

    // Validate basic types
    for (const [key, value] of Object.entries(remainingArgs)) {
      const expectedType = schemaProps[key]?.type;
      if (!expectedType) continue;

      const actualType = typeof value;
      let valid = true;

      switch (expectedType) {
        case "string":
          valid = actualType === "string";
          break;
        case "number":
        case "integer":
          valid = actualType === "number";
          break;
        case "boolean":
          valid = actualType === "boolean";
          break;
      }

      if (!valid) {
        return {
          content: [{ type: "text", text: `Argument "${key}" expected type "${expectedType}" but got "${actualType}"` }],
          isError: true,
        };
      }
    }
  }

  let url = `${client.base_url}${resolvedPath}`;

  const method = tool.method.toUpperCase();
  let body: string | undefined;
  let fetchOptions: RequestInit;

  if (method === "GET" || method === "DELETE") {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(remainingArgs)) {
      params.append(key, String(value));
    }
    const queryString = params.toString();
    if (queryString) {
      url = `${url}?${queryString}`;
    }
    fetchOptions = {
      method,
      headers: { "Content-Type": "application/json" },
      redirect: "error" as RequestRedirect,
      signal: AbortSignal.timeout(effectiveTimeout),
    };
  } else {
    body = JSON.stringify(remainingArgs);
    fetchOptions = {
      method,
      headers: { "Content-Type": "application/json" },
      body,
      redirect: "error" as RequestRedirect,
      signal: AbortSignal.timeout(effectiveTimeout),
    };
  }

  const startTime = Date.now();
  const isIdempotent = method === "GET" || method === "DELETE" || method === "HEAD";
  const RETRYABLE_STATUSES = new Set([408, 429, 502, 503, 504]);
  const MAX_RETRIES = 2;
  const BASE_DELAY = 500;

  let lastError: string | undefined;
  let lastStatus: number | undefined;

  for (let attempt = 0; attempt <= (isIdempotent ? MAX_RETRIES : 0); attempt++) {
    if (attempt > 0) {
      // Don't retry if circuit is now open
      if (!breaker.canRequest().allowed) break;
      const delay = BASE_DELAY * Math.pow(2, attempt - 1) + Math.random() * BASE_DELAY;
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    try {
      const response = await fetch(url, fetchOptions);

      if (response.ok) {
        breaker.recordSuccess();
        log("info", "Tool call succeeded", { tool: mcpToolName, client: client.name, status: response.status, duration_ms: Date.now() - startTime, attempts: attempt + 1 });
        recordToolCall(Date.now() - startTime, false);
        return {
          content: [{ type: "text", text: JSON.stringify(await response.json(), null, 2) }],
        };
      }

      lastStatus = response.status;

      // Check if retryable
      if (isIdempotent && RETRYABLE_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
        // Handle Retry-After header for 429
        if (response.status === 429) {
          const retryAfter = response.headers.get("retry-after");
          if (retryAfter) {
            const waitMs = parseInt(retryAfter, 10) * 1000;
            if (!isNaN(waitMs) && waitMs > 0 && waitMs <= 30_000) {
              await new Promise(resolve => setTimeout(resolve, waitMs));
            }
          }
        }
        continue;
      }

      // Non-retryable error response
      breaker.recordFailure();
      log("warn", "Tool call returned error", { tool: mcpToolName, client: client.name, status: response.status, duration_ms: Date.now() - startTime, attempts: attempt + 1 });
      recordToolCall(Date.now() - startTime, true);
      return {
        content: [{ type: "text", text: `REST API returned ${response.status}: ${await response.text()}` }],
        isError: true,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (!isIdempotent || attempt >= MAX_RETRIES) {
        breaker.recordFailure();
        log("error", "Tool call failed", { tool: mcpToolName, client: client.name, error: lastError, duration_ms: Date.now() - startTime, attempts: attempt + 1 });
        recordToolCall(Date.now() - startTime, true);
        return {
          content: [{ type: "text", text: `Failed to reach ${client.name}: ${lastError}` }],
          isError: true,
        };
      }
    }
  }

  // Exhausted retries
  breaker.recordFailure();
  const errorMsg = lastError || `REST API returned ${lastStatus}`;
  log("error", "Tool call failed after retries", { tool: mcpToolName, client: client.name, error: errorMsg, duration_ms: Date.now() - startTime, attempts: MAX_RETRIES + 1 });
  recordToolCall(Date.now() - startTime, true);
  return {
    content: [{ type: "text", text: `Failed after ${MAX_RETRIES + 1} attempts to reach ${client.name}: ${errorMsg}` }],
    isError: true,
  };
}
