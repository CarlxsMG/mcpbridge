/**
 * Logger secret redaction — nested recursion + wordlist. redactMeta is not
 * exported, so it's exercised through the public log() by capturing the JSON
 * entry written to console.log.
 */
import { describe, test, expect, spyOn } from "bun:test";
import { config } from "../config.js";
import { log } from "../logger.js";

/** Runs log() in JSON mode and returns the parsed entry it wrote. */
function captured(meta: Record<string, unknown>): Record<string, unknown> {
  const original = config.logFormat;
  (config as Record<string, unknown>).logFormat = "json";
  const spy = spyOn(console, "log").mockImplementation(() => {});
  try {
    log("info", "msg", meta);
    const line = spy.mock.calls.at(-1)?.[0];
    return JSON.parse(String(line)) as Record<string, unknown>;
  } finally {
    spy.mockRestore();
    (config as Record<string, unknown>).logFormat = original;
  }
}

describe("logger — secret redaction", () => {
  test("redacts a secret buried under non-secret keys (recursion)", () => {
    const e = captured({ response: { headers: { authorization: "Bearer must-not-leak-123" } } });
    const response = e.response as { headers: { authorization: string } };
    expect(response.headers.authorization).toBe("<redacted>");
  });

  test("redacts secrets inside arrays", () => {
    const e = captured({ items: [{ ok: true }, { token: "raw-token-value-123" }] });
    const items = e.items as Array<{ token?: string }>;
    expect(items[1].token).toBe("<redacted>");
  });

  test("redacts csrf (added to the wordlist)", () => {
    const e = captured({ csrf: "csrf-token-value" });
    expect(e.csrf).toBe("<redacted>");
  });

  test("keeps non-secret fields, incl. safe-suffix and diagnostic *Key names", () => {
    const e = captured({
      tokenCount: 3, // safe suffix "count"
      apiKeyId: "id-1", // safe suffix "id"
      secretName: "prod", // safe suffix "name"
      lbKey: "primary", // deliberately NOT redacted (bare "key" excluded)
      cacheKey: "abc:def", // ditto
      note: "a normal message",
    });
    expect(e.tokenCount).toBe(3);
    expect(e.apiKeyId).toBe("id-1");
    expect(e.secretName).toBe("prod");
    expect(e.lbKey).toBe("primary");
    expect(e.cacheKey).toBe("abc:def");
    expect(e.note).toBe("a normal message");
  });

  test("redacts a top-level secret-named key whole, without descending", () => {
    const e = captured({ authorization: { scheme: "Bearer", value: "xyz" } });
    expect(e.authorization).toBe("<redacted>");
  });
});
