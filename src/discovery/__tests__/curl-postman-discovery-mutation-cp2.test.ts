/**
 * Stryker mutation-testing backstop for curl-postman-discovery.ts, cluster
 * "cp2": parseCurlCommand + parseSingleCurlCommand (lines 132-248).
 *
 * Ground truth for every mutant cited below came from running, against
 * reports/mutation/result.json, the query described in this program's
 * orchestrating prompt, filtered to lines 132-248. Do not trust any mutant
 * description transcribed elsewhere without re-running that query.
 *
 * Two mutants in this range are treated as genuinely equivalent (reasoning
 * inline, near the bottom of this file, in the "equivalent mutants" note).
 */
import { describe, test, expect } from "bun:test";
import { parseCurlCommand } from "../curl-postman-discovery.js";

describe("parseCurlCommand — top-level input guard and multi-command loop (lines 146-177)", () => {
  // Kills: 146:7 ConditionalExpression 'false' (x2 — whole-condition and
  // ||-forced-false via the LogicalOperator mutant '&&'), 146:37
  // MethodExpression 'input' (drops .trim()), 146:51 BlockStatement '{}'
  // (empties the throw), 147:21 StringLiteral '""' (blanks the message).
  // All of these, if applied, either never throw this specific message or
  // throw a *different* message ("No valid cURL command found in input",
  // thrown later once tools stays empty) — asserting the exact message text
  // distinguishes both cases.
  test("empty and whitespace-only input throw the specific 'No cURL command provided' message", () => {
    expect(() => parseCurlCommand("")).toThrow("No cURL command provided");
    expect(() => parseCurlCommand("   \n  ")).toThrow("No cURL command provided");
  });

  // Kills: 174:21 StringLiteral '""' (blanks this second message).
  test("input with only comments (no command line) throws the specific 'no valid command' message", () => {
    expect(() => parseCurlCommand("# just a comment, no command")).toThrow("No valid cURL command found in input");
  });

  // Kills: 158:18 MethodExpression 'rawLine' (drops .trim() before the
  // startsWith("#") check). Without the trim, a comment line with leading
  // indentation is no longer recognized as a comment at all — it instead
  // gets tokenized as a bogus command (first token becomes a garbage "url"),
  // which both (a) doesn't carry the explicit name forward and (b) doesn't
  // resolve to the real command's endpoint.
  test("a '# name' comment line with leading indentation is still recognized as a comment", () => {
    const paste = "   # explicit_name\ncurl https://api.example.com/foo";
    const tools = parseCurlCommand(paste);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("explicit_name");
    expect(tools[0].endpoint).toBe("/foo");
  });

  // Kills: 159:9 ConditionalExpression 'false' (the blank-line `if (!line)
  // continue;` never fires). Real code relies on `continue` to skip the
  // `pendingName = undefined;` reset for a blank line; forcing the guard off
  // means a blank line between a name-comment and its command still falls
  // through far enough to hit that reset, clearing the pending name early.
  test("an explicit '#' name persists across an intervening blank line before the command", () => {
    const paste = "# my_tool\n\ncurl https://api.example.com/thing";
    const [tool] = parseCurlCommand(paste);
    expect(tool.name).toBe("my_tool");
  });
});

