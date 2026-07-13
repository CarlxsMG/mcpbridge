import { getDb } from "../db/connection.js";
import { getSecretsProvider } from "../secrets/index.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import { toolExists, upsertConfig } from "../lib/tool-config.js";
import { errorMessage } from "../lib/error-message.js";

/**
 * Per-tool "context budget" guardrail — an MCP-specific problem a generic API
 * gateway doesn't solve: an agent calling a chatty REST API through this
 * bridge can blow through its own context window on a single verbose tool
 * response. Two modes, both opt-in via a `tool_context_budget` row (no row =
 * no budget enforced at all, preserving today's unbounded behavior):
 *
 *   - "truncate" (default once configured, zero external calls): cut the
 *     response at `maxResponseBytes` on a valid UTF-8 boundary and append a
 *     deterministic marker noting how many bytes were omitted.
 *   - "llm_summarize" (opt-in, bring-your-own-key): ask an admin-configured
 *     OpenAI- or Anthropic-compatible endpoint to compress the response
 *     instead. Any failure (network, non-2xx, timeout) falls back to the
 *     deterministic truncate behavior rather than failing the tool call.
 *
 * SECURITY-CRITICAL: enforcement (`applyContextBudget`) must only ever be
 * called by proxy.ts AFTER redaction and AFTER the guardrails output-scan —
 * this module has no way to enforce that itself, it just trusts the text it's
 * handed. Sending pre-redaction data to a third-party LLM would be a real
 * data-exfiltration risk.
 *
 * The LLM base URL is operator/admin-configured infrastructure (like
 * OTEL_EXPORTER_OTLP_ENDPOINT or a Vault address), not a per-tenant registered
 * backend — it deliberately does NOT go through the resolved-IP-pinning SSRF
 * defense that applies to user-registered health_url/base_url/openapi_url.
 */

export type ContextBudgetMode = "truncate" | "llm_summarize";
export type ContextBudgetLlmProvider = "openai" | "anthropic";

export interface ContextBudgetLlmPublic {
  provider: ContextBudgetLlmProvider;
  baseUrl: string;
  model: string;
}

/** Public read-model (admin UI, client-detail JSON) — never exposes the encrypted key ref. */
export interface ContextBudgetPublic {
  mode: ContextBudgetMode;
  maxResponseBytes: number;
  llm: ContextBudgetLlmPublic | null;
}

/** Internal read-model (proxy dispatch) — carries the encrypted key ref needed to decrypt for the outbound call. */
interface ContextBudgetInternal {
  mode: ContextBudgetMode;
  maxResponseBytes: number;
  llm: (ContextBudgetLlmPublic & { apiKeyRef: string }) | null;
}

interface Row {
  mode: string;
  max_response_bytes: number;
  llm_provider: string | null;
  llm_base_url: string | null;
  llm_model: string | null;
  llm_api_key_ref: string | null;
}

const SELECT_COLS = `mode, max_response_bytes, llm_provider, llm_base_url, llm_model, llm_api_key_ref`;

function rowToInternal(row: Row): ContextBudgetInternal {
  const llm =
    row.llm_provider && row.llm_base_url && row.llm_model && row.llm_api_key_ref
      ? {
          provider: row.llm_provider as ContextBudgetLlmProvider,
          baseUrl: row.llm_base_url,
          model: row.llm_model,
          apiKeyRef: row.llm_api_key_ref,
        }
      : null;
  return { mode: row.mode as ContextBudgetMode, maxResponseBytes: row.max_response_bytes, llm };
}

function toPublic(internal: ContextBudgetInternal): ContextBudgetPublic {
  return {
    mode: internal.mode,
    maxResponseBytes: internal.maxResponseBytes,
    llm: internal.llm
      ? { provider: internal.llm.provider, baseUrl: internal.llm.baseUrl, model: internal.llm.model }
      : null,
  };
}

/** Internal read (proxy dispatch) — includes the encrypted key ref. Null = no budget configured for this tool. */
export function getToolContextBudget(clientName: string, toolName: string): ContextBudgetInternal | null {
  const row = getDb()
    .query(`SELECT ${SELECT_COLS} FROM tool_context_budget WHERE client_name = ? AND tool_name = ?`)
    .get(clientName, toolName) as Row | null;
  return row ? rowToInternal(row) : null;
}

/** Context-budget config for every tool of a client, keyed by tool name (batched for detail views; public shape). */
export function getContextBudgetForClient(clientName: string): Record<string, ContextBudgetPublic> {
  const rows = getDb()
    .query(`SELECT tool_name, ${SELECT_COLS} FROM tool_context_budget WHERE client_name = ?`)
    .all(clientName) as (Row & { tool_name: string })[];
  const out: Record<string, ContextBudgetPublic> = {};
  for (const r of rows) out[r.tool_name] = toPublic(rowToInternal(r));
  return out;
}

