import type { RestToolDefinition } from "../mcp/types.js";
import { sanitizeToolName, uniqueToolName } from "./tool-naming.js";

/**
 * Lower-friction alternatives to OpenAPI auto-discovery: parse either a raw
 * cURL paste or a Postman Collection v2.1 export into the exact same
 * RestToolDefinition[] shape the "manual tools" registration path already
 * accepts (see performRestRegistration in routes/register.ts). Both parsers
 * are pure and synchronous — no network access, no SSRF surface — so all the
 * SSRF/path-traversal/Ajv validation that already runs on a manual `tools`
 * array is reused completely unchanged once these return.
 *
 * Neither format carries JSON-Schema type information, so (matching how
 * hand-written manual tools already work without full OpenAPI rigor) every
 * observed body/query key is emitted as an untyped-permissive `string`
 * property, none marked required — a human or an LLM can tighten the schema
 * later via the tool-override UI.
 *
 * Known, deliberate gap: neither cURL nor Postman headers (including the
 * Authorization header implied by `-u`/`--user`) are persisted onto the
 * returned tool — RestToolDefinition has no per-tool header field in this
 * codebase (only per-CLIENT upstream auth exists, see backend-auth/upstream-auth.ts).
 * Header *names* (never values — a tool's description is visible to any MCP
 * client, so a secret header value must never land there) are folded into
 * `description` as a note so the operator knows to configure upstream auth
 * separately, rather than silently dropping the information.
 */

type RestMethod = RestToolDefinition["method"];
const SUPPORTED_METHODS = new Set<RestMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);

// -----------------------------------------------------------------------------
// cURL
// -----------------------------------------------------------------------------

/**
 * curl flags that take no argument value. Encountered while scanning tokens,
 * these must NOT swallow the following token (otherwise e.g. `-s <url>` would
 * treat the URL as -s's "value" and never see it). Not exhaustive — curl has
 * hundreds of flags — but covers the ones that commonly appear in copy-pasted
 * example commands. Any *other* unrecognized flag is assumed to take a value
 * (the safer default, since the flags real API examples actually rely on —
 * -H, -d, -X, -u — all take one).
 */
const CURL_BOOLEAN_FLAGS = new Set([
  "-s",
  "--silent",
  "-S",
  "--show-error",
  "-k",
  "--insecure",
  "-L",
  "--location",
  "-v",
  "--verbose",
  "-i",
  "--include",
  "--compressed",
  "-f",
  "--fail",
  "-g",
  "--globoff",
  "-4",
  "--ipv4",
  "-6",
  "--ipv6",
  "-N",
  "--no-buffer",
  "-#",
  "--progress-bar",
  "-sS",
  "-sSL",
  "-sL",
  "-Ss",
]);

// The single-character versions of the boolean short flags above, for decomposing
// a COMBINED cluster like `-fsSL`, `-sSf`, or `-Lv`. curl lets you mash short flags
// together, so enumerating every combination is hopeless; instead, a single-dash
// token whose every character is a known boolean short flag takes no value. Without
// this, `curl -fsSL <url>` treated `-fsSL` as value-taking and swallowed the URL,
// and `curl -sSf -X POST <url>` swallowed `-X` and produced a tool for method "POST".
const CURL_BOOLEAN_SHORT_CHARS = new Set(["s", "S", "k", "L", "v", "i", "f", "g", "4", "6", "N", "#"]);

/** True when a token consumes no following value: a known boolean flag, or a single-dash cluster of only boolean short flags. */
function isBooleanFlagToken(t: string): boolean {
  if (CURL_BOOLEAN_FLAGS.has(t)) return true;
  if (t.length > 2 && t.startsWith("-") && !t.startsWith("--")) {
    return [...t.slice(1)].every((c) => CURL_BOOLEAN_SHORT_CHARS.has(c));
  }
  return false;
}

/**
 * Shell-like tokenizer: splits on whitespace, honoring single quotes (no
 * escapes inside), double quotes (backslash-escapes `"`, `\`, `$`, `` ` ``),
 * and a bare backslash escaping the next character outside quotes. Good
 * enough for the cURL commands browsers/API tools actually generate — this
 * is not a full POSIX shell grammar (no `$()`, no variable expansion).
 */
