/**
 * Stryker mutation-testing gap-closer for SECRET_PATTERNS + the blockSecrets
 * gate + the reason template in guardrails.ts (~28 surviving mutants across
 * the 7 entries: AWS access key id, private key block, JWT, GitHub token,
 * Slack token, Google API key, OpenAI-style key).
 *
 * Survivor shapes and how each is killed here:
 *   1. `name` string literal emptied to "" — killed by asserting the exact
 *      `.reason` text (`arguments appear to contain a secret (<name>)`), not
 *      just `.blocked === true`.
 *   2. Character-class negation (e.g. `[A-Za-z0-9]` -> `[^A-Za-z0-9]`) —
 *      killed by an ordinary positive match using only the class's own
 *      allowed characters (a negated class would reject them).
 *   3. Quantifier reduction (e.g. `{16}` -> `{1}`, `{8,}` -> exactly-one,
 *      `{35}` -> `{1}`, `{20,}`/`{36,}`/`{10,}` -> `{1}`) — the tricky one.
 *      A same-length-or-longer positive example can't distinguish real from
 *      mutant (both match). Instead each boundary test puts exactly ONE
 *      valid character in the quantified run *immediately followed by a
 *      delimiter* (space, `.`, or end of string) — that's simultaneously
 *      (a) far short of the real minimum, so the real regex must NOT match
 *      (`blocked === false`), and (b) exactly long enough to satisfy an
 *      exact-one-reduced mutant, which WOULD match — so if the mutant is
 *      present this same assertion fails. Verified against both the real
 *      regexes and hand-built `{1}`/no-quantifier mutants before writing
 *      (see task notes) — every boundary case below flips as expected.
 *   4. The private-key pattern's optional prefix group,
 *      `(?:RSA |EC |OPENSSH |DSA |PGP )?`, made required — killed by a bare
 *      "-----BEGIN PRIVATE KEY-----" (no prefix) still getting blocked.
 *   5. The `if (cfg.blockSecrets)` gate forced always-true — killed by a
 *      `blockSecrets: false` config with an obvious secret in the args
 *      staying unblocked (only the deny-pattern loop can block it then).
 *
 * Pure function, no DB/registry/async setup — same convention as
 * ../guardrails.test.ts's "secret detection catches high-signal shapes" case.
 */
import { describe, test, expect } from "bun:test";
import { checkInputGuardrails } from "../guardrails.js";

const cfg = { denyPatterns: [], blockSecrets: true, scanResponses: false };

