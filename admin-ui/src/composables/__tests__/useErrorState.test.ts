import { describe, expect, it } from "vitest";
import { useErrorState } from "../useErrorState";
import { ApiError } from "../useApi";

describe("useErrorState", () => {
  it("captures an ApiError's message and correlation id", () => {
    const state = useErrorState();
    state.capture(new ApiError(404, "CLIENT_NOT_FOUND", "No such server.", "req-1"), "fallback");

    expect(state.message.value).toBe("No such server.");
    expect(state.requestId.value).toBe("req-1");
  });

  it("falls back for a non-ApiError and reports no correlation id", () => {
    const state = useErrorState();
    state.capture(new TypeError("Failed to fetch"), "Failed to load.");

    expect(state.message.value).toBe("Failed to load.");
    expect(state.requestId.value).toBeNull();
  });

  it("reports no correlation id when the ApiError carried none", () => {
    const state = useErrorState();
    state.capture(new ApiError(0, "INVALID_JSON", "Schema is not valid JSON."), "fallback");

    expect(state.message.value).toBe("Schema is not valid JSON.");
    expect(state.requestId.value).toBeNull();
  });

  it("clear() drops both halves", () => {
    const state = useErrorState();
    state.capture(new ApiError(500, "BOOM", "Server error.", "req-2"), "fallback");
    state.clear();

    expect(state.message.value).toBe("");
    expect(state.requestId.value).toBeNull();
  });

  // The reason requestId is a computed rather than a plain ref. useCreateForm
  // assigns a client-side validation message straight to `message`; a plain ref
  // would leave the previous API failure's id sitting next to it, pointing an
  // operator at an unrelated request.
  it("drops a captured id once the message is reassigned directly", () => {
    const state = useErrorState();
    state.capture(new ApiError(409, "DUPLICATE", "Name already taken.", "req-3"), "fallback");
    expect(state.requestId.value).toBe("req-3");

    state.message.value = "Name is required.";

    expect(state.requestId.value).toBeNull();
  });

  it("restores the id if the exact captured message is set back", () => {
    // Falls out of deriving from the message rather than tracking assignments.
    // Harmless — the id genuinely does belong to that message — and pinned here
    // so the behaviour is a decision rather than a surprise.
    const state = useErrorState();
    state.capture(new ApiError(409, "DUPLICATE", "Name already taken.", "req-4"), "fallback");
    state.message.value = "Name is required.";
    state.message.value = "Name already taken.";

    expect(state.requestId.value).toBe("req-4");
  });
});