function tokenizeShellLike(input: string): string[] {
  const tokens: string[] = [];
  const n = input.length;
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(input[i]!)) i++;
    if (i >= n) break;
    let token = "";
    let sawAny = false;
    while (i < n && !/\s/.test(input[i]!)) {
      sawAny = true;
      const c = input[i]!;
      if (c === "'") {
        const close = input.indexOf("'", i + 1);
        const end = close === -1 ? n : close;
        token += input.slice(i + 1, end);
        i = end + 1;
      } else if (c === '"') {
        let j = i + 1;
        let buf = "";
        while (j < n && input[j] !== '"') {
          if (input[j] === "\\" && j + 1 < n && '"\\$`'.includes(input[j + 1]!)) {
            buf += input[j + 1];
            j += 2;
          } else {
            buf += input[j];
            j++;
          }
        }
        token += buf;
        i = j + 1;
      } else if (c === "\\") {
        if (i + 1 < n) {
          token += input[i + 1];
          i += 2;
        } else {
          i++;
        }
      } else {
        token += c;
        i++;
      }
    }
    if (sawAny) tokens.push(token);
  }
  return tokens;
}

/**
 * Parses one or more cURL commands into the manual-tools array shape.
 *
 * Multiple commands may be separated by blank lines, by plain newlines, or
 * span several lines via a trailing shell line-continuation backslash (the
 * format browsers'/Postman's "Copy as cURL" produces) — any mix of the three
 * works, since continuations are joined into single logical lines first and
 * every remaining newline is then a command boundary.
 *
 * An optional `# comment` line immediately above a command supplies an
 * explicit tool name (curl itself has no such flag) — `# get_user` or
 * `# name: get_user` both work. Any other comment line is ignored.
 */
export function parseCurlCommand(input: string): RestToolDefinition[] {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("No cURL command provided");
  }

  const joined = input.replace(/\\[ \t]*\r?\n[ \t]*/g, " ");
  const rawLines = joined.split(/\r?\n/);

  const tools: RestToolDefinition[] = [];
  const usedNames = new Set<string>();
  let pendingName: string | undefined;

  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("#")) {
      const commentBody = line.slice(1).trim();
      if (commentBody) pendingName = commentBody.replace(/^name\s*:\s*/i, "");
      continue;
    }

    const tokens = tokenizeShellLike(line);
    const tool = parseSingleCurlCommand(tokens, pendingName, usedNames);
    pendingName = undefined;
    if (tool) tools.push(tool);
  }

  if (tools.length === 0) {
    throw new Error("No valid cURL command found in input");
  }
  return tools;
}

function parseSingleCurlCommand(
  tokens: string[],
  explicitName: string | undefined,
  usedNames: Set<string>,
): RestToolDefinition | null {
  if (tokens.length === 0) return null;
  let i = 0;
  if (tokens[i]!.toLowerCase() === "curl") i++;

  let methodFlag: string | undefined;
  const headerNames: string[] = [];
  let data: string | undefined;
  let sawUser = false;
  let url: string | undefined;

  for (; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "-X" || t === "--request") {
      methodFlag = tokens[++i];
    } else if (t.startsWith("-X") && t.length > 2 && !t.startsWith("--")) {
      // Combined form curl also accepts, e.g. `-XPOST` (no space).
      methodFlag = t.slice(2);
    } else if (t === "-H" || t === "--header") {
      const h = tokens[++i];
      if (h) {
        const idx = h.indexOf(":");
        if (idx > 0) headerNames.push(h.slice(0, idx).trim());
      }
    } else if (
      t === "-d" ||
      t === "--data" ||
      t === "--data-raw" ||
      t === "--data-binary" ||
      t === "--data-ascii" ||
      t === "--data-urlencode"
    ) {
      const val = tokens[++i];
      data = data === undefined ? val : `${data}&${val}`;
    } else if (t === "-u" || t === "--user") {
      i++; // consume the "user:pass" value — never inspected or persisted (see file-level doc comment)
      sawUser = true;
    } else if (t === "--url") {
      // curl's explicit URL flag. Without this special-case the generic
      // "unknown flag takes a value" branch below would consume the URL token
      // as --url's swallowed value and the command would fail to import.
      const val = tokens[++i];
      if (val && !url) url = val;
    } else if (t.startsWith("--url=")) {
      // curl also accepts the `--url=<URL>` long-option form.
      const val = t.slice("--url=".length);
      if (val && !url) url = val;
    } else if (t === "--") {
      // curl's standard end-of-options marker (recommended before a URL that could
      // otherwise be misread as a flag, e.g. one starting with `-`) — not a flag
      // itself, so it must not swallow the following token as a "value".
      continue;
    } else if (t.startsWith("-") && t !== "-") {
      if (!isBooleanFlagToken(t)) i++; // best-effort: assume unknown flags take a value and skip it
    } else if (!url) {
      url = t;
    }
  }

  if (!url) return null;

  const rawMethod = (methodFlag ?? (data !== undefined ? "POST" : "GET")).toUpperCase();
  if (!SUPPORTED_METHODS.has(rawMethod as RestMethod)) return null; // e.g. HEAD/OPTIONS — not a registrable tool method
  const method = rawMethod as RestMethod;

  if (sawUser) headerNames.push("Authorization");

  const { path, queryKeys } = extractPathAndQuery(url);
  const bodyKeys = extractBodyKeys(data);

  const name = uniqueToolName(sanitizeToolName(explicitName ?? generateNameFromPath(method, path)), usedNames);

  return {
    name,
    method,
    endpoint: path,
    description: describeSource("cURL", method, path, headerNames),
    inputSchema: buildPermissiveSchema(queryKeys, bodyKeys),
  };
}

