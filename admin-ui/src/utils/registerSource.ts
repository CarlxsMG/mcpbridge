/**
 * Autodetection for the register-server page's single "paste anything" field.
 *
 * The register form used to ask for the server kind, then the discovery mode,
 * then five more fields, before the user had seen a single tool. This module
 * turns the first two of those questions into an inference over whatever was
 * pasted, and derives what it can of the rest.
 *
 * It is a separate, pure module (rather than inline in the component) for two
 * reasons. The heuristics below are the part most likely to be wrong on real
 * input, so they need direct unit coverage; and every outcome — including "I
 * cannot tell" and "this input has no registration path at all" — has to be
 * representable as DATA, because the component's contract is that a wrong guess
 * is always one click away from being corrected. A heuristic that can strand a
 * user is worse than asking them outright, so `detectSource` never invents a
 * single answer for input that two sources could both legitimately claim.
 */

/** Server kinds POST /register accepts (its `kind` field). */
export type RegisterKind = "rest" | "mcp" | "graphql";

/** REST tool-discovery sources (the mutually-exclusive fields of POST /register). */
export type RegisterMode = "openapi" | "manual" | "curl" | "postman";

/** One input shape the single source field can hold. */
export type SourceId = "openapi" | "mcp" | "graphql" | "curl" | "postman" | "manual";

export interface SourceTarget {
  kind: RegisterKind;
  /**
   * Discovery mode. Only meaningful for `kind: "rest"` — MCP and GraphQL each
   * have exactly one registration shape — but kept non-optional so callers can
   * read one flat record without narrowing on `kind` first.
   */
  mode: RegisterMode;
}

/** What registering each source shape actually means to POST /register. */
export const SOURCE_TARGETS: Record<SourceId, SourceTarget> = {
  openapi: { kind: "rest", mode: "openapi" },
  curl: { kind: "rest", mode: "curl" },
  postman: { kind: "rest", mode: "postman" },
  manual: { kind: "rest", mode: "manual" },
  graphql: { kind: "graphql", mode: "openapi" },
  mcp: { kind: "mcp", mode: "openapi" },
};

/**
 * Every source shape, in the order the correction UI offers them: the two the
 * heuristic can genuinely confuse first, then the three unambiguous pastes,
 * then the hand-written escape hatch.
 */
export const SOURCE_IDS: readonly SourceId[] = ["openapi", "mcp", "graphql", "curl", "postman", "manual"];

/**
 * Input this form recognizes and still cannot register from — the outcome that
 * needs an explanation rather than a chooser.
 *
 * `inline-openapi` is an OpenAPI/Swagger document pasted or file-loaded as text.
 * POST /register discovers REST tools from `openapi_url`, `tools`, `curl_input`
 * or `postman_collection`; none of them carries a spec BODY, so there is no
 * source the user could pick that would make this input work. Offering the
 * chooser here is what turned a reasonable action ("load my openapi.json, pick
 * OpenAPI") into a URL-validation error.
 */
export type UnsupportedInput = "inline-openapi";

