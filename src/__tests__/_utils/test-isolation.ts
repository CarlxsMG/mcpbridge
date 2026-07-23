/**
 * Global per-test isolation of the process-wide state every test file shares.
 *
 * Loaded via `bunfig.toml`'s `[test] preload`, so these hooks wrap EVERY test.
 *
 * Why this exists: `bun test` runs all 372 test files in a single process. They
 * share one `bun:sqlite` connection, one `config` object, and one set of
 * rate-limiter counters. Any test that writes to those and doesn't restore leaks
 * into everything that runs afterwards — across file boundaries. Most files
 * clean up after themselves, but "most" is not enough: the suite became
 * order-dependent, and file discovery order comes from the filesystem, so the
 * victims changed per platform. It was green on the maintainer's Windows
 * checkout, failed one file on CI's Linux ordering, and failed three entirely
 * different ones in a Linux container. All of them passed in isolation.
 *
 * Each of the three resets below was added only after a specific observed
 * failure proved it was needed:
 *
 *  - **Database.** `mcpAuth`'s "no MCP keys configured" path is
 *    `config.mcpApiKeys.length === 0 && !hasAnyMcpKeys()`, and `hasAnyMcpKeys()`
 *    is a query. A managed key created by an earlier file made that test fail
 *    without any config being touched.
 *  - **Rate limiter.** Its per-endpoint counters are module-level Maps that
 *    accumulate for the whole run, so a file that exhausts an endpoint's quota
 *    makes later files receive 429s. The symptom was `routes-discovery.test.ts`
 *    expecting 400 and getting 429.
 *  - **Config.** Several files snapshot a value at module-load time and restore
 *    that, which faithfully restores someone else's pollution if it happened
 *    before the file loaded. Snapshotting per test sidesteps the ordering
 *    question entirely.
 *
 * The config snapshot is taken *before each test*, so a file's own `beforeAll`
 * has already run and is captured as part of the baseline — only what an
 * individual test changes is rolled back. Note it is shallow: reassigning
 * `config.adminApiKeys = [...]` is restored, but mutating that array in place is
 * not, since both objects then reference it.
 *
 * A `beforeAll` that seeds the DATABASE will not survive, because the reset runs
 * before each test. Seed from `beforeEach` instead.
 *
 * This is a safety net, not a licence to mutate shared state freely — prefer
 * `withConfig()` (same directory), which scopes an override to one block and
 * restores it even when the body throws.
 */
import { afterEach, beforeEach } from "bun:test";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { _internalsForTesting as rateLimiter } from "../../middleware/rate-limiter.js";

type MutableConfig = Record<string, unknown>;

const buckets = [
  rateLimiter.globalBuckets,
  rateLimiter.mcpBuckets,
  rateLimiter.registerBuckets,
  rateLimiter.toolBuckets,
  rateLimiter.loginBuckets,
  rateLimiter.installLinkBuckets,
  rateLimiter.backupBuckets,
  rateLimiter.ssoBuckets,
  rateLimiter.expensiveBuckets,
];

let snapshot: MutableConfig | null = null;

beforeEach(() => {
  __resetDbForTesting();
  for (const bucket of buckets) bucket.clear();
  snapshot = { ...(config as MutableConfig) };
});

afterEach(() => {
  if (!snapshot) return;
  const live = config as MutableConfig;
  // Drop keys a test added that weren't in the baseline...
  for (const key of Object.keys(live)) {
    if (!(key in snapshot)) delete live[key];
  }
  // ...then put every baseline value back.
  Object.assign(live, snapshot);
  snapshot = null;
});