describe("parseCurlCommand — line-continuation joining regex (line 150)", () => {
  // Kills: 150:32 Regex '/\\[^ \\t]*\\r?\\n[ \\t]*/g' (negates the
  // PRE-newline whitespace class) and 150:32 Regex '/\\[ \\t]*\\r?\\n[ \\t]/g'
  // (drops the trailing '*', requiring exactly one post-newline whitespace
  // char). A backslash followed by one literal space then a newline, with
  // the continuation line starting immediately with content (no leading
  // indentation), matches the real regex (pre-class matches the one space,
  // post-class matches zero) but fails to match under EITHER mutant (the
  // negated pre-class can't consume the space; the exactly-one post-class
  // has nothing to consume). When it fails to match, the backslash+newline
  // is left in the string, splitting one logical line into two raw lines —
  // the first ("curl -X POST \") loses its URL (tokenizes to an empty
  // trailing token, so url stays "" -> falsy -> null), and the second
  // (bare URL, no "curl"/"-X POST") is parsed as a bare GET on that URL
  // instead of the intended explicit POST.
  test("continuation with a trailing space before the newline still joins into one POST command", () => {
    const cmd = "curl -X POST \\ \nhttps://api.example.com/users";
    const tools = parseCurlCommand(cmd);
    expect(tools).toHaveLength(1);
    expect(tools[0].method).toBe("POST");
    expect(tools[0].endpoint).toBe("/users");
  });

  // Kills: 150:32 Regex '/\\[ \\t]*\\r?\\n[^ \\t]*/g' (negates the
  // POST-newline whitespace class to "non-whitespace", i.e. \S*). With a
  // continuation line that starts immediately with non-whitespace content
  // and contains no whitespace of its own (a bare URL), the mutant's greedy
  // \S* swallows the ENTIRE continuation line into the match, so the whole
  // URL gets deleted by the replacement instead of just the backslash+
  // newline — leaving no URL at all, which makes the command unparseable.
  // Also kills: 150:56 StringLiteral '""' (blanks the replacement string):
  // with an empty replacement, "POST" and "https://..." get concatenated
  // with no separating space ("POSThttps://..."), merging what should be
  // two tokens into one bogus one and leaving the -X flag's method value
  // pointing at that whole merged string instead of the URL ever being set.
  test("continuation with no whitespace on either side of the backslash+newline still joins correctly", () => {
    const cmd = "curl -X POST \\\nhttps://api.example.com/users";
    const tools = parseCurlCommand(cmd);
    expect(tools).toHaveLength(1);
    expect(tools[0].method).toBe("POST");
    expect(tools[0].endpoint).toBe("/users");
  });
});

describe("parseCurlCommand — '# name: X' explicit-name comment syntax (lines 162-163)", () => {
  // Kills: 163:11 ConditionalExpression 'true' (forces `if (commentBody)` to
  // always assign pendingName, even for an EMPTY comment body). A bare '#'
  // with nothing after it should leave pendingName untouched (undefined);
  // forced-true instead assigns pendingName = "" (not undefined!), which the
  // `??` in `explicitName ?? generateNameFromPath(...)` does NOT fall back
  // on (empty string is not nullish) — sanitizeToolName("") then collapses
  // to the "op" fallback instead of the real auto-generated name.
  test("a bare '#' comment with no body does not set an explicit name", () => {
    const paste = "#\ncurl https://api.example.com/things";
    const [tool] = parseCurlCommand(paste);
    expect(tool.name).toBe("get_things");
  });

  // Kills: 162:27 MethodExpression 'line.slice(1)' (drops the outer .trim()
  // after slice, leaving a leading space before "name:") and 162:27
  // MethodExpression 'line' (drops the .slice(1) entirely, leaving the "#"
  // itself at the front) — both leave a non-"name"-prefixed string, so the
  // anchored `/^name\s*:\s*/i` no longer matches and the "name: " prefix is
  // never stripped. Also kills: 163:75 StringLiteral '"Stryker was here!"'
  // (changes what the prefix is replaced WITH) and 163:58 Regex
  // '/^name\s:\s*/i' (requires exactly one whitespace char between "name"
  // and the colon — fails to match "name:" which has zero).
  test("'# name: X' strips the prefix to yield exactly the explicit name", () => {
    const paste = "# name: myname\ncurl https://api.example.com/x";
    const [tool] = parseCurlCommand(paste);
    expect(tool.name).toBe("myname");
  });

  // Kills: 163:58 Regex '/name\s*:\s*/i' (drops the leading '^' anchor). A
  // comment body that merely CONTAINS "name:" as a substring — not at the
  // very start — must NOT be treated as the name: prefix syntax. Unanchored,
  // the mutant regex finds "name: " starting mid-string and strips it out,
  // collapsing "username: bob" down to "userbob" instead of leaving the
  // whole string alone (to be sanitized as-is).
  test("a comment body that merely contains 'name:' (not at its start) is used verbatim, not prefix-stripped", () => {
    const paste = "# username: bob\ncurl https://api.example.com/x2";
    const [tool] = parseCurlCommand(paste);
    expect(tool.name).toBe("username_bob");
  });

  // Kills: 163:58 Regex '/^name\S*:\s*/i' (changes the first \s* to \S* —
  // zero-or-more NON-whitespace between "name" and the colon). A literal
  // space between "name" and ":" (a plausible typo/formatting variant) is
  // whitespace, so \S* can't consume it and the whole match fails, leaving
  // the "name : " prefix un-stripped.
  test("'# name : X' (space before the colon) still strips the prefix", () => {
    const paste = "# name : special_x\ncurl https://api.example.com/y";
    const [tool] = parseCurlCommand(paste);
    expect(tool.name).toBe("special_x");
  });

  // Kills: 163:58 Regex '/^name\s*:\S*/i' (changes the second \s* to \S* —
  // zero-or-more NON-whitespace after the colon). With no space after the
  // colon, the following content is one unbroken non-whitespace run, so the
  // mutant's greedy \S* consumes the ENTIRE name along with the prefix,
  // stripping everything down to "" instead of leaving just the name.
  test("'# name:X' (no space after the colon) strips only the prefix, not the whole name", () => {
    const paste = "# name:tightname\ncurl https://api.example.com/z2";
    const [tool] = parseCurlCommand(paste);
    expect(tool.name).toBe("tightname");
  });
});

