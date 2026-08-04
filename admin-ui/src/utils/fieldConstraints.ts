/**
 * The numeric limits each admin form must enforce, mirrored from the backend
 * validator that will reject the value if the form lets it through.
 *
 * These exist because the create forms validated with `parseOptionalNumber`, which
 * accepts ANY finite number, while the API is stricter. Measured against a running
 * backend, all four of these were accepted by the form and answered with a 400:
 *
 *   monthlyQuota: -5      -> "monthlyQuota must be a positive integer or null"
 *   monthlyQuota: 2.7     -> "monthlyQuota must be a positive integer or null"
 *   endUserRateLimitPerMin: 0 -> "endUserRateLimitPerMin must be a positive integer or null"
 *   timeoutMs: 900000     -> "timeoutMs at most 600000 ms"
 *
 * So the user typed a value, waited for a round trip, and got a server-worded message
 * at the bottom of the form instead of inline feedback at the field (Nielsen H5:
 * prevent the error rather than report it).
 *
 * `src/__tests__/admin-ui-field-constraints.test.ts` in the BACKEND project reads this
 * file and asserts each entry still matches the validator named in its comment — a
 * plain unit test here could only pin these numbers to themselves, and the failure
 * mode is precisely the two sides drifting apart. Cross-project import is impossible
 * by design (admin-ui shares zero dependencies with the backend), so that gate reads
 * the source text.
 *
 * Fields deliberately absent: alerts' `threshold` and `minCalls`. Their backend
 * validator is a bare `optNumberOrNull(v)` with no constraints, so the permissive
 * client check already agrees and tightening it here would reject values the API
 * accepts.
 */

/** Backend: `optNumberOrNull(v, { integer: true, min: 1 })` in routes/admin/consumers.ts */
export const CONSUMER_QUOTA = { integer: true, min: 1 } as const;

/** Backend: `optNumberOrNull(v, { integer: true, min: 1 })` in routes/admin/consumers.ts */
export const CONSUMER_END_USER_RATE_LIMIT = { integer: true, min: 1 } as const;

/** Backend: `optNumberOrNull(v, { min: Number.MIN_VALUE })` in routes/admin/policies.ts */
export const POLICY_RATE_LIMIT = { min: Number.MIN_VALUE } as const;

/**
 * Backend: `optNumberOrNull(v, { min: Number.MIN_VALUE, max: MAX_GUARD_TIMEOUT_MS })`
 * in routes/admin/policies.ts, where MAX_GUARD_TIMEOUT_MS is 600_000.
 */
export const POLICY_TIMEOUT_MS = { min: Number.MIN_VALUE, max: 600_000 } as const;

/** Backend: `Number.isInteger(v) && v >= 1` in routes/admin/ws-proxy-admin.ts */
export const WS_MAX_CONNECTIONS = { integer: true, min: 1 } as const;

/** Backend: `Number.isInteger(v) && v >= 1` in routes/admin/ws-proxy-admin.ts */
export const WS_MAX_MESSAGE_BYTES = { integer: true, min: 1 } as const;

/**
 * Backend: `Number.isInteger(idleTimeoutMs) && idleTimeoutMs >= 1`. The form collects
 * MINUTES and multiplies by 60_000, so any whole minute >= 1 satisfies the ms rule.
 */
export const WS_IDLE_TIMEOUT_MINUTES = { integer: true, min: 1 } as const;
