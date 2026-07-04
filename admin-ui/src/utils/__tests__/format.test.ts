import { describe, test, expect } from "vitest";
import { formatDateTime, formatMaybeDate, formatDuration, pct, prettyJson } from "../format";

describe("formatDateTime", () => {
  test("formats an epoch-ms value the same way Date#toLocaleString does", () => {
    const ms = Date.UTC(2026, 0, 15, 12, 30);
    expect(formatDateTime(ms)).toBe(new Date(ms).toLocaleString());
  });

  test("formats an ISO string", () => {
    const iso = "2026-07-04T00:00:00.000Z";
    expect(formatDateTime(iso)).toBe(new Date(iso).toLocaleString());
  });

  test("formats a Date instance", () => {
    const d = new Date(2026, 0, 1);
    expect(formatDateTime(d)).toBe(d.toLocaleString());
  });
});

describe("formatMaybeDate", () => {
  test("returns the default fallback for null", () => {
    expect(formatMaybeDate(null)).toBe("Never");
  });

  test("returns the default fallback for undefined", () => {
    expect(formatMaybeDate(undefined)).toBe("Never");
  });

  test("returns a caller-supplied fallback", () => {
    expect(formatMaybeDate(null, "Not yet")).toBe("Not yet");
  });

  test("delegates to formatDateTime for a real value", () => {
    const ms = Date.UTC(2026, 5, 1);
    expect(formatMaybeDate(ms)).toBe(formatDateTime(ms));
  });
});

describe("formatDuration", () => {
  test("sub-second durations show as whole milliseconds", () => {
    expect(formatDuration(850)).toBe("850ms");
  });

  test("zero ms", () => {
    expect(formatDuration(0)).toBe("0ms");
  });

  test("durations at or above 1000ms show as seconds with 2 decimal places", () => {
    expect(formatDuration(1250)).toBe("1.25s");
  });

  test("exactly 1000ms crosses over to the seconds form", () => {
    expect(formatDuration(1000)).toBe("1.00s");
  });

  test("999ms stays in the milliseconds form", () => {
    expect(formatDuration(999)).toBe("999ms");
  });
});

describe("pct", () => {
  test("formats a fraction as a percentage with 1 decimal place", () => {
    expect(pct(0.10499)).toBe("10.5%");
  });

  test("zero", () => {
    expect(pct(0)).toBe("0.0%");
  });

  test("values above 1 are not clamped (matches UsagePage's raw formatter)", () => {
    expect(pct(1.2)).toBe("120.0%");
  });
});

describe("prettyJson", () => {
  test("indents with 2 spaces", () => {
    expect(prettyJson({ a: 1, b: [1, 2] })).toBe(JSON.stringify({ a: 1, b: [1, 2] }, null, 2));
  });

  test("handles primitives", () => {
    expect(prettyJson("hi")).toBe('"hi"');
    expect(prettyJson(42)).toBe("42");
  });

  test("handles undefined the way JSON.stringify does (returns undefined, not a string)", () => {
    expect(prettyJson(undefined)).toBe(undefined);
  });
});
