import { describe, test, expect, afterEach } from "vitest";
import { toErrorMessage } from "../errors";
import { ApiError } from "@/composables/useApi";
import { i18n } from "@/i18n";

// The expected sentences are spelled out rather than read back from the locale
// JSON: `@intlify/unplugin-vue-i18n` pre-compiles the bundles to message ASTs
// at build time, so importing them here yields AST nodes, not strings — and an
// assertion that resolved the key through i18n would be comparing the lookup
// against itself anyway.
const EN_CLIENT_NOT_FOUND = "That server no longer exists, or you don't have access to it.";
const ES_CLIENT_NOT_FOUND = "Ese servidor ya no existe, o no tienes acceso a él.";

afterEach(() => {
  i18n.global.locale.value = "en";
});

describe("toErrorMessage", () => {
  test("surfaces the ApiError's own message", () => {
    const err = new ApiError(404, "not_found", "Resource not found.");
    expect(toErrorMessage(err, "Failed to load.")).toBe("Resource not found.");
  });

  test("prefers the localized sentence for a catalogued code", () => {
    const err = new ApiError(404, "CLIENT_NOT_FOUND", "Client not found");
    expect(toErrorMessage(err, "Failed to load.")).toBe(EN_CLIENT_NOT_FOUND);
  });

  test("follows the active locale", () => {
    i18n.global.locale.value = "es";
    const err = new ApiError(404, "CLIENT_NOT_FOUND", "Client not found");
    // The whole point: a Spanish interface showed English server messages on
    // every failure before the code lookup existed.
    expect(toErrorMessage(err, "Failed to load.")).toBe(ES_CLIENT_NOT_FOUND);
  });

  test("keeps the server message for a verbatim code, whose specifics a generic sentence would destroy", () => {
    // VALIDATION_ERROR is marked `verbatim` in the backend catalog precisely so
    // no key exists for it here; the field-level detail is worth more than a
    // translated generality. The backend test asserts the absence.
    const err = new ApiError(400, "VALIDATION_ERROR", "monthlyQuota must be a positive integer or null");
    expect(toErrorMessage(err, "Failed to save.")).toBe("monthlyQuota must be a positive integer or null");
  });

  test("keeps the server message for a code this UI has never heard of", () => {
    // A newer server than this bundle. Falling back beats rendering the raw key.
    const err = new ApiError(400, "SOME_FUTURE_CODE", "Something specific went wrong");
    expect(toErrorMessage(err, "Failed to save.")).toBe("Something specific went wrong");
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