describe("parseSingleCurlCommand — -X/--request and combined -X<VALUE> form (lines 186, 196-198)", () => {
  // Kills: 186:7 ConditionalExpression 'true' (forces the leading `if
  // (tokens[0] === "curl") i++` to always skip the first token, even when it
  // is NOT literally "curl"). A bare URL with no "curl" keyword at all must
  // still have its first (only) token read as the url; forced-true instead
  // skips past it, leaving no url and causing the whole command to be
  // dropped (parseCurlCommand then throws, since it's the only command).
  test("a bare URL with no leading 'curl' keyword is still parsed as a command", () => {
    const [tool] = parseCurlCommand("https://api.example.com/direct");
    expect(tool.method).toBe("GET");
    expect(tool.endpoint).toBe("/direct");
  });

  // Kills: 196:23 ConditionalExpression 'false' and 196:29 StringLiteral
  // '""' (both neutralize the `t === "--request"` alternative). Using the
  // long-form flag exclusively exercises that alternative; if neutralized,
  // "--request" falls through to the generic unknown-flag handling instead
  // (its value token gets skipped and discarded rather than read as the
  // method), so the method defaults to GET instead of the requested PATCH.
  test("--request (long form) sets the method same as -X", () => {
    const [tool] = parseCurlCommand("curl --request PATCH https://api.example.com/thing");
    expect(tool.method).toBe("PATCH");
  });

  // Kills: 198:55 MethodExpression 't.endsWith("--")' (swaps the guard's
  // startsWith("--") for endsWith("--")). The guard's real purpose only ever
  // matters vacuously here (see the "equivalent mutants" note below for why
  // 198:38 is unreachable) EXCEPT for endsWith: a combined-form value that
  // happens to END in "--" (e.g. "-Xfoo--") is a real, if odd, single token.
  // Real code recognizes it as the combined form (methodFlag = "foo--",
  // later rejected as an unsupported method -> command dropped -> throws).
  // The endsWith mutant instead treats "-Xfoo--" as an unrecognized flag
  // that swallows the NEXT token as its assumed value — which, with a dummy
  // token in between, ends up swallowing the dummy instead of the URL,
  // letting the real URL through untouched with no method flag at all
  // (defaults to GET) — so the mutant does NOT throw where the real code
  // does.
  test("a combined -X<value> form whose value happens to end in '--' is still recognized as taking no extra token", () => {
    expect(() => parseCurlCommand("curl -Xfoo-- dummyvalue https://api.example.com/skip-test")).toThrow();
  });
});