/** Floor on the configurable budget — small enough to be pointless below this is almost certainly a mistake. */
export const MIN_CONTEXT_BUDGET_BYTES = 256;

export type ContextBudgetError = "TOOL_NOT_FOUND" | "SECRETS_PROVIDER_UNCONFIGURED" | "SECRETS_PROVIDER_ERROR";

export type ContextBudgetInput =
  | { mode: "truncate"; maxResponseBytes: number }
  | {
      mode: "llm_summarize";
      maxResponseBytes: number;
      llm: { provider: ContextBudgetLlmProvider; baseUrl: string; model: string; apiKey: string };
    };

/**
 * Persists (or clears, with `null`) a tool's context-budget config. Mirrors
 * backend-auth/oauth.ts's setClientOAuth one-way-encrypt-on-write pattern: a raw API key is
 * only ever accepted here, run through getSecretsProvider().encryptSecret(),
 * and never echoed back — there is no "keep the existing key" partial update,
 * exactly like OAuth client secrets, so every write to llm_summarize mode
 * requires the admin to resupply the raw key.
 */
export async function setToolContextBudget(
  clientName: string,
  toolName: string,
  input: ContextBudgetInput | null,
): Promise<{ ok: true } | { ok: false; error: ContextBudgetError; reason?: string }> {
  const db = getDb();
  if (!toolExists(clientName, toolName)) {
    return { ok: false, error: "TOOL_NOT_FOUND" };
  }
  if (input === null) {
    db.query(`DELETE FROM tool_context_budget WHERE client_name = ? AND tool_name = ?`).run(clientName, toolName);
    return { ok: true };
  }

  let llmProvider: string | null = null;
  let llmBaseUrl: string | null = null;
  let llmModel: string | null = null;
  let llmApiKeyRef: string | null = null;

  if (input.mode === "llm_summarize") {
    const secretsProvider = getSecretsProvider();
    if (!secretsProvider.isConfigured()) return { ok: false, error: "SECRETS_PROVIDER_UNCONFIGURED" };
    try {
      llmApiKeyRef = await secretsProvider.encryptSecret(input.llm.apiKey);
    } catch (err) {
      return { ok: false, error: "SECRETS_PROVIDER_ERROR", reason: errorMessage(err) };
    }
    llmProvider = input.llm.provider;
    llmBaseUrl = input.llm.baseUrl;
    llmModel = input.llm.model;
  }

  upsertConfig(
    "tool_context_budget",
    { client_name: clientName, tool_name: toolName },
    {
      mode: input.mode,
      max_response_bytes: input.maxResponseBytes,
      llm_provider: llmProvider,
      llm_base_url: llmBaseUrl,
      llm_model: llmModel,
      llm_api_key_ref: llmApiKeyRef,
    },
    Date.now(),
  );
  return { ok: true };
}

// ── Deterministic truncation (pure, zero external calls) ───────────────────

export interface TruncateResult {
  text: string;
  truncated: boolean;
  originalBytes: number;
  keptBytes: number;
}

const textEncoder = new TextEncoder();
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** UTF-8 byte length of a string (what an upstream/LLM would actually be billed/sized on). */
export function byteLength(text: string): number {
  return textEncoder.encode(text).length;
}

/**
 * Cuts `text` to at most `maxBytes` UTF-8 bytes on a valid character boundary
 * (never splits a multi-byte sequence) and appends a deterministic, greppable
 * marker noting how many bytes were omitted. Pure and side-effect free.
 */
export function truncateToBudget(text: string, maxBytes: number): TruncateResult {
  const full = textEncoder.encode(text);
  if (full.length <= maxBytes) {
    return { text, truncated: false, originalBytes: full.length, keptBytes: full.length };
  }

  let end = Math.max(0, maxBytes);
  let kept = "";
  while (end > 0) {
    try {
      kept = strictUtf8Decoder.decode(full.subarray(0, end));
      break;
    } catch {
      end--; // landed mid-sequence — back off one byte and retry
    }
  }

  const omitted = full.length - end;
  const marker = `\n\n[context-budget: response truncated — kept ${end} of ${full.length} bytes, ${omitted} byte(s) omitted to stay within the ${maxBytes}-byte limit]`;
  return { text: kept + marker, truncated: true, originalBytes: full.length, keptBytes: end };
}

// ── Opt-in LLM summarization ────────────────────────────────────────────────

const SUMMARIZE_SYSTEM_PROMPT =
  "You compress verbose API/tool responses for an AI agent operating under a limited context window. " +
  "Produce a compressed-but-faithful summary that preserves every fact, id, and value the agent would need to act on. " +
  "Never invent data that is not present in the input.";