export interface SourceDetection {
  /** True once the field holds something, so the UI can stay silent while empty. */
  hasInput: boolean;
  /** The single inferred source, or null when the input is empty, ambiguous, or unrecognized. */
  detected: SourceId | null;
  /**
   * Populated instead of `detected` when the input is a plain URL that more
   * than one source could claim. The component must ASK: guessing sends the
   * user through a registration that fails with an error about the wrong
   * protocol, which reads as a broken product rather than a wrong guess.
   */
  ambiguous: readonly SourceId[];
  /**
   * Set instead of `detected`/`ambiguous` when the input is recognized but has
   * no registration path (see `UnsupportedInput`). The component must state what
   * to do instead and offer NO source pills — every one of them would be a lie —
   * and the page must not build a payload from it.
   */
  unsupported: UnsupportedInput | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Postman's own export marker. `info._postman_id` is written by every Postman
 * export; `info.schema` carries the collection-format URL. Either is enough,
 * and matching on both means a collection hand-assembled from the schema (no
 * `_postman_id`) is still recognized.
 */
function looksLikePostmanCollection(doc: unknown): boolean {
  if (!isRecord(doc)) return false;
  const info = doc.info;
  if (!isRecord(info)) return false;
  if (typeof info._postman_id === "string" && info._postman_id.length > 0) return true;
  return typeof info.schema === "string" && info.schema.includes("postman");
}

/**
 * The document's own version marker — `openapi: "3.1.0"` or the Swagger 2
 * `swagger: "2.0"`. Either key at the TOP level identifies a spec document
 * without validating it, which is all that is needed: the point is to explain
 * that a spec body cannot be registered, not to check that it is a good one.
 *
 * Order matters at the call site. This runs AFTER the Postman and tool-array
 * branches, so a collection or tool list that happens to carry an `openapi` key
 * still registers as what it is rather than being declared a dead end.
 */
function looksLikeOpenApiDocument(doc: unknown): boolean {
  if (!isRecord(doc)) return false;
  return typeof doc.openapi === "string" || typeof doc.swagger === "string";
}

/**
 * The same document pasted as YAML, which is how half the specs in the world are
 * published — so it reaches this field just as easily as the JSON form.
 *
 * Only the first meaningful line is examined, because the version marker is a
 * TOP-LEVEL key: matching it anywhere else would fire on a nested `openapi:`
 * under some vendor extension. A leading `---` or comment line is skipped since
 * exported specs commonly carry one.
 *
 * It deliberately misses a spec whose first key is something else (`info:`,
 * `paths:`). That input falls through to the existing "not sure what this is"
 * chooser — the behaviour before any of this existed — so a miss costs nothing
 * beyond not getting the better message.
 */
function looksLikeYamlOpenApiDocument(raw: string): boolean {
  const firstKeyLine = raw
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#") && line !== "---");
  return firstKeyLine !== undefined && /^(openapi|swagger)\s*:/i.test(firstKeyLine);
}

/** Parses `raw` as an absolute http(s) URL, or returns null. Any other scheme is not a backend we can reach. */
export function parseHttpUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url : null;
}

const SPEC_FILE_RE = /\.(json|ya?ml)$/i;

/** `host[:port][/path]`, with or without dots so `localhost:3000` matches too. */
const SCHEMELESS_HOST_RE = /^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)+)(:\d+)?(\/\S*)?$/i;

/**
 * True for input that reads as a URL but carries no scheme, e.g.
 * `api.example.com/openapi.json`. Registration requires an absolute http(s)
 * URL, so this input can only be rejected — but it is the most likely paste to
 * be mistaken for "unrecognized", and saying which character is missing is far
 * more useful than offering the full source chooser.
 */
export function looksLikeSchemelessUrl(raw: string): boolean {
  const trimmed = raw.trim();
  return parseHttpUrl(trimmed) === null && SCHEMELESS_HOST_RE.test(trimmed);
}

function detectFromUrl(url: URL): SourceDetection {
  // A /graphql path segment is the near-universal convention and the only
  // signal available without fetching, so it wins over the extension check —
  // `/graphql.json` is far more likely a GraphQL endpoint than a spec.
  if (url.pathname.toLowerCase().includes("/graphql")) {
    return { hasInput: true, detected: "graphql", ambiguous: [], unsupported: null };
  }
  if (SPEC_FILE_RE.test(url.pathname)) {
    return { hasInput: true, detected: "openapi", ambiguous: [], unsupported: null };
  }
  // An extension-less URL is the genuinely undecidable case: `/mcp`, `/api` and
  // `/v3/openapi` all appear as both spec URLs and MCP endpoints in the wild,
  // and only fetching it would tell us apart. Offer both.
  return { hasInput: true, detected: null, ambiguous: ["openapi", "mcp"], unsupported: null };
}

/**
 * Infers which source shape `raw` is. Returns `detected: null` with an empty
 * `ambiguous` list when the input matches nothing — the caller then shows the
 * full chooser rather than pretending — or `unsupported` set when the input is
 * recognized and no source could register it.
 */
