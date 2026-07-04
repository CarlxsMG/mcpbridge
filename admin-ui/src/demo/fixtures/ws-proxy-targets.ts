import type { WsProxyTarget } from "@/types/api";
import { days } from "./time";

export const wsProxyTargets: WsProxyTarget[] = [
  {
    name: "iot-gateway",
    backendWsUrl: "wss://iot.internal/socket",
    resolvedIp: "203.0.113.20",
    maxConnections: 10,
    maxMessageBytes: 1_048_576,
    idleTimeoutMs: 300_000,
    enabled: true,
    activeConnections: 3,
    createdAt: days(30),
    updatedAt: days(2),
  },
  {
    name: "legacy-feed",
    backendWsUrl: "wss://feed.legacy.internal/stream",
    resolvedIp: "203.0.113.21",
    maxConnections: 5,
    maxMessageBytes: 262_144,
    idleTimeoutMs: 120_000,
    enabled: false,
    activeConnections: 0,
    createdAt: days(60),
    updatedAt: days(10),
  },
];