// -----------------------------------------------------------------------------
// Postman Collection v2.1
// -----------------------------------------------------------------------------

interface PostmanKeyValue {
  key?: string;
  value?: string;
  disabled?: boolean;
}

interface PostmanUrlObject {
  raw?: string;
  path?: (string | { value?: string })[];
  query?: PostmanKeyValue[];
}

interface PostmanBody {
  mode?: string;
  raw?: string;
  urlencoded?: PostmanKeyValue[];
  formdata?: PostmanKeyValue[];
  graphql?: { query?: string; variables?: string };
}

interface PostmanRequest {
  method?: string;
  header?: PostmanKeyValue[];
  url?: string | PostmanUrlObject;
  body?: PostmanBody;
}

interface PostmanItem {
  name?: string;
  request?: PostmanRequest;
  item?: PostmanItem[];
}

interface PostmanCollection {
  info?: { name?: string };
  item?: PostmanItem[];
}

/**
 * Parses a Postman Collection v2.1 export (`info` + a possibly-nested
 * `item[]` tree of folders/requests) into the manual-tools array shape.
 *
 * Folder flattening choice: nested folder names are joined with `_` as a
 * NAME PREFIX (e.g. folder "Users" > request "Get" -> `users_get`) rather
 * than flattened to bare request names. Real collections routinely reuse a
 * request name like "Get" or "List" inside multiple folders ("Users" > "Get",
 * "Orders" > "Get") — a bare-name flatten would silently collide those into
 * "get" / "get_2" with no indication of which folder each came from, whereas
 * prefixing keeps them distinct and traceable back to the source collection's
 * structure.
 */
export function parsePostmanCollection(json: unknown): RestToolDefinition[] {
  if (json === null || typeof json !== "object") {
    throw new Error("Postman collection must be a JSON object");
  }
  const collection = json as PostmanCollection;
  if (!Array.isArray(collection.item)) {
    throw new Error("Postman collection is missing its top-level 'item' array");
  }

  const tools: RestToolDefinition[] = [];
  const usedNames = new Set<string>();

  function walk(items: PostmanItem[], folderPath: string[]): void {
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      if (Array.isArray(item.item)) {
        walk(item.item, item.name ? [...folderPath, item.name] : folderPath);
        continue;
      }
      if (!item.request) continue;
      const tool = parsePostmanLeaf(item, folderPath, usedNames);
      if (tool) tools.push(tool);
    }
  }
  walk(collection.item, []);

  if (tools.length === 0) {
    throw new Error("No valid requests found in Postman collection");
  }
  return tools;
}

function parsePostmanLeaf(item: PostmanItem, folderPath: string[], usedNames: Set<string>): RestToolDefinition | null {
  const req = item.request;
  if (!req) return null;
  const rawMethod = (req.method ?? "GET").toUpperCase();
  if (!SUPPORTED_METHODS.has(rawMethod as RestMethod)) return null;
  const method = rawMethod as RestMethod;

  const { path, queryKeys } = extractPostmanUrl(req.url);
  if (path === null) return null;

  const headerNames = (req.header ?? [])
    .filter((h) => !h?.disabled)
    .map((h) => h?.key)
    .filter((k): k is string => Boolean(k));
  const bodyKeys = extractPostmanBodyKeys(req.body);

  const label = [...folderPath, item.name ?? ""].filter(Boolean).join("_") || generateNameFromPath(method, path);
  const name = uniqueToolName(sanitizeToolName(label), usedNames);

  return {
    name,
    method,
    endpoint: path,
    description: describeSource("Postman", method, path, headerNames),
    inputSchema: buildPermissiveSchema(queryKeys, bodyKeys),
  };
}

