/**
 * The /mcp control plane's OWN prompts — gateway-authored slash-commands an
 * MCP host (Claude Desktop, Cursor, ...) can offer its user so their own
 * assistant walks them through configuring this gateway. The counterpart to
 * system-tools.ts: that file is what the assistant can DO, this one is what it
 * should do first.
 *
 * A prompt carries no capability of its own. Everything it tells the assistant
 * to do is an ordinary sys_* tool call that still passes runSystemTool()'s
 * role/step-up gate, so serving a prompt can never widen what a credential may
 * do — it only says which tools to reach for, and in what order.
 *
 * Two properties the text below is written to preserve, both easy to break by
 * "improving" the wording later:
 *
 *   - It degrades gracefully. Each prompt names the sys_* tools it expects but
 *     tells the assistant to work with whatever tools/list actually advertises.
 *     The catalog is role-filtered per caller and gains tools over time, so a
 *     prompt that hard-required a specific tool name would fail for a
 *     lower-tier caller and again on the next catalog change.
 *   - It never asks the assistant to route around the gateway's own gates.
 *     This text lands verbatim in someone's LLM context with administrator
 *     credentials in the same session; "turn the guard off so the call works"
 *     is exactly the instruction that must not be sitting there.
 */
import type { GetPromptResult, Prompt } from "@modelcontextprotocol/sdk/types.js";

/**
 * Caller-supplied argument values are interpolated into the rendered text, so
 * they are length-capped: an unbounded value would let a caller push arbitrary
 * bulk into the assistant's context under the gateway's own voice.
 */
const MAX_ARGUMENT_LENGTH = 512;

interface GatewayPromptArgument {
  name: string;
  description: string;
  required?: boolean;
}

interface GatewayPrompt {
  name: string;
  description: string;
  arguments: GatewayPromptArgument[];
  /** Renders the single user-role message. Receives only declared, already-validated arguments. */
  render: (args: Record<string, string | undefined>) => string;
}

/**
 * Collapses control characters (including newlines) in a caller-supplied value
 * to spaces. The rendered prompt is line-structured — steps, rules, a "the user
 * supplied this URL" line — so a value containing newlines could otherwise
 * forge additional instruction lines that read as if the gateway wrote them.
 * Written as a Unicode property escape rather than a literal control-character
 * range, because a literal range in a source regex is how a real NUL byte got
 * committed to this repo once and turned the file binary to git.
 */
function flattenToSingleLine(value: string): string {
  return value.replace(/\p{Cc}/gu, " ");
}

/**
 * Validates and normalizes the raw prompts/get arguments against what the
 * prompt declares. Throws for a malformed call — the SDK turns the throw into
 * a JSON-RPC error, which is the right shape here: unlike a tool call there is
 * no isError result channel for prompts/get.
 *
 * An UNDECLARED argument name is rejected rather than ignored. Silently
 * dropping it makes a typo ("toolName" for "tool") look like a successful call
 * that quietly rendered the generic, argument-less variant.
 */
function normalizeArguments(prompt: GatewayPrompt, raw: Record<string, string>): Record<string, string | undefined> {
  const declared = new Set(prompt.arguments.map((a) => a.name));
  for (const name of Object.keys(raw)) {
    if (!declared.has(name)) {
      throw new Error(`Prompt '${prompt.name}' has no argument named '${name}'`);
    }
  }

  const out: Record<string, string | undefined> = {};
  for (const arg of prompt.arguments) {
    const value = raw[arg.name];
    // A whitespace-only value is treated as absent, not as a supplied one:
    // rendering "The user supplied this source:  " is worse than rendering the
    // generic "ask them which source they have" variant.
    if (value === undefined || value.trim() === "") {
      if (arg.required) throw new Error(`Prompt '${prompt.name}' requires the '${arg.name}' argument`);
      out[arg.name] = undefined;
      continue;
    }
    if (value.length > MAX_ARGUMENT_LENGTH) {
      throw new Error(`Prompt '${prompt.name}' argument '${arg.name}' exceeds ${MAX_ARGUMENT_LENGTH} characters`);
    }
    out[arg.name] = flattenToSingleLine(value.trim());
  }
  return out;
}

const SHARED_TOOL_AVAILABILITY_NOTE = `You are connected to this gateway's control plane. Do the work by calling the sys_* tools this session advertises. If a tool named below is not in your tool list, say so plainly and continue with the tools you do have — the catalog is filtered by the caller's role and gains tools over time.`;

