import { config } from "../../config.js";

/**
 * Read-only view of the configuration this process actually resolved at boot.
 *
 * There are 100+ environment variables, several of which change behaviour
 * silently and invisibly (`ALLOW_PRIVATE_IPS`, `AUTH_DISABLED`, `TRUST_PROXY`,
 * nine separate rate-limit buckets, `STRICT_CONFIG`). Until this existed an
 * operator had no way to see which values were in effect — "why is my rate
 * limit not applying" could only be answered by shelling into the container and
 * reading the environment, which is exactly the access an admin UI exists to
 * avoid needing.
 *
 * Read-only on purpose: env vars are process-scoped and take effect at boot, so
 * a writable endpoint would be lying about when a change applies.
 */

/**
 * Config keys whose VALUE must never leave the process.
 *
 * Each is still reported, as `"set"` or `"unset"` — which is the operationally
 * useful half ("is SECRET_ENCRYPTION_KEY configured at all?") without being the
 * dangerous half. `redactedConfigKeys` is exported so the test suite can assert
 * over it directly rather than re-deriving the list.
 *
 * Adding a secret to config.ts without adding it here is caught by the
 * structural test in `__tests__/effective-config.test.ts`, which fails on any
 * config key whose NAME looks secret-bearing and is neither redacted nor
 * explicitly acknowledged as safe. A denylist that only humans maintain is a
 * denylist that eventually misses one.
 */
export const redactedConfigKeys = [
  "adminApiKeys",
  "mcpApiKeys",
  "secretEncryptionKey",
  "vaultToken",
  "bootstrapAdminPassword",
] as const satisfies readonly (keyof typeof config)[];

const REDACTED = new Set<string>(redactedConfigKeys);

/** How a redacted key is reported: whether it is configured, never what it is. */
export type RedactedPresence = "set" | "unset";

export interface EffectiveConfigEntry {
  key: string;
  /** The resolved value, or a {@link RedactedPresence} marker when the key is redacted. */
  value: unknown;
  /** True when `value` is a presence marker rather than the real value. */
  redacted: boolean;
}

export interface EffectiveConfig {
  /** Node's NODE_ENV as this process sees it — the single most common cause of "it behaves differently here". */
  nodeEnv: string;
  /** Entries sorted by key, so a diff between two instances is a clean line-by-line comparison. */
  entries: EffectiveConfigEntry[];
}

/**
 * True when a redacted key currently holds something. An empty array counts as
 * unset — `ADMIN_API_KEYS=` parses to `[]`, and reporting that as "set" would
 * tell an operator auth material exists when it does not.
 */
function isPresent(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  // The array branch reads as a special case but is equivalent for every value
  // this can actually receive: redacted keys are `string | string[] |
  // undefined`, and `"abc".length > 0` agrees with the `return true` below on
  // every non-empty string. Kept because `unknown` does not promise that, and
  // because reading it as "an empty list is not auth material" is the point.
  // Stryker reports removing it as a survivor and always will.
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** Builds the redacted, sorted view of the live `config` object. */
export function getEffectiveConfig(): EffectiveConfig {
  const entries: EffectiveConfigEntry[] = Object.keys(config)
    .sort()
    .map((key) => {
      const raw = (config as Record<string, unknown>)[key];
      if (REDACTED.has(key)) {
        const presence: RedactedPresence = isPresent(raw) ? "set" : "unset";
        return { key, value: presence, redacted: true };
      }
      return { key, value: raw, redacted: false };
    });

  return { nodeEnv: process.env.NODE_ENV ?? "development", entries };
}
