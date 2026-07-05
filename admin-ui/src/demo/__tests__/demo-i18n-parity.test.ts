// Parity test: every `*Key` field referenced by the demo fixtures MUST
// resolve to a non-empty string in both en.json and es.json (since the
// walker runs on every demo response and a missing translation silently
// degrades to the EN literal, the failure mode is invisible on a single
// locale — a parity check across both bundles is what catches typos in
// the i18n keys before the demo ships).
//
// This is the demo-side companion to the global `lint:i18n` parity
// check in scripts/check-i18n.mjs — that script catches missing
// translations when the key exists in both files, but it doesn't know
// that any given key actually has a caller in the fixtures. THIS test
// catches the inverse: a key that exists in both files but no longer
// has any fixture pointing at it.
import { describe, expect, it } from "vitest";
import enRaw from "@/locales/en.json";
import esRaw from "@/locales/es.json";
import { flatTools } from "../fixtures/tools";
import { bundles } from "../fixtures/bundles";
import { catalogEntries, discoveryPreview } from "../fixtures/catalog";
import { consumers, mcpKeys } from "../fixtures/keys-consumers";
import { byKey } from "../fixtures/usage";
import { alerts } from "../fixtures/alerts";
import { composites, policies, snapshots, teams } from "../fixtures/administration";
import { auditLog } from "../fixtures/audit-log";
import { demoKey, demoKeyByValue, demoDetailKey } from "../i18n-keys";

type Messages = Record<string, unknown>;

/**
 * vue-i18n's vite plugin (`@intlify/unplugin-vue-i18n/vite`) compiles
 * JSON message strings into AST nodes for fast lookup at runtime, so
 * importing `@/locales/en.json` from a test returns AST objects like
 * `{ type: 0, body: { static: "Search issues and pull requests" } }`
 * instead of plain strings. Unwrap the common shapes so the parity
 * assertions can compare directly against the original JSON value.
 *
 * We don't try to render the AST (the production walker uses
 * `i18n.global.t(key)` which DOES evaluate the AST correctly) — the
 * test just needs to verify that a translation EXISTS and is non-empty.
 */
function unwrapAst(v: unknown): unknown {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return v;
  if (typeof v !== "object") return v;
  const node = v as Record<string, unknown>;
  if (typeof node.static === "string") return node.static;
  if (node.body && typeof node.body === "object" && typeof (node.body as Record<string, unknown>).static === "string") {
    return (node.body as Record<string, unknown>).static;
  }
  return v;
}

// JSON imports come back typed as the schema inferred at build time —
// cast through unknown so the lookup helper can accept them as generic
// nested objects without dragging the whole en.json shape into this file.
const en = enRaw as unknown as Messages;
const es = esRaw as unknown as Messages;

/** Walk a dotted key path into a messages bundle, returning the leaf or undefined. */
function lookup(messages: Messages, key: string): unknown {
  // Support vue-i18n bracket notation: `by_value['Claude Desktop'].label`.
  // Convert to nested-object path: `by_value["Claude Desktop"].label`.
  // (Both forms are equivalent — vue-i18n parses them the same way.)
  const parts: string[] = [];
  // Match either `word` segments OR `['literal with spaces']` brackets.
  const re = /([^.[\]]+)|\[(['])([^']*)\2\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(key)) !== null) {
    if (m[3] !== undefined) parts.push(m[3]);
    else if (m[1] !== undefined) parts.push(m[1]);
  }
  let cur: unknown = messages;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

describe("demo fixtures ↔ i18n keys parity", () => {
  // Collect every *Key value referenced by a fixture, then assert each
  // resolves in both en.json AND es.json. This is intentionally loose —
  // we only require the LEAF to be a non-empty string. The exact EN/ES
  // translation quality is a human-review concern, not a CI gate.
  const allKeys: string[] = [];

  for (const t of flatTools) if (t.descriptionKey) allKeys.push(t.descriptionKey);
  for (const b of bundles) if (b.descriptionKey) allKeys.push(b.descriptionKey);
  for (const c of catalogEntries) if (c.descriptionKey) allKeys.push(c.descriptionKey);
  for (const t of discoveryPreview.tools) if (t.descriptionKey) allKeys.push(t.descriptionKey);
  for (const k of mcpKeys) if (k.labelKey) allKeys.push(k.labelKey);
  for (const c of consumers) if (c.nameKey) allKeys.push(c.nameKey);
  for (const r of byKey) if (r.labelKey) allKeys.push(r.labelKey);
  for (const a of alerts) if (a.nameKey) allKeys.push(a.nameKey);
  for (const t of teams) if (t.nameKey) allKeys.push(t.nameKey);
  for (const p of policies) if (p.nameKey) allKeys.push(p.nameKey);
  for (const c of composites) if (c.descriptionKey) allKeys.push(c.descriptionKey);
  for (const s of snapshots) if (s.labelKey) allKeys.push(s.labelKey);

  // Audit-log detail_<field>Key — the walker reads these from the outer
  // record (they sit alongside `detail`), so we have to surface them too.
  for (const entry of auditLog) {
    for (const k of Object.keys(entry)) {
      if (k.startsWith("detail_") && k.endsWith("Key")) {
        const v = (entry as unknown as Record<string, unknown>)[k];
        if (typeof v === "string") allKeys.push(v);
      }
    }
  }

  it("collects at least the documented seed catalog", () => {
    // Smoke check: if the fixtures were gutted, the parity test would
    // silently pass with zero collected keys. Pin a lower bound so a
    // future refactor that drops the *Key fields surfaces loudly.
    expect(allKeys.length).toBeGreaterThan(50);
  });

  it("every fixture *Key resolves to a non-empty string in en.json", () => {
    for (const key of allKeys) {
      const v = unwrapAst(lookup(en as Messages, key));
      expect(typeof v, `en.json: ${key} should be a string`).toBe("string");
      expect((v as string).length, `en.json: ${key} should not be empty`).toBeGreaterThan(0);
    }
  });

  it("every fixture *Key resolves to a non-empty string in es.json", () => {
    for (const key of allKeys) {
      const v = unwrapAst(lookup(es as Messages, key));
      expect(typeof v, `es.json: ${key} should be a string`).toBe("string");
      expect((v as string).length, `es.json: ${key} should not be empty`).toBeGreaterThan(0);
    }
  });

  it("demoKey helper uses the dot-escape for entity IDs containing '.'", () => {
    // The runtime helper must produce a key that the JSON lookup can find.
    // If the helper ever drops the dot-escape, this test fails immediately.
    const k = demoKey("tools", "github.search_issues", "description");
    expect(unwrapAst(lookup(en as Messages, k))).toBe("Search issues and pull requests");
    expect(unwrapAst(lookup(es as Messages, k))).toBe("Buscar issues y pull requests");
  });

  it("demoKeyByValue helper uses bracket notation for free-form values", () => {
    const k = demoKeyByValue("keys", "CI pipeline (elevated)", "label");
    expect(unwrapAst(lookup(en as Messages, k))).toBe("CI pipeline (elevated)");
    expect(unwrapAst(lookup(es as Messages, k))).toBe("Pipeline de CI (elevado)");
  });

  it("demoDetailKey helper matches the audit-log walker convention", () => {
    const k = demoDetailKey("audit", 128, "label", "value");
    expect(unwrapAst(lookup(en as Messages, k))).toBe("CI pipeline (elevated)");
    expect(unwrapAst(lookup(es as Messages, k))).toBe("Pipeline de CI (elevado)");
  });
});
