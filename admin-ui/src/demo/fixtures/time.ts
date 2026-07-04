// ─────────────────────────────────────────────────────────────────────────────
// Shared time helpers for demo fixture data.
//
// Kept in their own module rather than inline in demo.ts because most of the
// fixtures/*.ts files below need `days()`/`hours()`/`hex()` (and occasionally
// `NOW`) to compute their own top-level timestamp literals. Importing these
// from demo.ts itself would create a circular import (demo.ts imports the
// fixture files, which would import back from demo.ts) that breaks at
// runtime: demo.ts's `const NOW = Date.now()` wouldn't have executed yet by
// the time a fixture module's top-level array literal tries to read it. None
// of these are routing literals (no `p === "..."`, no `/^.../` route regex),
// so moving them here doesn't touch the IRON RULE that route()'s matching
// literals must stay physically in demo.ts.
// ─────────────────────────────────────────────────────────────────────────────

export const NOW = Date.now();
export const days = (n: number): number => NOW - n * 86_400_000;
export const hours = (n: number): number => NOW - n * 3_600_000;
export const hex = (seed: number): string =>
  Array.from({ length: 16 }, (_, i) => (((seed * 2654435761 + i * 40503) >>> 0) % 16).toString(16)).join("");
