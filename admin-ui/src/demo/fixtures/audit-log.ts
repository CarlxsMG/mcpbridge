import type { AuditLogEntry } from "@/types/api";
import { demoDetailKey } from "../i18n-keys";
import { days, hex, hours } from "./time";

// The audit-log entries use the `detail_<field>Key` convention: i18n keys
// for fields nested inside `detail` (which itself has no fixed schema —
// varies per action type) live as outer-object siblings named after the
// inner field they translate. `demo/resolve.ts` walks these and rewrites
// the matching `detail.<field>` in place.
export const auditLog: Array<AuditLogEntry & Record<string, unknown>> = [
  {
    id: 128,
    actor: "demo",
    action: "mcpkey.create",
    target: "key:3",
    detail: { label: "CI pipeline (elevated)", elevated: true },
    detail_labelKey: demoDetailKey("audit", 128, "label", "value"),
    createdAt: hours(2),
    hash: hex(128),
  },
  {
    id: 127,
    actor: "demo",
    action: "tool.guard.update",
    target: "stripe__create_refund",
    detail: { rateLimitPerMin: 10, timeoutMs: 8000 },
    createdAt: hours(6),
    hash: hex(127),
  },
  {
    id: 126,
    actor: "demo",
    action: "bundle.create",
    target: "bundle:billing-ops",
    detail: { tools: 4 },
    createdAt: hours(9),
    hash: hex(126),
  },
  {
    id: 125,
    actor: "demo",
    action: "client.disable",
    target: "legacy-billing",
    detail: null,
    createdAt: days(1),
    hash: hex(125),
  },
  {
    id: 124,
    actor: "demo",
    action: "alert.fire",
    target: "internal-crm",
    detail: { eventType: "circuit_breaker_open" },
    createdAt: days(1),
    hash: hex(124),
  },
  {
    id: 123,
    actor: "demo",
    action: "client.register",
    target: "github",
    detail: { kind: "mcp", tools: 8 },
    createdAt: days(2),
    hash: hex(123),
  },
  {
    id: 122,
    actor: "demo",
    action: "config.snapshot",
    target: "snapshot:12",
    detail: { label: "before rollout" },
    detail_labelKey: demoDetailKey("audit", 122, "label", "value"),
    createdAt: days(2),
    hash: hex(122),
  },
  {
    id: 121,
    actor: "demo",
    action: "user.login",
    target: "demo",
    detail: { method: "session" },
    createdAt: days(3),
    hash: hex(121),
  },
  {
    id: 120,
    actor: "demo",
    action: "team.create",
    target: "team:2",
    detail: { name: "Support" },
    detail_nameKey: demoDetailKey("audit", 120, "name", "value"),
    createdAt: days(4),
    hash: hex(120),
  },
  {
    id: 119,
    actor: "demo",
    action: "client.register",
    target: "stripe",
    detail: { kind: "rest", tools: 12 },
    createdAt: days(5),
    hash: hex(119),
  },
];
