import type { AlertRule } from "@/types/api";
import { demoKey } from "../i18n-keys";
import { days, hours } from "./time";

export const alerts: Array<AlertRule & { nameKey?: string }> = [
  {
    id: 1,
    name: "CRM circuit breaker open",
    nameKey: demoKey("alerts", 1, "name"),
    eventType: "circuit_breaker_open",
    enabled: true,
    webhookUrl: "https://hooks.slack.com/services/T000/B000/xxx",
    threshold: null,
    minCalls: null,
    lastFiredAt: hours(20),
    createdAt: days(30),
    updatedAt: hours(20),
    createdBy: "demo",
  },
  {
    id: 2,
    name: "High error rate",
    nameKey: demoKey("alerts", 2, "name"),
    eventType: "error_rate",
    enabled: true,
    webhookUrl: "https://hooks.slack.com/services/T000/B001/yyy",
    threshold: 0.1,
    minCalls: 50,
    lastFiredAt: null,
    createdAt: days(21),
    updatedAt: days(21),
    createdBy: "demo",
  },
  {
    id: 3,
    name: "Usage spike detector",
    nameKey: demoKey("alerts", 3, "name"),
    eventType: "usage_spike",
    enabled: false,
    webhookUrl: "https://hooks.slack.com/services/T000/B002/zzz",
    threshold: 3,
    minCalls: 100,
    lastFiredAt: days(5),
    createdAt: days(14),
    updatedAt: days(3),
    createdBy: "demo",
  },
];