export function detectSource(raw: string): SourceDetection {
  const trimmed = raw.trim();
  if (!trimmed) return { hasInput: false, detected: null, ambiguous: [], unsupported: null };

  if (/^curl\s/i.test(trimmed)) return { hasInput: true, detected: "curl", ambiguous: [], unsupported: null };

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Half-pasted or malformed JSON: no guess. The chooser stays available so
      // the user can declare their intent and fix the text.
      return { hasInput: true, detected: null, ambiguous: [], unsupported: null };
    }
    if (looksLikePostmanCollection(parsed))
      return { hasInput: true, detected: "postman", ambiguous: [], unsupported: null };
    // A bare JSON array is the manual tool-list shape POST /register takes as
    // `tools` — nothing else this form accepts is a top-level array.
    if (Array.isArray(parsed)) return { hasInput: true, detected: "manual", ambiguous: [], unsupported: null };
    if (looksLikeOpenApiDocument(parsed))
      return { hasInput: true, detected: null, ambiguous: [], unsupported: "inline-openapi" };
    return { hasInput: true, detected: null, ambiguous: [], unsupported: null };
  }

  const url = parseHttpUrl(trimmed);
  if (url) return detectFromUrl(url);

  if (looksLikeYamlOpenApiDocument(trimmed))
    return { hasInput: true, detected: null, ambiguous: [], unsupported: "inline-openapi" };

  return { hasInput: true, detected: null, ambiguous: [], unsupported: null };
}

/**
 * Client-name shape, mirrored from the backend's `TOOL_NAME_RE` in
 * src/lib/identifier.ts. Registration rejects anything else outright, so the
 * form checks it locally to keep a typo in a derived name from costing a round
 * trip (Nielsen H5: prevent the error rather than report it).
 */
const CLIENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** Backend `TOOL_KEY_SEPARATOR` — reserved in the `clientName__toolName` key, so a name may not contain it. */
const TOOL_KEY_SEPARATOR = "__";

/** Longest client name `CLIENT_NAME_RE` admits. */
export const MAX_CLIENT_NAME_LENGTH = 63;

/** Why a client name is unacceptable, as a stable code the caller maps to a localized message. */
export type ClientNameIssue = "required" | "shape" | "separator";

/** Returns the issue with `name`, or null when the backend would accept it. */
export function clientNameIssue(name: string): ClientNameIssue | null {
  if (!name) return "required";
  if (name.includes(TOOL_KEY_SEPARATOR)) return "separator";
  return CLIENT_NAME_RE.test(name) ? null : "shape";
}

/**
 * Reduces arbitrary text to something `CLIENT_NAME_RE` accepts, or "" when
 * nothing usable is left.
 *
 * Every non-`[a-z0-9]` character becomes a hyphen — including underscores,
 * which the regex would allow on their own. Keeping them would let a source
 * containing `a_b` collapse into the reserved `__` separator once adjacent
 * characters were stripped, and the resulting registration failure would name a
 * separator the user never typed.
 */
export function slugifyClientName(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, MAX_CLIENT_NAME_LENGTH)
    .replace(/-+$/, "");
  return CLIENT_NAME_RE.test(slug) ? slug : "";
}

export interface DerivedServerFields {
  /** Slug proposed as the client name. "" when the host yields nothing usable. */
  name: string;
  /**
   * The URL itself, proposed as `health_url` — NOT its origin.
   *
   * This looks like the wrong choice and is the safe one. A failing health check
   * auto-evicts the client (src/observability/health.ts treats any non-2xx as a
   * failure), and plenty of APIs answer 404 on `/`, so defaulting to the origin
   * would silently register servers that disappear minutes later. The pasted
   * spec URL, by contrast, has just been fetched successfully by the preview.
   * The backend still derives `base_url` from this URL's origin, so tool
   * endpoints resolve exactly as they would have.
   */
  healthUrl: string;
}

/**
 * Derives the fields the form no longer asks for from a pasted URL, or returns
 * null when the input is not one (a curl/Postman/manual paste carries no single
 * host to derive from — those keep asking).
 *
 * These are proposals, not decisions: the caller must render them in an
 * editable field. `info.title` / `servers[0].url` from the fetched document
 * would be better sources for both, but POST /admin-api/discovery/preview
 * returns only the discovered tools, so the URL is all the browser has.
 */
export function deriveFromSourceUrl(raw: string): DerivedServerFields | null {
  const url = parseHttpUrl(raw);
  if (!url) return null;
  // "www." carries no identity and "api." is shared by half the internet, so
  // both are dropped before slugifying; whatever remains is the distinctive
  // part of the host (api.payments.example.com -> payments-example-com).
  const host = url.hostname.replace(/^(www|api)\./i, "");
  return { name: slugifyClientName(host), healthUrl: url.toString() };
}
