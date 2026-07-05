/**
 * Shared tool-name normalization for auto-discovery sources (OpenAPI
 * operationIds, GraphQL field names) — both need to turn an arbitrary,
 * often-camelCase author-supplied identifier into the registry's tool-name
 * rule (lowercase alphanumeric + hyphen/underscore, <= 63 chars, starting
 * with a letter or digit) and disambiguate collisions within one discovery
 * run. Previously duplicated independently in openapi-discovery.ts and
 * graphql-discovery.ts, with the GraphQL copy missing the length cap on its
 * collision-suffix loop (producing an over-length name that then failed
 * registry.register()) and the OpenAPI copy having a truncation bug that
 * could infinite-loop when the base name was already 63 chars (see
 * uniqueToolName below).
 *
 * TOOL_NAME_RE itself is defined once in lib/identifier.ts (shared with the
 * rest of the codebase's identifier validation) and re-exported here so
 * existing importers of this module are unaffected.
 */

import { TOOL_NAME_RE } from "../lib/identifier.js";

export { TOOL_NAME_RE };
const MAX_LEN = 63;

/** Normalizes an author-supplied identifier (often camelCase) into the registry's tool-name rule. */
export function sanitizeToolName(raw: string): string {
  const snake = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[^a-z0-9]+/, "");
  const truncated = snake.slice(0, MAX_LEN);
  return TOOL_NAME_RE.test(truncated) && truncated.length > 0 ? truncated : "op";
}

/**
 * Disambiguates a name that collides with one already used in this discovery
 * run. Truncates the BASE name (not the already-suffixed candidate) to make
 * room for the suffix — appending `_${suffix}` to a full-length name and
 * *then* truncating back to MAX_LEN can silently discard the suffix and
 * return the exact same (already-colliding) string forever. Truncating the
 * base first guarantees each candidate is a distinct string, so the loop is
 * guaranteed to terminate within `used.size + 1` iterations.
 */
export function uniqueToolName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  let suffix = 2;
  let candidate: string;
  do {
    const suffixStr = `_${suffix++}`;
    candidate = name.slice(0, Math.max(1, MAX_LEN - suffixStr.length)) + suffixStr;
  } while (used.has(candidate));
  used.add(candidate);
  return candidate;
}
