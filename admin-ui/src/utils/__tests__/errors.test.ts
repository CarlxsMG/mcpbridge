import { describe, test, expect } from "vitest";
import { toErrorMessage } from "../errors";
import { ApiError } from "@/composables/useApi";

describe("toErrorMessage", () => {
  test("surfaces the ApiError's own message", () => {
    const err = new ApiError(404, "not_found", "Resource not found.");
    expect(toErrorMessage(err, "Failed to load.")).toBe("Resource not found.");
  });

  test("falls back for a generic Error (not an ApiError)", () => {
    const err = new Error("boom");
    expect(toErrorMessage(err, "Failed to load.")).toBe("Failed to load.");
  });

  test("falls back for a thrown non-Error value", () => {
    expect(toErrorMessage("some string was thrown", "Failed to load.")).toBe("Failed to load.");
    expect(toErrorMessage(undefined, "Failed to load.")).toBe("Failed to load.");
    expect(toErrorMessage({ weird: true }, "Failed to load.")).toBe("Failed to load.");
  });
});