describe("checkInputGuardrails — SECRET_PATTERNS boundary coverage", () => {
  describe("AWS access key id", () => {
    test("realistic key (AKIA + exactly 16 alnum) is blocked with the exact reason", () => {
      const r = checkInputGuardrails(cfg, { key: "AKIA1234567890ABCDEF" });
      expect(r.blocked).toBe(true);
      expect(r.reason).toBe("arguments appear to contain a secret (AWS access key id)");
    });

    test("boundary: AKIA + only 1 char (below the {16} minimum) is not blocked", () => {
      const r = checkInputGuardrails(cfg, { note: "note AKIAX is short" });
      expect(r.blocked).toBe(false);
    });
  });

  describe("private key block", () => {
    test("with RSA prefix is blocked with the exact reason", () => {
      const r = checkInputGuardrails(cfg, { pem: "-----BEGIN RSA PRIVATE KEY-----" });
      expect(r.blocked).toBe(true);
      expect(r.reason).toBe("arguments appear to contain a secret (private key block)");
    });

    test("bare, with no RSA/EC/OPENSSH/DSA/PGP prefix, is still blocked (prefix group is optional)", () => {
      const r = checkInputGuardrails(cfg, { pem: "-----BEGIN PRIVATE KEY-----" });
      expect(r.blocked).toBe(true);
      expect(r.reason).toBe("arguments appear to contain a secret (private key block)");
    });
  });

  describe("JWT", () => {
    const realisticJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

    test("realistic three-segment JWT is blocked with the exact reason", () => {
      const r = checkInputGuardrails(cfg, { token: realisticJwt });
      expect(r.blocked).toBe(true);
      expect(r.reason).toBe("arguments appear to contain a secret (JWT)");
    });

    test("boundary: header segment only 1 char (below the {8,} minimum) is not blocked", () => {
      const r = checkInputGuardrails(cfg, {
        token: "eyJX.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      });
      expect(r.blocked).toBe(false);
    });

    test("boundary: payload segment only 1 char (below the {8,} minimum) is not blocked", () => {
      const r = checkInputGuardrails(cfg, {
        token: "eyJhbGciOiJIUzI1NiJ9.X.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      });
      expect(r.blocked).toBe(false);
    });

    test("boundary: signature segment only 1 char (below the {8,} minimum) is not blocked", () => {
      const r = checkInputGuardrails(cfg, {
        token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.X",
      });
      expect(r.blocked).toBe(false);
    });
  });

  describe("GitHub token", () => {
    test("realistic ghp_ token (36+ alnum) is blocked with the exact reason", () => {
      const r = checkInputGuardrails(cfg, { token: "ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD" });
      expect(r.blocked).toBe(true);
      expect(r.reason).toBe("arguments appear to contain a secret (GitHub token)");
    });

    test("boundary: ghp_ + only 1 char (below the {36,} minimum) is not blocked", () => {
      const r = checkInputGuardrails(cfg, { note: "ghp_X is a token" });
      expect(r.blocked).toBe(false);
    });
  });

  describe("Slack token", () => {
    test("realistic xoxb- token (10+ alnum/dash) is blocked with the exact reason", () => {
      const r = checkInputGuardrails(cfg, { token: "xoxb-1234567890abcdefghij" });
      expect(r.blocked).toBe(true);
      expect(r.reason).toBe("arguments appear to contain a secret (Slack token)");
    });

    test("boundary: xoxb- + only 1 char (below the {10,} minimum) is not blocked", () => {
      const r = checkInputGuardrails(cfg, { note: "xoxb-X is a token" });
      expect(r.blocked).toBe(false);
    });
  });

  describe("Google API key", () => {
    test("realistic key (AIza + exactly 35 alnum/underscore/dash) is blocked with the exact reason", () => {
      const r = checkInputGuardrails(cfg, { key: "AIza0123456789abcdefghijklmnopqrstuvwxy" });
      expect(r.blocked).toBe(true);
      expect(r.reason).toBe("arguments appear to contain a secret (Google API key)");
    });

    test("boundary: AIza + only 1 char (below the {35} minimum) is not blocked", () => {
      const r = checkInputGuardrails(cfg, { note: "AIzaX is not real" });
      expect(r.blocked).toBe(false);
    });
  });

  describe("OpenAI-style key", () => {
    test("realistic sk- key (20+ alnum) is blocked with the exact reason", () => {
      const r = checkInputGuardrails(cfg, { key: "sk-abcdefghijklmnopqrstuvwxy" });
      expect(r.blocked).toBe(true);
      expect(r.reason).toBe("arguments appear to contain a secret (OpenAI-style key)");
    });

    test("boundary: sk- + only 1 char (below the {20,} minimum) is not blocked", () => {
      const r = checkInputGuardrails(cfg, { note: "sk-X is not real" });
      expect(r.blocked).toBe(false);
    });
  });

  describe("blockSecrets gate", () => {
    test("blockSecrets: false leaves an obvious secret unblocked (secrets loop must not run)", () => {
      const offCfg = { denyPatterns: [], blockSecrets: false, scanResponses: false };
      const r = checkInputGuardrails(offCfg, { key: "AKIA1234567890ABCDEF" });
      expect(r.blocked).toBe(false);
    });

    test("blockSecrets: false still lets the deny-pattern loop block independently", () => {
      const offCfg = { denyPatterns: ["\\bAKIA\\b"], blockSecrets: false, scanResponses: false };
      const r = checkInputGuardrails(offCfg, { key: "AKIA is here" });
      expect(r.blocked).toBe(true);
      expect(r.reason).toBe("arguments matched a configured deny pattern");
    });
  });
});
