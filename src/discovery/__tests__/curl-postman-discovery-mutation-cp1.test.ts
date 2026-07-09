/**
 * Stryker mutation backstop — domain 6 (src/discovery/), curl-postman-discovery.ts,
 * cluster "CURL_BOOLEAN_FLAGS + tokenizeShellLike" (source lines 1-131).
 *
 * Baseline mutation run: reports/mutation/result.json. All line:col citations below
 * were read directly from that file (filtered to lines 1-131), not transcribed from
 * an orchestrating prompt.
 *
 * tokenizeShellLike is not exported, so every test here drives it indirectly through
 * parseCurlCommand's resulting tool definitions (endpoint / method / description /
 * inputSchema), per the existing test file's pattern.
 */
import { describe, test, expect } from "bun:test";
import { parseCurlCommand } from "../../discovery/curl-postman-discovery.js";

describe("CURL_BOOLEAN_FLAGS (lines 45-75)", () => {
  test("each literal boolean flag is recognized and does not swallow the following URL", () => {
    // Kills: 45:36 ArrayDeclaration '[]' (whole Set emptied) and the 29 per-element
    // StringLiteral '""' mutants at 46:3, 47:3, 48:3, 49:3, 50:3, 51:3, 52:3, 53:3,
    // 54:3, 55:3, 56:3, 57:3, 58:3, 59:3, 60:3, 61:3, 62:3, 63:3, 64:3, 65:3, 66:3,
    // 67:3, 68:3, 69:3, 70:3, 71:3, 72:3, 73:3, 74:3.
    // If any one of these flag strings is emptied (or the whole array is), that flag
    // is no longer recognized as boolean-valued, so parseSingleCurlCommand's fallback
    // ("unknown flag: assume it takes a value and skip the next token") consumes the
    // URL as the flag's own argument, leaving no URL and no registrable tool.
    const CURL_BOOLEAN_FLAGS = [
      "-s",
      "--silent",
      "-S",
      "--show-error",
      "-k",
      "--insecure",
      "-L",
      "--location",
      "-v",
      "--verbose",
      "-i",
      "--include",
      "--compressed",
      "-f",
      "--fail",
      "-g",
      "--globoff",
      "-4",
      "--ipv4",
      "-6",
      "--ipv6",
      "-N",
      "--no-buffer",
      "-#",
      "--progress-bar",
      "-sS",
      "-sSL",
      "-sL",
      "-Ss",
    ];
    for (const flag of CURL_BOOLEAN_FLAGS) {
      const [tool] = parseCurlCommand(`curl ${flag} https://api.example.com/ping`);
      expect(tool.method).toBe("GET");
      expect(tool.endpoint).toBe("/ping");
    }
  });
});

describe("SUPPORTED_METHODS (line 30)", () => {
  test("PATCH is a supported/registrable method", () => {
    // Kills: 30:70 StringLiteral '""' (the "PATCH" element of SUPPORTED_METHODS
    // emptied). If PATCH were no longer a member, parseSingleCurlCommand's
    // `if (!SUPPORTED_METHODS.has(...)) return null;` guard would treat -X PATCH
    // the same as HEAD/OPTIONS: silently skipped, producing zero tools (and thus
    // parseCurlCommand throwing "No valid cURL command found in input").
    const [tool] = parseCurlCommand(`curl -X PATCH https://api.example.com/resource/9`);
    expect(tool.method).toBe("PATCH");
    expect(tool.endpoint).toBe("/resource/9");
  });
});

describe("tokenizeShellLike — single-quoted strings", () => {
  test("an unterminated single-quoted argument consumes the rest of the input as its content", () => {
    // Kills: 98:21 ConditionalExpression 'false' (the `close === -1 ? n : close`
    // ternary test forced false, so the "not found" branch is never taken) and
    // 98:31 UnaryOperator '+1' (mutates `close === -1` to `close === +1`, so the
    // "not found" branch is only ever taken when the closing quote happens to sit
    // at index 1). Both mutants only diverge from the original on an unterminated
    // quote (close === -1): real code correctly falls back to `end = n` (grabbing
    // the remainder of the string); both mutants instead compute `end = close = -1`,
    // which (empirically verified against real code with these two mutations
    // hand-applied) sends the tokenizer's index backwards and into an infinite
    // re-tokenization loop — this test's input is safe against the REAL code
    // (terminates immediately, confirmed above) but is a genuine kill (or, on
    // rerun, a Stryker-detected Timeout, treated as effectively killed) for both
    // mutants.
    const [tool] = parseCurlCommand(`curl 'https://api.example.com/test`);
    expect(tool.method).toBe("GET");
    expect(tool.endpoint).toBe("/test");
  });
});