describe("parseSingleCurlCommand — -H/--header (lines 201-206)", () => {
  // Kills: 201:30 ConditionalExpression 'false' and 201:36 StringLiteral
  // '""' (both neutralize the `t === "--header"` alternative), same
  // reasoning as the --request case above.
  test("--header (long form) is recognized same as -H", () => {
    const [tool] = parseCurlCommand('curl --header "X-Test: value123" https://api.example.com/y');
    expect(tool.description).toContain("X-Test");
  });

  // Kills: 203:11 ConditionalExpression 'true' (forces `if (h)` to proceed
  // even when h is undefined, i.e. -H was the very last token with no value
  // following it). Real code guards against calling .indexOf on undefined;
  // the forced-true mutant crashes with a TypeError instead of gracefully
  // skipping the malformed flag.
  test("-H as the very last token (no value) does not crash and adds no header", () => {
    const [tool] = parseCurlCommand("curl https://api.example.com/z -H");
    expect(tool.description).toBe("Imported from cURL: GET /z");
  });

  // Kills: 205:13 ConditionalExpression 'true' (forces `if (idx > 0)` to
  // always push, even when there's no colon at all, i.e. idx === -1).
  test("a -H value with no colon at all is not treated as a header name", () => {
    const [tool] = parseCurlCommand('curl -H "NoColonHere" https://api.example.com/w');
    expect(tool.description).toBe("Imported from cURL: GET /w");
  });

  // Kills: 205:13 EqualityOperator 'idx >= 0' (a header value whose colon IS
  // the very first character, idx === 0, should still be rejected — an empty
  // header name isn't useful — but >= 0 lets it through).
  test("a -H value where the colon is the very first character is not treated as a header name", () => {
    const [tool] = parseCurlCommand('curl -H ":onlyvalue" https://api.example.com/v');
    expect(tool.description).toBe("Imported from cURL: GET /v");
  });

  // Kills: 205:39 MethodExpression 'h.slice(0, idx)' (drops the outer
  // .trim()). A header name with trailing whitespace before its colon must
  // be trimmed; without trimming, the pushed name carries a trailing space,
  // which the exact-suffix check below distinguishes.
  test("a -H header name with whitespace before the colon is trimmed", () => {
    const [tool] = parseCurlCommand('curl -H "X-Custom : v" https://api.example.com/u');
    expect(tool.description.endsWith("X-Custom")).toBe(true);
  });
});

describe("parseSingleCurlCommand — data flags, -u/--user, unknown flags, bare '-' (lines 207-222)", () => {
  // Kills, for EACH of the 5 --data-* long-form variants: its own
  // ConditionalExpression 'false' AND StringLiteral '""' mutant (lines
  // 209-213 — 10 mutants total). Each neutralized alternative falls through
  // to the generic unknown-flag handling, which discards the JSON body token
  // instead of recording it as `data`, so the method defaults to GET (no
  // data) instead of POST and the schema ends up empty.
  test("each --data-* long-form variant supplies the request body", () => {
    const variants = ["--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode"];
    for (const flag of variants) {
      const [tool] = parseCurlCommand(`curl ${flag} '{"k":"v"}' https://api.example.com/body-test`);
      expect(tool.method).toBe("POST");
      expect(tool.inputSchema.properties).toEqual({ k: { type: "string" } });
    }
  });

  // Kills: 217:30 ConditionalExpression 'false' and 217:36 StringLiteral
  // '""' (both neutralize the `t === "--user"` alternative) — same
  // reasoning as --request/--header: neutralized, the credential token
  // still gets silently skipped (as an unrecognized flag's assumed value),
  // but `sawUser` never becomes true, so no "Authorization" note is added.
  test("--user (long form) implies an Authorization header note same as -u", () => {
    const [tool] = parseCurlCommand("curl --user admin:secret https://api.example.com/secure2");
    expect(tool.description).toContain("Authorization");
    expect(tool.description).not.toContain("secret");
  });

  // Kills: 220:16 ConditionalExpression 'false' and 220:16 MethodExpression
  // 't.endsWith("-")' (both neutralize the `t.startsWith("-")` guard so an
  // unrecognized flag like "--unknown-flag" is never identified as a flag at
  // all), 220:48 BlockStatement '{}' (empties the `i++` that skips the
  // flag's assumed value), and 221:11's BooleanLiteral / ConditionalExpression
  // 'false' variants (which, for a flag actually absent from
  // CURL_BOOLEAN_FLAGS, would wrongly skip the `i++`). Also exercises 221:39
  // UpdateOperator 'i--' for the first time in this file's history (no prior
  // test used a truly-unrecognized non-boolean flag) — under that mutant
  // this line becomes a genuine infinite loop, which is this program's
  // established "effectively killed via Timeout" case, not a bug in this
  // test. Any of the above, if mutated, causes "someval" (the flag's
  // supposed-to-be-skipped value) to be misread as the url instead of the
  // real URL that follows it.
  test("an unrecognized flag (assumed to take a value) skips its value token, not the real URL", () => {
    const [tool] = parseCurlCommand("curl --unknown-flag someval https://api.example.com/skip-test");
    expect(tool.endpoint).toBe("/skip-test");
  });

  // Kills: 221:11 BooleanLiteral 'CURL_BOOLEAN_FLAGS.has(t)' (drops the `!`
  // negation) and 221:11 ConditionalExpression 'true' (forces the skip to
  // always happen) — for a flag that IS in CURL_BOOLEAN_FLAGS, real code
  // must NOT skip the next token (it's the URL, not a value); either mutant
  // wrongly consumes it, leaving no url and causing the whole command to be
  // dropped.
  test("a known boolean flag (e.g. -s) does not swallow the next token as its value", () => {
    const [tool] = parseCurlCommand("curl -s https://api.example.com/boolflag-test");
    expect(tool.endpoint).toBe("/boolflag-test");
  });

  // Kills: 220:37 ConditionalExpression 'true', 220:37 EqualityOperator
  // 't === "-"', and 220:43 StringLiteral '""' — all three make a bare
  // single-dash token "-" incorrectly qualify as an "unrecognized flag
  // needing a value", which then swallows the REAL url that follows it,
  // leaving no url at all (real code correctly excludes bare "-" from that
  // branch via `t !== "-"`, so it falls through and gets treated as an
  // ordinary token / the url itself, never eating anything after it).
  test("a bare single dash '-' token is not treated as a flag that consumes the next token", () => {
    expect(() => parseCurlCommand("curl - https://api.example.com/afterdash")).not.toThrow();
  });

  // Kills: 222:16 ConditionalExpression 'true' (forces `else if (!url)` to
  // always assign, even once url is already set) — a second stray bare
  // token must NOT overwrite the first-seen url.
  test("only the first non-flag token becomes the url; a later stray token does not overwrite it", () => {
    const [tool] = parseCurlCommand("curl https://api.example.com/first https://api.example.com/second");
    expect(tool.endpoint).toBe("/first");
  });
});

