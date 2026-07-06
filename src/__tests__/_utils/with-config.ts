/**
 * Test-scoped override of the live `config` singleton.
 *
 * Snapshots the original values of every key in `patch`, applies the override,
 * runs `fn`, and then restores the originals — even when `fn` throws. Returns
 * the value `fn` resolves with so call sites can `await withConfig(...)` to
 * chain an assertion off the body.
 *
 * Replaces the old pattern of:
 *
 *   beforeEach(() => {
 *     (config as Record<string, unknown>).adminApiKeys = [KEY];
 *   });
 *   afterEach(() => {
 *     (config as Record<string, unknown>).adminApiKeys = original;
 *   });
 *
 *   // or
 *
 *   try {
 *     (config as Record<string, unknown>).x = v;
 *     // ...do thing...
 *   } finally {
 *     (config as Record<string, unknown>).x = orig;
 *   }
 *
 * with:
 *
 *   await withConfig({ adminApiKeys: [KEY] }, async () => {
 *     // ...do thing...
 *   });
 *
 * Why this is safe:
 *
 *  - Only the keys present in `patch` are snapshotted; everything else on
 *    `config` is untouched.
 *  - The restore runs in both the success and rejection branches of the
 *    returned promise (and via try/catch for the synchronous overload), so a
 *    thrown assertion never leaks the override into the next test.
 *  - The override goes through the same `Record<string, unknown>` escape
 *    hatch the old code used, so the runtime semantics are identical — this is
 *    a pure mechanical refactor, no behavior change.
 */
import { config } from "../../config.js";

type ConfigPatch = { readonly [K in keyof typeof config]?: (typeof config)[K] };

export function withConfig<T>(patch: ConfigPatch, fn: () => T): T;
export function withConfig<T>(patch: ConfigPatch, fn: () => Promise<T>): Promise<T>;
export function withConfig<T>(patch: ConfigPatch, fn: () => T | Promise<T>): T | Promise<T> {
  const originals: Record<string, unknown> = {};
  const keys = Object.keys(patch) as (keyof typeof config)[];
  for (const key of keys) {
    originals[key as string] = config[key];
    (config as Record<string, unknown>)[key as string] = patch[key];
  }
  const restore = (): void => {
    for (const [key, value] of Object.entries(originals)) {
      (config as Record<string, unknown>)[key] = value;
    }
  };
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.then(
        (value) => {
          restore();
          return value;
        },
        (err) => {
          restore();
          throw err;
        },
      );
    }
    restore();
    return result;
  } catch (err) {
    restore();
    throw err;
  }
}
