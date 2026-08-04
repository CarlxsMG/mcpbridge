/**
 * The single source of truth for every machine-readable `error.code` this
 * gateway can put on the wire.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The error envelope (`{ error: { code, message, request_id } }`) has always
 * carried a stable `code`, but the set of codes lived nowhere: it was whatever
 * string literals happened to be spelled at ~200 call sites. Three things were
 * impossible as a result — an API consumer could not enumerate what it might
 * have to handle, the admin UI could not localize a failure (it can only
 * translate a code it knows about, see `errors.api.*` in the locale bundles),
 * and a typo in a code shipped silently because nothing compared it to
 * anything.
 *
 * Two gates keep this honest, and they cover different halves of the problem:
 *
 *   1. **The compiler.** `sendError`/`notFound`/`forbidden` in ./http-errors.ts
 *      take `ErrorCode`, not `string`, so any code passed through those helpers
 *      — including one flowing out of a mutation-result union like
 *      `LbMutationError["error"]` — fails to compile unless it is listed here.
 *   2. **A structural test** (`__tests__/error-codes.test.ts`) for the handful
 *      of paths that build the envelope by hand instead of going through a
 *      helper (the rate limiter, the JSON-depth guard, the MCP transports, the
 *      Express error handler). The compiler cannot see those, so the test greps
 *      for `code: "..."` literals and fails on anything uncatalogued.
 *
 * ── Descriptions ────────────────────────────────────────────────────────────
 * `en`/`es` are one-line, operator-facing summaries of what the code MEANS —
 * not the message text (that is per-call-site and often carries specifics like
 * a field name). They are the source for two generated surfaces:
 * `docs/guide/error-codes.md` and `docs/es/guide/error-codes.md`, both written
 * by `scripts/generate.ts` and gated by its `--check` mode in `bun run check`.
 *
 * Adding a code: add it here (both languages), run `bun run generate`, and add
 * the matching `errors.api.<CODE>` entry to admin-ui's `en.json`/`es.json` —
 * the test asserts all three stay in step.
 *
 * Descriptions deliberately avoid naming an HTTP status: several codes are
 * emitted at more than one status (`CLIENT_NOT_FOUND` is a 404 for a missing
 * client and, by design, the same 404 for one another team owns), and pinning a
 * status here would make this file wrong rather than useful.
 */

export interface ErrorCodeEntry {
  /** One-line, operator-facing summary. Published in docs/guide/error-codes.md. */
  en: string;
  /** Same, in Spanish. Published in docs/es/guide/error-codes.md. */
  es: string;
  /**
   * Set when this code's `message` carries request-specific detail that a
   * generic translated sentence would destroy — which field failed validation,
   * which upstream refused, which tool name was unknown, what the naming rule
   * actually is.
   *
   * The admin UI localizes a failure by looking up `errors.api.<CODE>`, falling
   * back to the server's message when there is no key. Marking a code here
   * means "there must be NO key" — the precise English sentence beats a vague
   * localized one, and the catalog test enforces the absence so nobody
   * helpfully adds one later and silently coarsens every validation error in
   * the product.
   */
  verbatim?: true;
}

