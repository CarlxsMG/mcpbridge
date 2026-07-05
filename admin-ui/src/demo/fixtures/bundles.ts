import type { BundleInstallLink, BundleSummary } from "@/types/api";
import { demoKey } from "../i18n-keys";

export const bundles: Array<BundleSummary & { descriptionKey?: string }> = [
  {
    name: "support-agent",
    description: "Read-only GitHub + Slack tools for the support copilot",
    descriptionKey: demoKey("bundles", "support-agent", "description"),
    enabled: true,
    toolsCount: 5,
  },
  {
    name: "billing-ops",
    description: "Stripe refunds & invoice lookups for finance",
    descriptionKey: demoKey("bundles", "billing-ops", "description"),
    enabled: true,
    toolsCount: 4,
  },
  {
    name: "readonly-explorer",
    description: "Safe, read-only slice across every backend",
    descriptionKey: demoKey("bundles", "readonly-explorer", "description"),
    enabled: false,
    toolsCount: 7,
  },
];

// Populated at runtime by the POST .../install-links handler in demo.ts's
// route() — starts empty, same as the real backend on a fresh install.
export const installLinks: BundleInstallLink[] = [];