describe("tokenizeShellLike — double-quoted strings", () => {
  test("an unterminated double-quoted argument consumes the rest of the input as its content", () => {
    // Kills: 104:16 EqualityOperator 'j <= n' (boundary off-by-one on the dquote
    // scan's `j < n` bound: at j === n, mutated code takes one extra loop pass and
    // appends `input[n]`, i.e. the literal string "undefined", to the buffer).
    // Also targets 104:16 ConditionalExpression 'true' (the whole `j < n` clause
    // forced true, independent of j/n) — empirically this is a genuine infinite
    // loop under mutation for unterminated double-quoted input (real code
    // terminates immediately, confirmed above), so it is a Timeout-class kill.
    const [tool] = parseCurlCommand(`curl "https://api.example.com/test`);
    expect(tool.method).toBe("GET");
    expect(tool.endpoint).toBe("/test");
  });

  test('escaped \\", \\\\, \\$ and \\` decode to their literal characters inside a double-quoted header name', () => {
    // Header *values* are deliberately never persisted (only names, per the
    // file-level doc comment), so this drives the escape-decoding logic through a
    // header NAME containing all four escapable characters, which the resulting
    // tool.description does expose verbatim.
    //
    // Kills, all at the double-quote escape-detection site (lines 105-110):
    //   105:15 ConditionalExpression 'false'  — whole `input[j]==="\\" && j+1<n &&
    //     charset.includes(...)` forced false; escape branch never fires.
    //   105:28 StringLiteral '""'             — the "\\" literal in `input[j]==="\\"`
    //     emptied; same effect (a real single char never equals "").
    //   105:36 EqualityOperator 'j + 1 >= n'  — flips the boundary check's
    //     direction, breaking escape detection even in the ordinary (non-boundary)
    //     case exercised here (empirically verified: 'j+1<=n', 'true', and the
    //     'j-1' arithmetic variant at this same span do NOT diverge here — see the
    //     "confirmed equivalent" note in the describe block below).
    //   105:49 StringLiteral '""'             — the '"\\$`' escapable-charset
    //     string emptied; `"".includes(...)` is always false, so no escape is ever
    //     recognized.
    //   105:72 ArithmeticOperator 'j - 1'     — the `.includes(input[j + 1])` check
    //     reads the wrong (preceding) character.
    //   105:82 BlockStatement '{}'            — the escape-branch body emptied
    //     (buf/j never advance); a genuine hang under mutation, safe here since
    //     real code advances normally (Timeout-class kill on rerun).
    //   106:13 AssignmentOperator 'buf -= input[j + 1]' — numeric subtraction on
    //     strings, producing "NaN" in the decoded content instead of the escaped
    //     char.
    //   106:26 ArithmeticOperator 'j - 1'     — appends the wrong (preceding)
    //     character instead of the escaped one.
    //   107:13 AssignmentOperator 'j -= 2'    — moves the scan index backwards
    //     instead of forwards after consuming an escape pair, re-processing
    //     already-seen characters.
    //   110:13 UpdateOperator 'j--'           — the *plain* (non-escape) character
    //     branch's `j++` flipped to `j--`; even a single ordinary character right
    //     after the opening quote sends `j` back onto the opening quote itself,
    //     terminating the double-quote scan one character in and corrupting the
    //     rest of the token (empirically verified with this exact input).
    //
    // All of the above were cross-checked with a hand-mutated copy of
    // tokenizeShellLike run against this exact command: each mutation produces a
    // different (wrong) decoded string than the one asserted below.
    const cmd = 'curl https://api.example.com/ping -H "A\\"B\\\\C\\$D\\`E: value"';
    const [tool] = parseCurlCommand(cmd);
    expect(tool.method).toBe("GET");
    expect(tool.endpoint).toBe("/ping");
    expect(tool.description).toContain('A"B\\C$D`E');
  });
});

