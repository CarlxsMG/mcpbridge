import { getDb } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import {
  listBundles,
  getBundleDetail,
  createBundle,
  updateBundle,
  type BundleToolRef,
} from "../tool-composition/bundles.js";
import { listAlertRules, createAlertRule, updateAlertRule, type AlertEventType } from "../../observability/alerts.js";
import { setGuardrails, firstUnsafeDenyPattern } from "../../tool-policies/guardrails.js";
import { applyToolMutations, readToolPolicies } from "../tool-policies/mutations/index.js";
import {
  listConsumers,
  getConsumerByName,
  createConsumer,
  updateConsumer,
  isValidQuotaValue,
} from "../entities/consumers.js";
import type { ClientGuardConfig, ToolOverride, ToolGuardrails } from "../../mcp/types.js";

export const CONFIG_EXPORT_VERSION = 1;

/**
 * One tool's exported config: its name, plus every policy in the per-tool
 * mutation registry read back in the exact shape `PATCH
 * /admin-api/clients/:name/tools/:tool` accepts — so this object IS a PATCH
 * body, and import replays it through the same validate/apply/audit path an
 * admin's PATCH takes.
 *
 * That is why the policy fields are an index signature rather than a
 * hand-written list. The hand-written list is what went wrong: it named
 * enabled/guards/override and nothing else, so cache, coalesce, pagination,
 * streaming, transform, mock, redaction, sensitivity, quarantine, monitor,
 * graphql, ws, context budget and approval thresholds were silently absent
 * from every export, snapshot and rollback.
 *
 * `override` (singular) is the pre-manifest spelling of the `overrides` PATCH
 * key. Still read on import so documents exported by an older gateway — and
 * snapshots already sitting in config_snapshots — keep applying.
 */
interface ExportedTool {
  name: string;
  /** Legacy alias for the `overrides` key, normalized away on import. */
  override?: ToolOverride | null;
  [policyKey: string]: unknown;
}
interface ExportedClient {
  name: string;
  enabled: boolean;
  guards: ClientGuardConfig | null;
  tools: ExportedTool[];
}
interface ExportedBundle {
  name: string;
  description: string | null;
  enabled: boolean;
  tools: BundleToolRef[];
  /**
   * Composite (macro) tool names this bundle also exposes — carried so a bundle
   * round-trips losslessly. Optional for back-compat: pre-composite export
   * documents (and CLI callers) omit it, and import treats absent as none.
   */
  composites?: string[];
}
interface ExportedAlert {
  name: string;
  eventType: AlertEventType;
  enabled: boolean;
  webhookUrl: string;
  threshold: number | null;
  minCalls: number | null;
}
interface ExportedGuardrail {
  client: string;
  tool: string;
  guardrails: ToolGuardrails;
}
interface ExportedConsumer {
  name: string;
  monthlyQuota: number | null;
  endUserRateLimitPerMin?: number | null;
}

export interface ConfigExport {
  version: number;
  exportedAt: number;
  bundles: ExportedBundle[];
  alertRules: ExportedAlert[];
  clients: ExportedClient[];
  /**
   * Legacy top-level location for per-tool guardrails. No longer emitted —
   * `guardrails` is an entry in the per-tool mutation registry, so it now
   * travels inside each tool like every other policy. Still read on import, so
   * documents exported by an older gateway (and snapshots already stored in
   * config_snapshots) keep applying unchanged.
   */
  guardrails?: ExportedGuardrail[];
  consumers: ExportedConsumer[];
}

export interface ImportSkip {
  type: "bundle" | "alert" | "client" | "tool" | "guardrail" | "consumer";
  id: string;
  reason: string;
}
export interface ImportResult {
  dryRun: boolean;
  applied: {
    bundles: number;
    alertRules: number;
    clientsConfigured: number;
    toolsConfigured: number;
    guardrails: number;
    consumers: number;
  };
  skipped: ImportSkip[];
}

