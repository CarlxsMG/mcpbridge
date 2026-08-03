import type {
  AdminUserSummary,
  CompositeSummary,
  ConfigSnapshotSummary,
  EffectiveConfig,
  GuardPolicy,
  Schedule,
  Team,
} from "@/types/api";
import { demoKey, demoKeyByValue } from "../i18n-keys";
import { days, hours } from "./time";

// ─── Administration section fixtures (users, teams, policies, composites, ────
// schedules, config snapshots) — small, closely-related resources that all
// live under the "Administration" area of the admin UI and the matching
// section of demo.ts's route() dispatcher.

export const users: AdminUserSummary[] = [
  { username: "demo", role: "admin", is_active: true, created_at: days(120), last_login_at: hours(2), team_id: null },
  {
    username: "ops-oncall",
    role: "operator",
    is_active: true,
    created_at: days(60),
    last_login_at: days(1),
    team_id: 2,
  },
  {
    username: "auditor",
    role: "auditor",
    is_active: true,
    created_at: days(45),
    last_login_at: days(7),
    team_id: null,
  },
];

export const teams: Array<Team & { nameKey?: string }> = [
  {
    id: 1,
    name: "Platform",
    nameKey: demoKeyByValue("teams", "Platform", "name"),
    createdAt: days(120),
    createdBy: "demo",
  },
  {
    id: 2,
    name: "Support",
    nameKey: demoKeyByValue("teams", "Support", "name"),
    createdAt: days(90),
    createdBy: "demo",
  },
];

export const policies: Array<GuardPolicy & { nameKey?: string }> = [
  {
    id: 1,
    name: "Standard read",
    nameKey: demoKeyByValue("policies", "Standard read", "name"),
    rateLimitPerMin: 120,
    timeoutMs: 10000,
    createdAt: days(50),
    updatedAt: days(10),
    createdBy: "demo",
  },
  {
    id: 2,
    name: "Sensitive write",
    nameKey: demoKeyByValue("policies", "Sensitive write", "name"),
    rateLimitPerMin: 10,
    timeoutMs: 8000,
    createdAt: days(40),
    updatedAt: days(4),
    createdBy: "demo",
  },
];

export const composites: Array<CompositeSummary & { descriptionKey?: string }> = [
  {
    name: "triage_issue",
    description: "Search GitHub, then post a Slack summary",
    descriptionKey: demoKey("composites", "triage_issue", "description"),
    enabled: true,
    stepsCount: 2,
  },
  {
    name: "refund_and_notify",
    description: "Create a Stripe refund and DM the customer owner",
    descriptionKey: demoKey("composites", "refund_and_notify", "description"),
    enabled: true,
    stepsCount: 3,
  },
];

export const schedules: Schedule[] = [
  {
    id: 1,
    targetType: "client",
    clientName: "legacy-billing",
    toolName: null,
    action: "disable",
    cron: "0 2 * * *",
    enabled: true,
    lastRunMinute: null,
    createdAt: days(20),
    createdBy: "demo",
  },
  {
    id: 2,
    targetType: "tool",
    clientName: "stripe",
    toolName: "create_refund",
    action: "enable",
    cron: "0 8 * * 1-5",
    enabled: true,
    lastRunMinute: null,
    createdAt: days(15),
    createdBy: "demo",
  },
];

export const snapshots: Array<ConfigSnapshotSummary & { labelKey?: string }> = [
  {
    id: 12,
    label: "before rollout",
    labelKey: demoKeyByValue("snapshots", "before rollout", "label"),
    createdAt: days(2),
    createdBy: "demo",
  },
  {
    id: 11,
    label: "add billing-ops bundle",
    labelKey: demoKeyByValue("snapshots", "add billing-ops bundle", "label"),
    createdAt: days(9),
    createdBy: "demo",
  },
  {
    id: 10,
    label: "initial",
    labelKey: demoKeyByValue("snapshots", "initial", "label"),
    createdAt: days(30),
    createdBy: "demo",
  },
];

/**
 * A representative slice of GET /admin-api/config/effective for the public
 * demo. Values are the product's real defaults, not invented ones, so the demo
 * teaches the same thing the product would. The redacted entries are included
 * deliberately: showing "set"/"not set" IS the feature, and a demo that omitted
 * them would misrepresent what an operator sees.
 */
export const effectiveConfig: EffectiveConfig = {
  nodeEnv: "production",
  entries: [
    { key: "adminApiKeys", value: "set", redacted: true },
    { key: "allowPrivateIps", value: false, redacted: false },
    { key: "allowedOrigins", value: ["https://admin.example.com"], redacted: false },
    { key: "circuitBreakerFailureThreshold", value: 5, redacted: false },
    { key: "circuitBreakerResetTimeoutMs", value: 30000, redacted: false },
    { key: "healthCheckIntervalMs", value: 30000, redacted: false },
    { key: "maxResponseBytes", value: 10485760, redacted: false },
    { key: "maxSessions", value: 100, redacted: false },
    { key: "mcpApiKeys", value: "set", redacted: true },
    { key: "port", value: 3000, redacted: false },
    { key: "rateLimitGlobal", value: 600, redacted: false },
    { key: "rateLimitMcp", value: 120, redacted: false },
    { key: "requireMcpAuth", value: true, redacted: false },
    { key: "retryMaxAttempts", value: 3, redacted: false },
    { key: "secretEncryptionKey", value: "set", redacted: true },
    { key: "sessionTtlMs", value: 86400000, redacted: false },
    { key: "toolCallTimeoutMs", value: 30000, redacted: false },
    { key: "trustProxy", value: 1, redacted: false },
    { key: "vaultToken", value: "unset", redacted: true },
  ],
};
