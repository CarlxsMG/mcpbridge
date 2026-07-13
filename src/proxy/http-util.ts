/**
 * Small HTTP-response helpers shared by the REST dispatch path (proxy.ts) and
 * the pagination fetch loop (pagination.ts): Retry-After parsing, status-class
 * bucketing, and a byte-capped streaming body read. Split out so pagination.ts
 * can reuse `readBodyWithCap` without importing proxy.ts (which would be a
 * circular dependency).
 */
import { config } from "../config.js";

/**
 * Parse a Retry-After header value into a wait duration in milliseconds.
 * Handles both integer-seconds ("120") and HTTP-date ("Wed, 21 Oct 2025 07:28:00 GMT") forms.
 * Returns null when the value cannot be parsed or exceeds `config.retryAfterMaxMs`.
 */
export function parseRetryAfter(headerValue: string | null): number | null {
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

/** Buckets an HTTP status code into its class string ("2xx".."5xx") for metrics labels. */
export function httpStatusClass(status: number): string {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  return "5xx";
}

/**
 * Read the response body as a stream, enforcing `config.maxResponseBytes`.
 * Returns the raw text on success, or null when the limit is exceeded (after cancelling the reader).
 */
export async function readBodyWithCap(response: Response): Promise<string | null> {
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