function extractPostmanUrl(url: PostmanRequest["url"]): { path: string | null; queryKeys: string[] } {
  if (!url) return { path: null, queryKeys: [] };
  if (typeof url === "string") return extractPathAndQuery(url);

  const structuredQueryKeys = (url.query ?? [])
    .filter((q) => !q?.disabled)
    .map((q) => q?.key)
    .filter((k): k is string => Boolean(k));
  if (Array.isArray(url.path) && url.path.length > 0) {
    const segments = url.path.map((seg) => (typeof seg === "string" ? seg : (seg?.value ?? "")));
    const path = `/${segments.filter(Boolean).join("/")}`;
    return { path, queryKeys: Array.from(new Set(structuredQueryKeys)) };
  }
  if (typeof url.raw === "string") {
    const fromRaw = extractPathAndQuery(url.raw);
    return { path: fromRaw.path, queryKeys: Array.from(new Set([...structuredQueryKeys, ...fromRaw.queryKeys])) };
  }
  return { path: null, queryKeys: [] };
}

function extractPostmanBodyKeys(body: PostmanBody | undefined): string[] {
  if (!body || !body.mode) return [];
  switch (body.mode) {
    case "raw":
      return extractBodyKeys(body.raw);
    case "urlencoded":
      return (body.urlencoded ?? [])
        .filter((e) => !e?.disabled)
        .map((e) => e?.key)
        .filter((k): k is string => Boolean(k));
    case "formdata":
      return (body.formdata ?? [])
        .filter((e) => !e?.disabled)
        .map((e) => e?.key)
        .filter((k): k is string => Boolean(k));
    case "graphql":
      return extractBodyKeys(body.graphql?.variables);
    default:
      return [];
  }
}

// -----------------------------------------------------------------------------
// Shared helpers
// -----------------------------------------------------------------------------

/** Prepends a scheme when missing so bare-host cURL targets (curl's own default) still parse. */
function toParsedUrl(rawUrl: string): URL | null {
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawUrl) ? rawUrl : `http://${rawUrl.replace(/^\/\//, "")}`;
  try {
    return new URL(candidate);
  } catch {
    return null;
  }
}

function extractPathAndQuery(rawUrl: string): { path: string; queryKeys: string[] } {
  const parsed = toParsedUrl(rawUrl);
  if (!parsed) {
    // Unparseable (e.g. a raw Postman `{{baseUrl}}/...` template that never
    // got resolved to a real host) — fall back to treating the string itself
    // as a literal path so the tool is still registrable.
    const bare = (rawUrl.split("?")[0] ?? rawUrl).trim();
    return { path: bare.startsWith("/") ? bare : `/${bare}`, queryKeys: [] };
  }
  return { path: parsed.pathname || "/", queryKeys: Array.from(new Set(parsed.searchParams.keys())) };
}

/**
 * Extracts top-level key names from a request-body string for the permissive
 * schema: a JSON object body contributes its own keys; a urlencoded-looking
 * body (`a=1&b=2`) contributes its param names. Anything else (arrays,
 * scalars, XML, plain text) contributes nothing — there is no reasonable set
 * of "keys" to infer, and proxy.ts always sends a JSON object body built from
 * the tool's declared args, so a non-object payload cannot be represented as
 * typed fields here regardless.
 */
function extractBodyKeys(data: string | undefined): string[] {
  if (data === undefined) return [];
  const trimmed = data.trim();
  if (!trimmed) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.keys(parsed as Record<string, unknown>);
    }
    return [];
  } catch {
    // not JSON — fall through to urlencoded handling below
  }
  if (/^[^&=\s]+=/.test(trimmed)) {
    try {
      return Array.from(new Set(Array.from(new URLSearchParams(trimmed).keys())));
    } catch {
      return [];
    }
  }
  return [];
}

function buildPermissiveSchema(queryKeys: string[], bodyKeys: string[]): Record<string, unknown> {
  const properties: Record<string, { type: string }> = {};
  for (const key of [...queryKeys, ...bodyKeys]) {
    properties[key] = { type: "string" };
  }
  return { type: "object" as const, properties };
}

function generateNameFromPath(method: string, path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments.length > 0 ? `${method}_${segments.join("_")}`.toLowerCase() : method.toLowerCase();
}

function describeSource(kind: "cURL" | "Postman", method: string, path: string, headerNames: string[]): string {
  const base = `Imported from ${kind}: ${method} ${path}`;
  const uniqueHeaders = Array.from(new Set(headerNames));
  if (uniqueHeaders.length === 0) return base;
  return `${base}. Headers seen on the source request (not applied automatically — configure upstream auth or a request transform if needed): ${uniqueHeaders.join(", ")}`;
}