describe("parseSingleCurlCommand — url guard, sawUser/headerNames init, and description source label (lines 189-244)", () => {
  // Kills: 227:7 ConditionalExpression 'false' (forces the `if (!url) return
  // null;` guard off). With no url at all, real code cleanly drops the
  // command (parseCurlCommand then throws its own descriptive error); the
  // mutant instead falls through and crashes deep inside extractPathAndQuery
  // (calling .replace on `undefined`), surfacing an unrelated TypeError.
  test("a command with only flags and no URL at all is dropped, not passed through to crash", () => {
    expect(() => parseCurlCommand('curl -X POST -H "X-Test: 1"')).toThrow("No valid cURL command found in input");
  });

  // Kills: 189:33 ArrayDeclaration (headerNames initialized with a
  // placeholder element instead of []), 191:17 BooleanLiteral 'true'
  // (sawUser initialized to true instead of false), 233:7 ConditionalExpression
  // 'true' (forces the Authorization push unconditionally), and 244:33
  // StringLiteral '""' (blanks the "cURL" source-kind label) — all four
  // would make this exact-match description differ (an extra header note,
  // an unconditional "Authorization" note, or a blank source label).
  test("a command with no headers and no -u produces the exact bare description", () => {
    const [tool] = parseCurlCommand("curl https://api.example.com/plain");
    expect(tool.description).toBe("Imported from cURL: GET /plain");
  });
});

/**
 * Equivalent mutants (verified empirically, not tested directly):
 *
 * - 184:7 ConditionalExpression 'false' (`if (tokens.length === 0) return
 *   null;` forced off): unreachable via the public parseCurlCommand API.
 *   parseSingleCurlCommand is only ever called with tokens produced by
 *   tokenizeShellLike(line) where `line` is already non-empty after
 *   `.trim()` (blank lines are filtered by the `if (!line) continue;` guard
 *   before tokenizing). tokenizeShellLike's outer loop always builds at
 *   least one token (even a lone trailing backslash yields a pushed empty-
 *   string token) whenever its input has any non-whitespace character, so
 *   tokens.length is always >= 1 in every real call path — this guard's
 *   `true` branch can never fire either way.
 *
 * - 198:38 ConditionalExpression 'true' and 198:38 EqualityOperator
 *   't.length >= 2' (both affect `t.length > 2` in the combined -X<value>
 *   form check `t.startsWith("-X") && t.length > 2 && !t.startsWith("--")`):
 *   this branch is only reached after the preceding `t === "-X"` exact-match
 *   check has already failed. Since "-X" is exactly 2 characters, any other
 *   token that still starts with the 2-character prefix "-X" necessarily has
 *   length >= 3, so `t.length > 2` is always true in every reachable case —
 *   changing `>` to `>=` (which only differs at length === 2) or forcing the
 *   clause to `true` outright makes no observable difference.
 */
