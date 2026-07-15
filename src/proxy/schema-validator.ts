import Ajv from "ajv";
import addFormats from "ajv-formats";

// ---------------------------------------------------------------------------
// Ajv singleton — shared across all tool calls.
//
// Lives in its own module (rather than proxy.ts) specifically to avoid a
// circular VALUE import: getOrCompile is called both from proxy.ts's own REST
// dispatch path and from dispatch-mcp.ts's dispatchMcpToolCall. If it stayed in
// proxy.ts and dispatch-mcp.ts imported it from there, that would create
// proxy.ts -> dispatch-mcp.ts -> proxy.ts. Both proxy.ts and dispatch-mcp.ts
// import getOrCompile from here instead, and neither imports the other for it.
// ---------------------------------------------------------------------------
const ajv = new Ajv({
  allErrors: false, // first error is enough for tool calls
  strict: false, // tolerate vendor extensions in JSON Schema
  removeAdditional: "all", // strip unknown keys (replicates prior manual behaviour)
  useDefaults: true, // apply defaults if specified in schema
  coerceTypes: false, // do NOT auto-coerce — surface real type errors
});
addFormats(ajv);

// Cache compiled validators per client+tool key (stable for the lifetime of a registration).
const validatorCache = new Map<string, ReturnType<typeof ajv.compile>>();

export function getOrCompile(
  clientName: string,
  toolName: string,
  schema: Record<string, unknown>,
): ReturnType<typeof ajv.compile> {
  const key = `${clientName}::${toolName}`;
  let validate = validatorCache.get(key);
  if (!validate) {
    validate = ajv.compile(schema);
    validatorCache.set(key, validate);
  }
  return validate;
}

/**
 * Drops every compiled validator for a client (all its tools). Must be called
 * whenever a client's live tool set changes out from under a stable key —
 * re-registration (schema may have been tightened/loosened) and teardown —
 * mirroring invalidatePinnedIp/removeCircuitBreaker/clearLbState/
 * purgeClientCache, which registry.ts already calls at those same points.
 * Without this, getOrCompile's cache hit on the unchanged `${clientName}::${toolName}`
 * key silently keeps enforcing a stale schema until process restart.
 */
export function invalidateCompiledSchemasForClient(clientName: string): void {
  const prefix = `${clientName}::`;
  for (const key of validatorCache.keys()) {
    if (key.startsWith(prefix)) validatorCache.delete(key);
  }
}