const CODES = {
  // ── Authentication, authorization, tenancy ────────────────────────────────
  UNAUTHORIZED: {
    en: "No valid credentials were presented, or the session has expired.",
    es: "No se presentaron credenciales válidas, o la sesión ha caducado.",
  },
  FORBIDDEN: {
    en: "The caller is authenticated but lacks the role this action requires.",
    es: "Quien llama está autenticado pero no tiene el rol que requiere esta acción.",
  },
  INVALID_CREDENTIALS: {
    en: "The username/password pair was rejected at login.",
    es: "La pareja usuario/contraseña fue rechazada al iniciar sesión.",
  },
  CSRF_VALIDATION_FAILED: {
    en: "A session-authenticated mutation arrived without a matching X-CSRF-Token header.",
    es: "Una mutación autenticada por sesión llegó sin una cabecera X-CSRF-Token coincidente.",
  },
  ORIGIN_NOT_ALLOWED: {
    en: "The browser Origin header is missing or is not in the configured allowlist.",
    es: "La cabecera Origin del navegador falta o no está en la lista permitida configurada.",
  },
  LAST_ADMIN_PROTECTED: {
    en: "The change would leave the instance with no admin user, so it was refused.",
    es: "El cambio dejaría la instancia sin ningún usuario administrador, así que se rechazó.",
  },
  LAST_SUPERADMIN_PROTECTED: {
    en: "The change would leave the instance with no teamless super-admin, so it was refused.",
    es: "El cambio dejaría la instancia sin ningún super-admin sin equipo, así que se rechazó.",
  },
  RATE_LIMITED: {
    en: "The caller exceeded a rate limit; retry after the interval in the response.",
    es: "Se superó un límite de peticiones; reintenta pasado el intervalo que indica la respuesta.",
  },

  // ── Request shape ─────────────────────────────────────────────────────────
  VALIDATION_ERROR: {
    en: "The request body or query string failed validation; the message names the field.",
    es: "El cuerpo o la query de la petición no pasaron la validación; el mensaje indica el campo.",
    verbatim: true,
  },
  BAD_REQUEST: {
    en: "Generic 4xx fallback for a request the gateway could not process.",
    es: "Respaldo genérico 4xx para una petición que la pasarela no pudo procesar.",
  },
  JSON_TOO_DEEP: {
    en: "The JSON body nests deeper than the configured limit (a parser-exhaustion guard).",
    es: "El cuerpo JSON anida más de lo permitido (protección contra agotamiento del parser).",
  },
  INVALID_URL: {
    en: "A supplied URL is malformed, uses a rejected scheme, or resolves to a blocked address.",
    es: "Una URL indicada está mal formada, usa un esquema rechazado o resuelve a una dirección bloqueada.",
    verbatim: true,
  },
  INVALID_NAME: {
    en: "A name field breaks the naming rules for its entity.",
    es: "Un campo de nombre incumple las reglas de nomenclatura de su entidad.",
    verbatim: true,
  },
  INVALID_SLUG: {
    en: "A catalog slug does not match the required lowercase/dash format.",
    es: "Un slug de catálogo no cumple el formato requerido en minúsculas con guiones.",
    verbatim: true,
  },
  INVALID_CRON: {
    en: "A schedule's cron expression could not be parsed.",
    es: "No se pudo interpretar la expresión cron de una programación.",
    verbatim: true,
  },
  INVALID_SCHEMA: {
    en: "A supplied JSON Schema is not a valid object schema.",
    es: "El JSON Schema indicado no es un esquema de objeto válido.",
    verbatim: true,
  },
  INVALID_STEPS: {
    en: "A composite tool's step list is empty or otherwise unusable.",
    es: "La lista de pasos de una herramienta compuesta está vacía o no es utilizable.",
    verbatim: true,
  },
  INVALID_TARGET: {
    en: "A schedule or monitor names a target that does not fit its kind.",
    es: "Una programación o monitor apunta a un objetivo que no corresponde a su tipo.",
    verbatim: true,
  },
  INVALID_MODE: {
    en: "An unrecognized canary mode was supplied.",
    es: "Se indicó un modo de canary no reconocido.",
    verbatim: true,
  },
  INVALID_STRATEGY: {
    en: "An unrecognized load-balancing strategy was supplied.",
    es: "Se indicó una estrategia de balanceo de carga no reconocida.",
    verbatim: true,
  },
  INVALID_WEIGHT: {
    en: "A load-balancer or canary weight is outside the accepted range.",
    es: "Un peso de balanceo o de canary está fuera del rango aceptado.",
    verbatim: true,
  },
  INVALID_INTERVAL: {
    en: "A monitor's polling interval is outside the accepted range.",
    es: "El intervalo de sondeo de un monitor está fuera del rango aceptado.",
    verbatim: true,
  },
  INVALID_ARGS: {
    en: "A saved example's arguments do not match the tool's input schema.",
    es: "Los argumentos de un ejemplo guardado no encajan con el esquema de entrada de la herramienta.",
    verbatim: true,
  },
  INVALID_SESSION_ID: {
    en: "The Mcp-Session-Id header is not a UUID v4.",
    es: "La cabecera Mcp-Session-Id no es un UUID v4.",
  },
  TOOL_ALIAS_INVALID: {
    en: "A tool alias breaks the alias naming rules.",
    es: "Un alias de herramienta incumple las reglas de nomenclatura de alias.",
    verbatim: true,
  },

  // ── Not found ─────────────────────────────────────────────────────────────
  NOT_FOUND: {
    en: "Generic 404 for a resource with no more specific code.",
    es: "404 genérico para un recurso sin un código más específico.",
  },
  CLIENT_NOT_FOUND: {
    en: "No registered client by that name — also returned when another team owns it.",
    es: "No hay ningún cliente registrado con ese nombre — también se devuelve si pertenece a otro equipo.",
  },
  TOOL_NOT_FOUND: {
    en: "The client exists but exposes no tool by that name.",
    es: "El cliente existe pero no expone ninguna herramienta con ese nombre.",
  },
  TOOL_NOT_LIVE: {
    en: "The tool is catalogued but not currently live in the registry.",
    es: "La herramienta está catalogada pero no está activa ahora mismo en el registro.",
  },
  UNKNOWN_TOOL: {
    en: "A bundle or composite references a tool that does not exist.",
    es: "Un bundle o una compuesta referencia una herramienta que no existe.",
    verbatim: true,
  },
  BUNDLE_NOT_FOUND: {
    en: "No bundle by that name.",
    es: "No existe ningún bundle con ese nombre.",
  },
  COMPOSITE_NOT_FOUND: {
    en: "No composite (macro) tool by that name.",
    es: "No existe ninguna herramienta compuesta (macro) con ese nombre.",
  },
  CATALOG_ENTRY_NOT_FOUND: {
    en: "No catalog entry with that slug.",
    es: "No existe ninguna entrada de catálogo con ese slug.",
  },
  INSTALL_LINK_NOT_FOUND: {
    en: "The install link does not exist, or has expired.",
    es: "El enlace de instalación no existe, o ha caducado.",
  },
  CONSUMER_NOT_FOUND: {
    en: "No consumer with that id — also returned when another team owns it.",
    es: "No hay ningún consumidor con ese id — también se devuelve si pertenece a otro equipo.",
  },
  MCP_KEY_NOT_FOUND: {
    en: "No managed MCP API key with that id.",
    es: "No existe ninguna clave de API MCP gestionada con ese id.",
  },
  USER_NOT_FOUND: {
    en: "No admin user with that id.",
    es: "No existe ningún usuario administrador con ese id.",
  },
  TEAM_NOT_FOUND: {
    en: "No team with that id.",
    es: "No existe ningún equipo con ese id.",
  },
  POLICY_NOT_FOUND: {
    en: "No guard policy by that name.",
    es: "No existe ninguna política de guardas con ese nombre.",
  },
  ALERT_NOT_FOUND: {
    en: "No alert rule with that id.",
    es: "No existe ninguna regla de alerta con ese id.",
  },
  APPROVAL_NOT_FOUND: {
    en: "No approval request with that id.",
    es: "No existe ninguna solicitud de aprobación con ese id.",
  },
  SCHEDULE_NOT_FOUND: {
    en: "No maintenance schedule with that id.",
    es: "No existe ninguna programación de mantenimiento con ese id.",
  },
  SNAPSHOT_NOT_FOUND: {
    en: "No config snapshot with that id.",
    es: "No existe ninguna instantánea de configuración con ese id.",
  },
  SESSION_NOT_FOUND: {
    en: "No MCP session with that id.",
    es: "No existe ninguna sesión MCP con ese id.",
  },
  TRACE_NOT_FOUND: {
    en: "No trace with that id.",
    es: "No existe ninguna traza con ese id.",
  },
  TRAFFIC_NOT_FOUND: {
    en: "No traffic record with that id.",
    es: "No existe ningún registro de tráfico con ese id.",
  },
  EXAMPLE_NOT_FOUND: {
    en: "No saved example with that id for this tool.",
    es: "No existe ningún ejemplo guardado con ese id para esta herramienta.",
  },
  TARGET_NOT_FOUND: {
    en: "No load-balancer upstream target with that id.",
    es: "No existe ningún destino de balanceo con ese id.",
  },
  WS_PROXY_TARGET_NOT_FOUND: {
    en: "No WebSocket proxy target by that name.",
    es: "No existe ningún destino de proxy WebSocket con ese nombre.",
  },

  // ── Conflicts and state ───────────────────────────────────────────────────
  ALREADY_EXISTS: {
    en: "An entity with that name already exists.",
    es: "Ya existe una entidad con ese nombre.",
  },
  NAME_COLLISION: {
    en: "The name is already taken by a different kind of entity in the same namespace.",
    es: "El nombre ya está ocupado por otro tipo de entidad en el mismo espacio de nombres.",
    verbatim: true,
  },
  USER_EXISTS: {
    en: "An admin user with that username already exists.",
    es: "Ya existe un usuario administrador con ese nombre.",
  },
  CONSUMER_EXISTS: {
    en: "A consumer with that name already exists.",
    es: "Ya existe un consumidor con ese nombre.",
  },
  POLICY_EXISTS: {
    en: "A guard policy with that name already exists.",
    es: "Ya existe una política de guardas con ese nombre.",
  },
  TOOL_ALIAS_CONFLICT: {
    en: "The alias is already in use by another tool.",
    es: "El alias ya está en uso por otra herramienta.",
    verbatim: true,
  },
  ALREADY_REVOKED: {
    en: "The API key was revoked already.",
    es: "La clave de API ya estaba revocada.",
  },
  NOT_PENDING: {
    en: "The approval is no longer pending, so it can't be approved or rejected.",
    es: "La aprobación ya no está pendiente, así que no se puede aprobar ni rechazar.",
    verbatim: true,
  },
  IMMUTABLE_ENTRY: {
    en: "Built-in catalog entries cannot be edited or deleted at runtime.",
    es: "Las entradas de catálogo integradas no se pueden editar ni borrar en caliente.",
  },
  EMPTY_BUNDLE: {
    en: "The bundle has no tools, so no install link can be minted for it.",
    es: "El bundle no tiene herramientas, así que no se puede generar un enlace de instalación.",
  },
  NOT_REST: {
    en: "The operation only applies to REST clients, and this client is not one.",
    es: "La operación solo se aplica a clientes REST, y este cliente no lo es.",
  },

  // ── Upstream / backend failures ───────────────────────────────────────────
  DISCOVERY_ERROR: {
    en: "Tool discovery against the backend returned nothing usable.",
    es: "El descubrimiento de herramientas contra el backend no devolvió nada utilizable.",
    verbatim: true,
  },
  SCHEMA_UNAVAILABLE: {
    en: "The backend's OpenAPI/GraphQL schema could not be fetched or parsed.",
    es: "No se pudo obtener o interpretar el esquema OpenAPI/GraphQL del backend.",
    verbatim: true,
  },
  IMPORT_ERROR: {
    en: "A config import failed to parse or apply; the message carries the reason.",
    es: "Una importación de configuración no se pudo interpretar o aplicar; el mensaje indica el motivo.",
    verbatim: true,
  },
  BACKUP_FAILED: {
    en: "The database backup could not be created.",
    es: "No se pudo crear la copia de seguridad de la base de datos.",
    verbatim: true,
  },
  BACKUP_STREAM_FAILED: {
    en: "The backup was created but failed while streaming to the client.",
    es: "La copia de seguridad se creó pero falló al transmitirse al cliente.",
    verbatim: true,
  },
  SSO_NOT_CONFIGURED: {
    en: "An SSO endpoint was called while OIDC is not configured.",
    es: "Se llamó a un endpoint de SSO sin tener OIDC configurado.",
  },
  SSO_DISCOVERY_FAILED: {
    en: "The OIDC provider's discovery document could not be fetched.",
    es: "No se pudo obtener el documento de descubrimiento del proveedor OIDC.",
    verbatim: true,
  },
  NOT_CONFIGURED: {
    en: "The feature being addressed has no configuration on this client yet.",
    es: "La funcionalidad invocada todavía no tiene configuración en este cliente.",
  },
  SECRET_BOX_NOT_CONFIGURED: {
    en: "SECRET_ENCRYPTION_KEY is unset, so the gateway refuses to store or mint a secret.",
    es: "SECRET_ENCRYPTION_KEY no está definida, así que la pasarela no guarda ni genera secretos.",
  },
  SECRETS_PROVIDER_ERROR: {
    en: "The external secrets provider (e.g. Vault) rejected or could not serve the request.",
    es: "El proveedor externo de secretos (p. ej. Vault) rechazó la petición o no pudo atenderla.",
    verbatim: true,
  },
  SECRETS_PROVIDER_UNCONFIGURED: {
    en: "The operation needs an external secrets provider and none is configured.",
    es: "La operación necesita un proveedor externo de secretos y no hay ninguno configurado.",
  },
  UPSTREAM_AUTH_VAULT_UNSUPPORTED: {
    en: "This upstream-auth mode cannot be stored in the configured Vault provider.",
    es: "Este modo de autenticación con el upstream no se puede almacenar en el proveedor Vault configurado.",
  },
  INTERNAL_ERROR: {
    en: "An unhandled server-side failure; details are in the logs under this request id.",
    es: "Fallo interno no controlado; los detalles están en los logs bajo este id de petición.",
  },
} as const;

/** Every code this gateway can emit. Widening this to `string` defeats the compile-time gate. */
export type ErrorCode = keyof typeof CODES;

/**
 * The catalog, typed uniformly so `.verbatim` is readable on every entry (the
 * `as const` literal above only carries the key on the entries that set it).
 */
export const ERROR_CODES: Record<ErrorCode, ErrorCodeEntry> = CODES;

/** Stable, sorted list — used by the docs generator and the catalog tests. */
export const ERROR_CODE_LIST: readonly ErrorCode[] = (Object.keys(CODES) as ErrorCode[]).sort();

/** True when `value` is a catalogued code. Used by the structural test and by tooling. */
export function isErrorCode(value: string): value is ErrorCode {
  return Object.prototype.hasOwnProperty.call(CODES, value);
}
