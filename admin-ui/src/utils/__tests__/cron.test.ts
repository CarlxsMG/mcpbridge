import { describe, test, expect } from "vitest";
import { describeCron, formatTimeOfDay } from "../cron";

describe("describeCron", () => {
  test.each([
    ["* * * * *", "Every minute"],
    ["*/15 * * * *", "Every 15 minutes"],
    ["*/1 * * * *", "Every 1 minute"],
    ["0 3 * * *", "Every day at 3:00 AM UTC"],
    ["30 15 * * *", "Every day at 3:30 PM UTC"],
    ["0 0 * * *", "Every day at 12:00 AM UTC"],
    ["0 12 * * *", "Every day at 12:00 PM UTC"],
    ["0 */4 * * *", "Every 4 hours, at minute 0"],
    ["0 9 * * 1", "Every Monday at 9:00 AM UTC"],
    ["0 9 * * 0,6", "Every Sunday, Saturday at 9:00 AM UTC"],
    ["0 9 * * 1,3,5", "Every Monday, Wednesday, Friday at 9:00 AM UTC"],
    ["0 3 15 * *", "On day 15 of the month at 3:00 AM UTC"],
    ["0 8 * * 1-5", "Every weekday at 8:00 AM UTC"],
    ["0 8 * * 2-4", "Every day from Tuesday to Thursday at 8:00 AM UTC"],
  ])("%s -> %s", (cron, expected) => {
    expect(describeCron(cron)).toBe(expected);
  });

  test("falls back to the raw expression for patterns it doesn't recognize", () => {
    expect(describeCron("*/5 9-17 * * 1-5")).toBe("*/5 9-17 * * 1-5");
  });

  test("falls back to the raw expression for malformed input", () => {
    expect(describeCron("not a cron")).toBe("not a cron");
    expect(describeCron("* * * *")).toBe("* * * *");
  });
});

describe("formatTimeOfDay", () => {
  test("formats midnight and noon as 12, not 0", () => {
    expect(formatTimeOfDay(0, 0)).toBe("12:00 AM UTC");
    expect(formatTimeOfDay(12, 0)).toBe("12:00 PM UTC");
  });

  test("pads minutes", () => {
    expect(formatTimeOfDay(9, 5)).toBe("9:05 AM UTC");
  });
});
