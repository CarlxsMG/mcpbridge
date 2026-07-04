import type { AlertRule } from "@/types/api";
import { days, hours } from "./time";

export const alerts: AlertRule[] = [
  {
    id: 1,
    name: "CRM circuit breaker open",
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