describe("tokenizeShellLike — bare backslash outside quotes", () => {
  test("a bare backslash mid-command escapes the following character (e.g. a literal space)", () => {
    // Kills, all at the bare-backslash site (lines 115-118):
    //   115:18 ConditionalExpression 'false' and 115:24 StringLiteral '""' (the
    //     `c === "\\"` guard forced false, or its "\\" literal emptied) — the
    //     branch never fires, so the backslash is kept as a literal character and
    //     the following space is left to act as an ordinary token separator
    //     (splitting what should be one token into two).
    //   116:13 ConditionalExpression 'false' and 116:13 EqualityOperator
    //     'i + 1 >= n' — for this ordinary (non-boundary) escape, both force the
    //     "escape the next char" branch to be skipped, same wrong split as above
    //     (empirically verified).
    //   116:24 BlockStatement '{}' — the "escape it" branch body emptied, so `i`
    //     never advances (Timeout-class kill on rerun; real code is unaffected).
    //   117:11 AssignmentOperator 'token -= input[i + 1]' — numeric subtraction,
    //     producing "NaN" instead of the escaped character.
    //   117:26 ArithmeticOperator 'i - 1' — appends the wrong (preceding)
    //     character instead of the one being escaped.
    //   118:11 AssignmentOperator 'i -= 2' — moves the scan index backwards
    //     instead of forwards after the escape.
    const [tool] = parseCurlCommand(`curl https://api.example.com/a\\ b`);
    expect(tool.method).toBe("GET");
    expect(tool.endpoint).toBe("/a%20b");
  });

  test("a bare trailing backslash as the very last character of the input is dropped without side effects", () => {
    // Kills, all at the boundary check for the bare-backslash site (line 116):
    //   116:13 ConditionalExpression 'true'   — forces the boundary case into the
    //     "escape it" branch, appending `input[n]` (the literal string
    //     "undefined") to the token.
    //   116:13 EqualityOperator 'i + 1 <= n'  — same wrong branch taken exactly at
    //     the i+1===n boundary, same "undefined" appended.
    //   116:13 ArithmeticOperator 'i - 1'     — `i - 1 < n` is true at this
    //     boundary too, same wrong branch/same "undefined" appended.
    //   119:16 BlockStatement '{}'            — the "just skip it" (boundary) else
    //     branch emptied, so `i` never advances at end-of-input (Timeout-class
    //     kill on rerun; real code is unaffected).
    //   120:11 UpdateOperator 'i--'           — moves `i` backwards instead of
    //     forwards past the trailing backslash.
    const [tool] = parseCurlCommand(`curl https://api.example.com/x\\`);
    expect(tool.method).toBe("GET");
    expect(tool.endpoint).toBe("/x");
  });
});

describe("genuinely equivalent mutants (empirically confirmed, no test added)", () => {
  test("documents equivalence — not itself a mutant-killing assertion", () => {
    // The following survivors were checked against a faithful hand-mutated copy of
    // tokenizeShellLike run over 15 varied inputs (empty string, whitespace-only,
    // tabs, leading/trailing whitespace, unterminated single/double quotes, a
    // trailing bare backslash, all four double-quote escapes, and adjacent
    // single+double+backslash tokens) and produced byte-identical output to the
    // real function on every single one, so no black-box test (of any input) can
    // distinguish them:
    //
    //   88:10  EqualityOperator 'i <= n'      — outer `while (i < n)` widened to
    //     `i <= n`. At i===n the loop body runs one extra time, but line 89's
    //     `i < n && ...` short-circuits before reading input[n], and line 90's
    //     `i >= n` immediately breaks — zero observable difference.
    //   89:12  ConditionalExpression 'true'   — forces just the `i < n` half of
    //     `i < n && /\s/.test(input[i])` to true, i.e. the loop becomes driven by
    //     `/\s/.test(input[i])` alone. At i===n, `input[n]` is `undefined`, and
    //     `/\s/.test(undefined)` coerces to the string "undefined" (no whitespace
    //     match) — same false result as the original bound check.
    //   89:12  EqualityOperator 'i <= n'      — same masking as above (the extra
    //     i===n iteration is stopped by the regex test regardless).
    //   90:9   ConditionalExpression 'false'  — the `if (i >= n) break` guard
    //     disabled; termination still happens one loop naturally via line 88's
    //     own `i < n` re-check.
    //   90:9   EqualityOperator 'i > n'       — `i` only ever reaches at most `n`
    //     at this check point (never `n+1` or beyond), so `i > n` and `i >= n`
    //     agree on every reachable value.
    //   92:18  BooleanLiteral 'true'          — `let sawAny = false` seeded `true`
    //     instead. `sawAny` is unconditionally set `true` at line 94 on the very
    //     first iteration of the token-building loop, which is guaranteed to run
    //     at least once whenever line 92 is reached (lines 89-90 already ensured
    //     `i < n` and non-whitespace) — the seed value is always overwritten.
    //   105:36 ConditionalExpression 'true', EqualityOperator 'j + 1 <= n', and
    //     ArithmeticOperator 'j - 1' (three of the four mutants at this span) —
    //     for the ordinary (non-boundary) case exercised by every escape in this
    //     file, the original `j + 1 < n` is already true, and all three mutants
    //     only ever *weaken* that true result (still true) or leave it true at
    //     reachable j; at the true end-of-string boundary they're masked exactly
    //     like the 89:12 case (`'"\\$\`'.includes(input[j+1])` on an out-of-range
    //     `input[j+1] === undefined` coerces to `"undefined"`, which the 4-char
    //     escape set never contains, so the outer `&&` is false either way). Only
    //     the fourth mutant at this span, 105:36 EqualityOperator 'j + 1 >= n'
    //     (direction flipped, not just widened), is a real bug — see the
    //     double-quote escape-decoding test above, which kills it.
    //   127:9  ConditionalExpression 'true'   — `if (sawAny) tokens.push(token)`
    //     forced unconditional. As with 92:18, `sawAny` is always true by the time
    //     this line runs, for the same reason.
    expect(true).toBe(true);
  });
});