/**
 * Serializes admin-authored config into a portable document.
 *
 * What round-trips through export→import:
 *   - bundles (name, description, enabled, member tools, and composite macros)
 *   - alert rules
 *   - per-client config: enabled flag and client guards
 *   - per-tool config: EVERY policy in the mutation registry
 *     (src/admin/tool-policies/mutations), read through `readToolPolicies`.
 *     Adding a policy there adds it here — that coupling is the point. This
 *     used to be a hand-picked trio (enabled/guards/overrides) plus guardrails,
 *     so fifteen policies were silently absent from every snapshot and every
 *     rollback.
 *   - consumers (name, monthlyQuota, endUserRateLimitPerMin)
 *
 * Still deliberately NOT included, and the UI says so rather than implying a
 * complete backup: schedules, guard policies, teams, users, catalog entries,
 * WebSocket proxy targets, and any decrypted secret (upstream credentials stay
 * in their own encrypted table). For a genuinely complete copy of the admin
 * database, use `POST /admin-api/backup`, which is a full SQLite snapshot.
 *
 * Tool key-allowlists are exported as their SHA-256 hashes, which round-trip.
 */
export function exportConfig(): ConfigExport {
  const db = getDb();

  const bundles: ExportedBundle[] = listBundles()
    .map((b) => getBundleDetail(b.name))
    .filter((b): b is NonNullable<typeof b> => b != null)
    .map((b) => ({
      name: b.name,
      description: b.description,
      enabled: b.enabled,
      tools: b.tools,
      composites: b.composites,
    }));

  const alertRules: ExportedAlert[] = listAlertRules().map((r) => ({
    name: r.name,
    eventType: r.eventType,
    enabled: r.enabled,
    webhookUrl: r.webhookUrl,
    threshold: r.threshold,
    minCalls: r.minCalls,
  }));

  const clientNames = (db.query(`SELECT name FROM clients ORDER BY name`).all() as { name: string }[]).map(
    (r) => r.name,
  );
  const clients: ExportedClient[] = [];
  for (const name of clientNames) {
    const d = registry.getClientDetail(name);
    if (!d) continue;
    clients.push({
      name: d.name,
      enabled: d.enabled,
      guards: d.guards ?? null,
      // Every policy the PATCH endpoint accepts, in the shape it accepts them.
      // Unset policies are omitted by readToolPolicies, so a tool nobody has
      // configured still exports as just `{ name, enabled }`.
      tools: d.tools.map((t) => ({ name: t.name, ...readToolPolicies(name, t.name) })),
    });
  }

  const consumers: ExportedConsumer[] = listConsumers().map((c) => ({
    name: c.name,
    monthlyQuota: c.monthlyQuota,
    endUserRateLimitPerMin: c.endUserRateLimitPerMin,
  }));

  return {
    version: CONFIG_EXPORT_VERSION,
    exportedAt: Date.now(),
    bundles,
    alertRules,
    clients,
    consumers,
  };
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/**
 * Turns one exported tool into the PATCH body `applyToolMutations` consumes:
 * drop `name` (it identifies the target, it is not a policy) and normalize the
 * pre-manifest `override` spelling onto the registry's `overrides` key.
 *
 * Everything else passes through untouched — including keys this gateway does
 * not recognize, which `applyToolMutations` simply ignores. That is what lets a
 * document exported by a NEWER gateway (one with a policy this build lacks)
 * still apply the policies this build does understand, instead of being
 * rejected wholesale.
 */
function toPatchBody(tool: ExportedTool): Record<string, unknown> {
  const { name: _name, override, ...rest } = tool;
  void _name;
  const body: Record<string, unknown> = { ...rest };
  if (override !== undefined && body.overrides === undefined) body.overrides = override;
  return body;
}

/**
 * Applies (or, with dryRun, plans) a config document. Self-contained entities
 * (alerts, bundles) are created; per-client config (enabled / guards /
 * overrides) is applied only to already-registered clients — anything whose
 * dependency is missing is skipped and reported, never fabricated.
 */
export async function importConfig(
  data: unknown,
  opts: { dryRun: boolean },
  actor: string | null,
): Promise<ImportResult> {
  if (typeof data !== "object" || data === null) {
    throw new Error("import body must be an object");
  }
  const doc = data as Record<string, unknown>;
  if (doc.version !== CONFIG_EXPORT_VERSION) {
    throw new Error(`unsupported export version: ${String(doc.version)} (expected ${CONFIG_EXPORT_VERSION})`);
  }

  const db = getDb();
  const dryRun = opts.dryRun;
  const skipped: ImportSkip[] = [];
  const applied = { bundles: 0, alertRules: 0, clientsConfigured: 0, toolsConfigured: 0, guardrails: 0, consumers: 0 };

  const toolExists = db.query(`SELECT 1 FROM tools WHERE client_name = ? AND name = ?`);
  const clientExists = db.query(`SELECT 1 FROM clients WHERE name = ?`);

  // Alert rules — created by name, or updated in place when one already exists.
  //
  // The update branch is what makes `pull` -> `apply` a clean round trip. Alert
  // rules used to be the ONLY create-only section here (consumers update,
  // bundles/clients/tools/guardrails are configured), so re-importing a
  // document this very gateway had just exported reported every existing rule
  // as skipped — and the CLI's `apply` treats any skip as a failure, so the
  // pull/edit/apply loop exited 1 on any gateway with at least one alert rule
  // even though nothing was wrong. Making this section idempotent like all the
  // others fixes the cause rather than teaching `apply` to ignore a skip.
  for (const r of asArray<ExportedAlert>(doc.alertRules)) {
    const existing = db.query(`SELECT id, event_type FROM alert_rules WHERE name = ?`).get(r.name) as {
      id: number;
      event_type: string;
    } | null;
    if (existing) {
      // `event_type` is immutable (updateAlertRule cannot change it, and the
      // alert loop keys its edge-triggering state off the rule id), so a
      // same-name/different-type rule genuinely cannot be applied. That is a
      // REAL skip, unlike the "already exists" one this replaces.
      if (existing.event_type !== r.eventType) {
        skipped.push({
          type: "alert",
          id: r.name,
          reason: `already exists with event type "${existing.event_type}", cannot be changed to "${r.eventType}"`,
        });
        continue;
      }
      if (!dryRun) {
        updateAlertRule(existing.id, {
          enabled: r.enabled,
          webhookUrl: r.webhookUrl,
          threshold: r.threshold ?? null,
          minCalls: r.minCalls ?? null,
        });
      }
      applied.alertRules++;
      continue;
    }
    if (!dryRun) {
      createAlertRule({
        name: r.name,
        eventType: r.eventType,
        webhookUrl: r.webhookUrl,
        threshold: r.threshold ?? null,
        minCalls: r.minCalls ?? null,
        // Carried explicitly: a rule exported while disabled must come back
        // disabled, not silently re-enabled by the create default.
        enabled: r.enabled,
        actor,
      });
    }
    applied.alertRules++;
  }

  // Bundles — created or replaced. Skipped when they reference unknown tools
  // (or when `tools` isn't an array at all — a hand-edited/foreign-schema
  // document must degrade to a reported skip, not throw mid-import).
  for (const b of asArray<ExportedBundle>(doc.bundles)) {
    if (!Array.isArray(b.tools)) {
      skipped.push({ type: "bundle", id: b.name, reason: "tools field is not an array" });
      continue;
    }
    const missing = b.tools.filter((t) => !toolExists.get(t.client, t.tool));
    if (missing.length > 0) {
      skipped.push({ type: "bundle", id: b.name, reason: `${missing.length} unknown tool(s)` });
      continue;
    }
    // Composites round-trip too; a foreign/hand-edited doc may omit the field
    // or make it a non-array — treat that as "no composites", never throw.
    const composites = Array.isArray(b.composites) ? b.composites : [];
    if (!dryRun) {
      if (db.query(`SELECT 1 FROM mcp_bundles WHERE name = ?`).get(b.name)) {
        await updateBundle(b.name, {
          description: b.description ?? null,
          enabled: b.enabled,
          tools: b.tools,
          composites,
        });
      } else {
        await createBundle(b.name, b.description ?? undefined, b.tools, actor ?? "import", composites);
      }
    }
    applied.bundles++;
  }

  // Per-client config — applied only to registered clients.
  for (const c of asArray<ExportedClient>(doc.clients)) {
    if (!clientExists.get(c.name)) {
      skipped.push({ type: "client", id: c.name, reason: "not registered" });
      continue;
    }
    if (!dryRun) {
      await registry.setClientEnabled(c.name, c.enabled);
      await registry.setClientGuards(c.name, c.guards ?? null);
    }
    applied.clientsConfigured++;

    // A hand-edited/foreign-schema document may carry a present-but-non-array
    // `tools` (e.g. `{}`); iterating it would throw mid-import (this loop isn't
    // transactional). Degrade to a reported skip, matching the bundles loop's
    // fail-soft contract above. An absent/null `tools` stays legitimate — it
    // simply means "no per-tool config" and iterates zero via `?? []`.
    if (c.tools != null && !Array.isArray(c.tools)) {
      skipped.push({ type: "client", id: c.name, reason: "tools field is not an array" });
      continue;
    }
    for (const t of c.tools ?? []) {
      if (!toolExists.get(c.name, t.name)) {
        skipped.push({ type: "tool", id: `${c.name}__${t.name}`, reason: "not found" });
        continue;
      }
      if (!dryRun) {
        // stopOnFirstFailure: false — one bad key must not discard the rest of
        // the tool's config. A hand-edited document can carry a displayName
        // alias that now collides, and a monitor references a tool_examples row
        // that may not exist on the instance being restored onto. Both are
        // reported per key and the remaining policies still apply, matching the
        // partial-application behaviour the hand-written loop had.
        const { failures } = await applyToolMutations(
          toPatchBody(t),
          { actor: actor ?? "import", clientName: c.name, toolName: t.name },
          { stopOnFirstFailure: false },
        );
        for (const f of failures) {
          skipped.push({ type: "tool", id: `${c.name}__${t.name}`, reason: `${f.key}: ${f.message}` });
        }
      }
      applied.toolsConfigured++;
    }
  }

  // Guardrails — applied only to already-registered tools. Deny patterns are
  // re-validated here (not only at the interactive admin route) because a
  // hand-edited config, a rollback, or the config-as-code CLI apply could
  // otherwise persist a catastrophic-backtracking (ReDoS) pattern straight to the
  // guardrail hot path, where a single crafted argument payload would pin a CPU
  // core — a gateway-wide DoS. Mirrors the quota re-validation the consumers loop
  // below already performs for the same "config bypasses the admin-api" reason.
  for (const g of asArray<ExportedGuardrail>(doc.guardrails)) {
    if (!toolExists.get(g.client, g.tool)) {
      skipped.push({ type: "guardrail", id: `${g.client}__${g.tool}`, reason: "tool not found" });
      continue;
    }
    const denyPatterns = g.guardrails?.denyPatterns;
    if (Array.isArray(denyPatterns)) {
      const unsafe = firstUnsafeDenyPattern(denyPatterns.filter((p): p is string => typeof p === "string"));
      if (unsafe) {
        skipped.push({ type: "guardrail", id: `${g.client}__${g.tool}`, reason: unsafe });
        continue;
      }
    }
    if (!dryRun) {
      setGuardrails(g.client, g.tool, g.guardrails ?? null);
    }
    applied.guardrails++;
  }

  // Consumers — created if unknown by name, otherwise their quota is updated.
  // A hand-edited gateway.yaml (or any importConfig caller) could otherwise
  // sneak in a value the admin-api route would reject outright — e.g. a
  // monthlyQuota/endUserRateLimitPerMin of 0 or -1, which checkConsumerQuota
  // /checkEndUserRateLimit would then treat as "always exceeded", silently
  // locking every one of that consumer's keys out with no error at import time.
  for (const c of asArray<ExportedConsumer>(doc.consumers)) {
    if (!isValidQuotaValue(c.monthlyQuota) || !isValidQuotaValue(c.endUserRateLimitPerMin)) {
      skipped.push({
        type: "consumer",
        id: c.name,
        reason: "monthlyQuota/endUserRateLimitPerMin must be a positive integer or null",
      });
      continue;
    }
    if (!dryRun) {
      const existing = getConsumerByName(c.name);
      if (existing) {
        updateConsumer(existing.id, {
          monthlyQuota: c.monthlyQuota ?? null,
          endUserRateLimitPerMin: c.endUserRateLimitPerMin ?? null,
        });
      } else {
        createConsumer({
          name: c.name,
          monthlyQuota: c.monthlyQuota ?? null,
          endUserRateLimitPerMin: c.endUserRateLimitPerMin ?? null,
          actor,
        });
      }
    }
    applied.consumers++;
  }

  return { dryRun, applied, skipped };
}