const GATEWAY_PROMPTS: GatewayPrompt[] = [
  {
    name: "onboard-a-backend",
    description:
      "Register one API or MCP server with this gateway, review the tools it discovers, and hand back a scoped connection.",
    arguments: [
      {
        name: "source",
        description: "The OpenAPI document URL, GraphQL endpoint, MCP server URL or cURL command, if known up front.",
      },
      {
        name: "kind",
        description: "What that source is, if known: openapi, graphql, mcp or curl.",
      },
    ],
    render: (args) => {
      const source = args.source;
      const kind = args.kind;
      const known = source
        ? `The user has already supplied this source: ${source}\n${
            kind ? `They describe it as: ${kind}\n` : ""
          }Confirm what it is before registering it, then start at step 2.\n\n`
        : "";
      return `Goal: register one backend with this MCP gateway and hand the user a working, scoped connection to it.

${SHARED_TOOL_AVAILABILITY_NOTE}

${known}Step 1 — Identify the source. This gateway can register four kinds of backend:
  - an OpenAPI/Swagger document URL — tools are discovered from the spec
  - a GraphQL endpoint — one tool per query and per mutation
  - an existing MCP server URL — its tools are re-exposed through this gateway
  - a cURL command or Postman collection — one tool per request
Ask the user which of those they have, and for the URL. Ask how the backend authenticates (none, bearer token, API key header, basic). Do not ask the user to paste a secret into the chat: tell them where the credential is entered instead.

Step 2 — Register it. Call sys_register_client with a name, the kind and the URL. Pick a short lowercase client name; it becomes the prefix of every tool name, and "__" may not appear inside it.
If registration is refused, read the gateway's error back to the user verbatim and explain it. The usual causes are: the URL resolves to a private or loopback address and SSRF protection blocked it, the spec could not be fetched or parsed, or the name is already taken.

Step 3 — Review what was discovered. Call sys_get_client (or sys_list_tools) for the new client and show the user the tools it found. Do not treat discovery as correct: point out anything that writes or deletes, anything that looks like an admin endpoint, and any tool whose description is too vague to trust.

Step 4 — Narrow before you widen. Disable the tools the user does not need with sys_set_tool_enabled — a tool that is never enabled cannot be called by anyone. If a guard-editing tool is advertised (for example sys_set_guard), offer to set a rate limit and a timeout on anything slow or expensive; otherwise tell the user which setting to change in the admin UI.

Step 5 — Mint a scoped credential. Call sys_mint_key for a key scoped to THIS client only. Never hand over the administrator credential you are holding right now as the client's key, and never mint a wider scope than the user asked for.

Step 6 — Hand over the config. Give the user the endpoint /mcp/<clientName> plus the new key, as a ready-to-paste MCP client entry with an Authorization: Bearer header. Tell them the key is shown once and cannot be read back.

Rules for this whole flow:
- Ask for explicit confirmation before anything that registers, deletes, or mints a credential.
- Never disable a guard, a rate limit or a confirmation requirement to make a call succeed. If a gate refuses, report the refusal.
- Do not guess a URL or a credential. If you do not have it, ask for it.`;
    },
  },
  {
    name: "diagnose-tool-failure",
    description:
      "Work out why one tool is failing on this gateway and explain the refusal, and the fix, in plain language.",
    arguments: [
      {
        name: "tool",
        description: 'The failing tool, ideally as its full "<client>__<tool>" name.',
        required: true,
      },
      {
        name: "error",
        description: "The error text or status the user saw, if they have it.",
      },
    ],
    render: (args) => {
      const reported = args.error ? `\nThe user reports this error: ${args.error}\n` : "";
      return `Goal: explain why the tool "${args.tool ?? ""}" is failing on this gateway, and give the user the concrete fix.

${SHARED_TOOL_AVAILABILITY_NOTE}
${reported}
Step 1 — Confirm the tool exists and is reachable. A tool name is "<client>__<tool>". Call sys_list_tools or sys_get_client for the owning client and check three things: is the client enabled, is the tool enabled, and is the client healthy.

Step 2 — Ask the gateway what happened. If a diagnostic tool is advertised (for example sys_diagnose), call it with the tool name first — it is the shortest path. Otherwise build the same picture yourself: sys_get_client for health and circuit-breaker state, sys_metrics for error and latency counts, sys_audit_tail for the most recent refusals involving this tool.

Step 3 — Name the layer that refused. Every call runs through one ordered pipeline; map what you found onto it:
  - credential or scope — the caller's key is not permitted to call this tool
  - the tool is disabled, or its client is disabled
  - a per-tool guard — rate limit, timeout, argument validation, required approval, required confirmation
  - a guardrail — the request or the response matched a content rule
  - the circuit breaker — repeated upstream failures opened it, so calls are refused before reaching the backend
  - the backend itself — a 4xx or 5xx from upstream, or a network, DNS or TLS failure
  - SSRF protection — the backend hostname now resolves to a private address

Step 4 — Explain, then fix. Say which layer refused in one plain sentence, then give the smallest change that fixes the actual problem: correct the argument, widen the key's scope, raise a limit that is genuinely too low, repair the backend, or reset the breaker once the backend is healthy again.

Rules:
- Do not recommend switching a security control off to make the error go away. If a guard really is mis-set, say which one, what the new value should be, and why that is still safe.
- If the evidence does not identify the layer, say so and list what you would need. Do not guess.
- Quote the gateway's error text verbatim. Do not paraphrase an error into something more reassuring than it is.`;
    },
  },
  {
    name: "harden-this-client",
    description:
      "Review one registered client's guards, limits, key scoping and enabled tools, and propose a safer configuration.",
    arguments: [
      {
        name: "client",
        description: "The registered client name to review.",
        required: true,
      },
    ],
    render: (args) => {
      const client = args.client ?? "";
      return `Goal: review the registered client "${client}" and move it to a safer configuration, with the user agreeing to each change.

${SHARED_TOOL_AVAILABILITY_NOTE}

Step 1 — Read the current posture. Call sys_get_client for "${client}" and note: which tools are enabled, what guards each one carries (rate limit, timeout, approval, confirmation), the health and circuit-breaker state, and — via sys_list_keys — which credentials can reach it.

Step 2 — Reduce the surface. Every tool nobody actually uses should be disabled with sys_set_tool_enabled. Anything that writes, deletes, spends money or sends a message to a third party should require confirmation before it runs.

Step 3 — Put limits on what stays. Propose a rate limit and a timeout for each remaining tool, sized to real usage rather than to the largest number that still works. Check that retries are not enabled for calls that are unsafe to repeat.

Step 4 — Scope the credentials. Aim for one key per consumer, scoped to this client, and to specific tools where the gateway supports it. List the keys that are broader than they need to be with sys_list_keys and offer to revoke them with sys_revoke_key — but confirm with the user first, because revoking a key breaks whoever is holding it.

Step 5 — Make it observable. Turn on guardrail response scanning for tools whose output could carry injected instructions, and redaction for anything returning personal data. Point out any tool with an error rate high enough to deserve an alert.

Step 6 — Present a plan, then apply it. Give the user a short numbered list of concrete changes with the reason for each, and apply only the ones they approve. If a guard-editing tool is advertised (for example sys_set_guard), use it; otherwise write out the exact setting to change in the admin UI.

Rules:
- Propose before you apply. Never make a change that breaks an existing consumer without saying so first.
- Do not weaken anything in this pass. If a limit is genuinely too tight, raise it as a separate step the user explicitly asks for.
- If a setting cannot be read with the tools available, report it as unknown rather than assuming it is already safe.`;
    },
  },
];

