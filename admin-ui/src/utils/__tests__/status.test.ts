import { describe, test, expect } from "vitest";
import { statusTone, toneColorVar, toneTextVar, type StatusTone } from "../status";

describe("statusTone", () => {
  test.each<[string, StatusTone]>([
    // StatusBadge.vue
    ["healthy", "good"],
    ["closed", "good"],
    ["degraded", "warn"],
    ["half_open", "warn"],
    ["unreachable", "bad"],
    ["open", "bad"],
    // KeysPage.vue
    ["active", "good"],
    ["revoked", "bad"],
    ["expired", "bad"],
    ["disabled", "neutral"],
    // MonitorsPage.vue
    ["drift", "warn"],
    ["failing", "bad"],
    ["never", "neutral"],
    // ApprovalsPage.vue
    ["pending", "warn"],
    ["approved", "good"],
    ["rejected", "bad"],
  ])("maps %s -> %s", (status, tone) => {
    expect(statusTone(status)).toBe(tone);
  });

  test("is case-insensitive (KeysPage's statusOf returns capitalized labels)", () => {
    expect(statusTone("Active")).toBe("good");
    expect(statusTone("REVOKED")).toBe("bad");
  });

  test("falls back to neutral for null/undefined/empty/unknown", () => {
    expect(statusTone(null)).toBe("neutral");
    expect(statusTone(undefined)).toBe("neutral");
    expect(statusTone("")).toBe("neutral");
    expect(statusTone("some_future_status")).toBe("neutral");
  });
});

describe("toneColorVar", () => {
  test("maps each tone to the exact style.css custom-property name", () => {
    expect(toneColorVar("good")).toBe("--ok");
    expect(toneColorVar("warn")).toBe("--canary");
    expect(toneColorVar("bad")).toBe("--breach");
    expect(toneColorVar("neutral")).toBe("--text-secondary");
  });
});

describe("toneTextVar", () => {
  test("maps each tone to the text-safe half of the pair", () => {
    expect(toneTextVar("good")).toBe("--ok-text");
    expect(toneTextVar("warn")).toBe("--canary-text");
    expect(toneTextVar("bad")).toBe("--breach-text");
    // Neutral has no -text counterpart: --text-secondary already IS a text token.
    expect(toneTextVar("neutral")).toBe("--text-secondary");
  });

  test("never returns a non-text token, so a caller cannot silently reuse a fill colour", () => {
    const tones: StatusTone[] = ["good", "warn", "bad", "neutral"];
    for (const tone of tones) {
      expect(["--ok", "--canary", "--breach"]).not.toContain(toneTextVar(tone));
    }
  });
});