function summarizePrompt(text: string, maxResponseBytes: number): string {
  return (
    `The following tool response is ${byteLength(text)} bytes, exceeding this tool's ${maxResponseBytes}-byte context budget. ` +
    `Compress it into a faithful summary targeting roughly ${maxResponseBytes} bytes or fewer, preserving all information relevant to completing the calling agent's task.\n\n` +
    `<tool_response>\n${text}\n</tool_response>`
  );
}

/** Injectable fetch (tests mock this — never asserts against a real LLM provider). */
let fetchImpl: typeof fetch = fetch;
export function __setContextBudgetFetchForTesting(fn: typeof fetch): void {
  fetchImpl = fn;
}
export function __resetContextBudgetForTesting(): void {
  fetchImpl = fetch;
}

async function callOpenAiCompatible(
  llm: ContextBudgetLlmPublic,
  apiKey: string,
  text: string,
  maxResponseBytes: number,
): Promise<string> {
  const url = `${llm.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const resp = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: llm.model,
      messages: [
        { role: "system", content: SUMMARIZE_SYSTEM_PROMPT },
        { role: "user", content: summarizePrompt(text, maxResponseBytes) },
      ],
    }),
    signal: AbortSignal.timeout(config.contextBudgetLlmTimeoutMs),
  });
  if (!resp.ok) throw new Error(`OpenAI-compatible summarize request failed with HTTP ${resp.status}`);
  const json = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("OpenAI-compatible summarize response is missing choices[0].message.content");
  }
  return content;
}

/** Rough, conservative token estimate (~3 bytes/token for compressed prose) clamped to a sane request range. */
function estimateMaxTokens(maxResponseBytes: number): number {
  return Math.min(8_192, Math.max(256, Math.ceil(maxResponseBytes / 3)));
}

async function callAnthropic(
  llm: ContextBudgetLlmPublic,
  apiKey: string,
  text: string,
  maxResponseBytes: number,
): Promise<string> {
  const url = `${llm.baseUrl.replace(/\/+$/, "")}/v1/messages`;
  const resp = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: llm.model,
      max_tokens: estimateMaxTokens(maxResponseBytes),
      system: SUMMARIZE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: summarizePrompt(text, maxResponseBytes) }],
    }),
    signal: AbortSignal.timeout(config.contextBudgetLlmTimeoutMs),
  });
  if (!resp.ok) throw new Error(`Anthropic summarize request failed with HTTP ${resp.status}`);
  const json = (await resp.json()) as { content?: Array<{ type?: string; text?: string }> };
  const block = json.content?.find((b) => b.type === "text" && typeof b.text === "string");
  if (!block?.text) throw new Error("Anthropic summarize response is missing content[] text block");
  return block.text;
}

async function summarizeWithLlm(
  text: string,
  llm: ContextBudgetLlmPublic & { apiKeyRef: string },
  maxResponseBytes: number,
): Promise<string> {
  const apiKey = await getSecretsProvider().decryptSecret(llm.apiKeyRef);
  return llm.provider === "openai"
    ? callOpenAiCompatible(llm, apiKey, text, maxResponseBytes)
    : callAnthropic(llm, apiKey, text, maxResponseBytes);
}

// ── Enforcement entry point (called from proxy.ts) ──────────────────────────

export type ContextBudgetOutcome = "none" | "truncate" | "llm_summarize" | "llm_summarize_fallback_truncate";

export interface ContextBudgetResult {
  text: string;
  applied: ContextBudgetOutcome;
}

/**
 * The single enforcement entry point. Callers (proxy.ts) MUST only invoke this
 * with text that has already passed through redaction and the guardrails
 * output-scan — see the module doc comment. Zero-config default: a tool with
 * no `tool_context_budget` row returns the text unchanged (today's behavior).
 */
export async function applyContextBudget(
  clientName: string,
  toolName: string,
  mcpToolName: string,
  text: string,
): Promise<ContextBudgetResult> {
  const cfg = getToolContextBudget(clientName, toolName);
  if (!cfg) return { text, applied: "none" };

  if (byteLength(text) <= cfg.maxResponseBytes) return { text, applied: "none" };

  if (cfg.mode === "llm_summarize" && cfg.llm) {
    try {
      const summarized = await summarizeWithLlm(text, cfg.llm, cfg.maxResponseBytes);
      log("info", "Context budget: response compressed by configured LLM", {
        tool: mcpToolName,
        client: clientName,
        provider: cfg.llm.provider,
      });
      return { text: summarized, applied: "llm_summarize" };
    } catch (err) {
      log("warn", "Context budget: LLM summarization failed — falling back to deterministic truncation", {
        tool: mcpToolName,
        client: clientName,
        provider: cfg.llm.provider,
        error: errorMessage(err),
      });
      return { text: truncateToBudget(text, cfg.maxResponseBytes).text, applied: "llm_summarize_fallback_truncate" };
    }
  }

  return { text: truncateToBudget(text, cfg.maxResponseBytes).text, applied: "truncate" };
}
