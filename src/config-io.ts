import { getDb } from "./db/connection.js";
import { registry, ToolOverrideError } from "./registry.js";
import { listBundles, getBundleDetail, createBundle, updateBundle, type BundleToolRef } from "./bundles.js";
import { listAlertRules, createAlertRule, type AlertEventType } from "./alerts.js";
import { getGuardrailsForClient, setGuardrails } from "./guardrails.js";
import { listConsumers, getConsumerByName, createConsumer, updateConsumer } from "./consumers.js";
import type { ClientGuardConfig, ToolGuardConfig, ToolOverride, ToolGuardrails } from "./types.js";

export const CONFIG_EXPORT_VERSION = 1;

interface ExportedTool {
  name: string;
  enabled: boolean;
  guards: ToolGuardConfig | null;
  override: ToolOverride | null;
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
}

export interface ConfigExport {
  version: number;
  exportedAt: number;
  bundles: ExportedBundle[];
  alertRules: ExportedAlert[];
  clients: ExportedClient[];
  guardrails: ExportedGuardrail[];
  consumers: ExportedConsumer[];
}

export interface ImportSkip {
  type: "bundle" | "alert" | "client" | "tool" | "guardrail" | "consumer";
  id: string;
  reason: string;
}
export interface ImportResult {
  dryRun: boolean;
  applied: { bundles: number; alertRules: number; clientsConfigured: number; toolsConfigured: number; guardrails: number; consumers: number };
  skipped: ImportSkip[];
}

/**
 * Serializes all admin-authored config into a portable document. Excludes
 * decrypted secrets (upstream credentials stay in their own encrypted table);
 * tool key-allowlists are exported as their SHA-256 hashes, which round-trip.
 */
export function exportConfig(): ConfigExport {
  const db = getDb();

  const bundles: ExportedBundle[] = listBundles()
    .map((b) => getBundleDetail(b.name))
    .filter((b): b is NonNullable<typeof b> => b != null)
    .map((b) => ({ name: b.name, description: b.description, enabled: b.enabled, tools: b.tools }));

  const alertRules: ExportedAlert[] = listAlertRules().map((r) => ({
    name: r.name,
    eventType: r.eventType,
    enabled: r.enabled,
    webhookUrl: r.webhookUrl,
    threshold: r.threshold,
    minCalls: r.minCalls,
  }));

  const clientNames = (db.query(`SELECT name FROM clients ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
  const clients: ExportedClient[] = [];
  const guardrails: ExportedGuardrail[] = [];
  for (const name of clientNames) {
    const d = registry.getClientDetail(name);
    if (!d) continue;
    clients.push({
      name: d.name,
      enabled: d.enabled,
      guards: d.guards ?? null,
      tools: d.tools.map((t) => ({ name: t.name, enabled: t.enabled, guards: t.guards ?? null, override: t.override ?? null })),
    });
    const clientGuardrails = getGuardrailsForClient(name);
    for (const [toolName, cfg] of Object.entries(clientGuardrails)) {
      guardrails.push({ client: name, tool: toolName, guardrails: cfg });
    }
  }

  const consumers: ExportedConsumer[] = listConsumers().map((c) => ({ name: c.name, monthlyQuota: c.monthlyQuota }));

  return { version: CONFIG_EXPORT_VERSION, exportedAt: Date.now(), bundles, alertRules, clients, guardrails, consumers };
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
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
  actor: string | null
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

  // Alert rules — created if a rule with the same name doesn't already exist.
  for (const r of asArray<ExportedAlert>(doc.alertRules)) {
    if (db.query(`SELECT 1 FROM alert_rules WHERE name = ?`).get(r.name)) {
      skipped.push({ type: "alert", id: r.name, reason: "already exists" });
      continue;
    }
    if (!dryRun) {
      createAlertRule({ name: r.name, eventType: r.eventType, webhookUrl: r.webhookUrl, threshold: r.threshold ?? null, minCalls: r.minCalls ?? null, actor });
    }
    applied.alertRules++;
  }

  // Bundles — created or replaced. Skipped when they reference unknown tools.
  for (const b of asArray<ExportedBundle>(doc.bundles)) {
    const missing = (b.tools ?? []).filter((t) => !toolExists.get(t.client, t.tool));
    if (missing.length > 0) {
      skipped.push({ type: "bundle", id: b.name, reason: `${missing.length} unknown tool(s)` });
      continue;
    }
    if (!dryRun) {
      if (db.query(`SELECT 1 FROM mcp_bundles WHERE name = ?`).get(b.name)) {
        await updateBundle(b.name, { description: b.description ?? null, enabled: b.enabled, tools: b.tools });
      } else {
        await createBundle(b.name, b.description ?? undefined, b.tools, actor ?? "import");
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

    for (const t of c.tools ?? []) {
      if (!toolExists.get(c.name, t.name)) {
        skipped.push({ type: "tool", id: `${c.name}__${t.name}`, reason: "not found" });
        continue;
      }
      if (!dryRun) {
        await registry.setToolEnabled(c.name, t.name, t.enabled);
        await registry.setToolGuards(c.name, t.name, t.guards ?? null);
        try {
          await registry.setToolOverride(c.name, t.name, t.override ?? null);
        } catch (err) {
          if (err instanceof ToolOverrideError) {
            // A hand-edited config can carry a colliding/invalid displayName alias;
            // apply the rest of the tool config and report the override as skipped.
            skipped.push({ type: "tool", id: `${c.name}__${t.name}`, reason: `override: ${err.message}` });
          } else {
            throw err;
          }
        }
      }
      applied.toolsConfigured++;
    }
  }

  // Guardrails — applied only to already-registered tools.
  for (const g of asArray<ExportedGuardrail>(doc.guardrails)) {
    if (!toolExists.get(g.client, g.tool)) {
      skipped.push({ type: "guardrail", id: `${g.client}__${g.tool}`, reason: "tool not found" });
      continue;
    }
    if (!dryRun) {
      setGuardrails(g.client, g.tool, g.guardrails ?? null);
    }
    applied.guardrails++;
  }

  // Consumers — created if unknown by name, otherwise their quota is updated.
  for (const c of asArray<ExportedConsumer>(doc.consumers)) {
    if (!dryRun) {
      const existing = getConsumerByName(c.name);
      if (existing) {
        updateConsumer(existing.id, { monthlyQuota: c.monthlyQuota ?? null });
      } else {
        createConsumer({ name: c.name, monthlyQuota: c.monthlyQuota ?? null, actor });
      }
    }
    applied.consumers++;
  }

  return { dryRun, applied, skipped };
}