const promptByName = new Map(GATEWAY_PROMPTS.map((p) => [p.name, p]));

/** prompts/list for the /mcp system scope. Unlike listSystemTools there is no role filter — see getGatewayPrompt. */
export function listGatewayPrompts(): Prompt[] {
  return GATEWAY_PROMPTS.map((p) => ({
    name: p.name,
    description: p.description,
    arguments: p.arguments.map((a) => ({ name: a.name, description: a.description, required: a.required === true })),
  }));
}

/**
 * prompts/get for the /mcp system scope: renders `name` against `rawArgs`, or
 * returns undefined when no such gateway prompt exists (the caller decides
 * what a miss looks like on the wire). Throws on a malformed call — an
 * undeclared argument, a missing required one, or an over-long value.
 *
 * Deliberately NOT role-filtered, unlike listSystemTools: the rendered text is
 * static guidance, holds no gateway state, and every step it describes is
 * separately gated at call time by runSystemTool. Filtering it per tier would
 * only tell a lower-tier caller which prompts exist above them. Reaching this
 * function at all still requires a resolved system role — mcp-server.ts checks
 * that before calling in.
 */
export function getGatewayPrompt(name: string, rawArgs: Record<string, string>): GetPromptResult | undefined {
  const prompt = promptByName.get(name);
  if (!prompt) return undefined;
  const args = normalizeArguments(prompt, rawArgs);
  return {
    description: prompt.description,
    messages: [{ role: "user", content: { type: "text", text: prompt.render(args) } }],
  };
}
