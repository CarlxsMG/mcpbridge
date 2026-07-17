/**
 * Stryker mutation-testing backstop for src/mcp/tool-search.ts (the
 * search_tools meta-tool: definition, pure ranking, and the runSearchTool
 * dispatch). 90 mutants, 80.00% baseline (72/90) — a pure, side-effect-free
 * module, tested entirely via direct calls to the exported functions (no
 * transport/harness needed at all).
 *
 * Written directly (no agent round — small survivor count), one file,
 * alongside the existing tool-search.test.ts (not modified). Each test
 * cites the exact line:column + mutator + replacement it targets.
 *
 * EQUIVALENT MUTANTS (documented per task instructions rather than dropped):
 *   - 52:12-52:24 Regex (tokenize's `/[^a-z0-9]+/` -> `/[^a-z0-9]/`, the "+"
 *     quantifier removed). `String.split()` finds ALL matches of a regex
 *     regardless of the "g" flag, so a run of N consecutive separator
 *     characters produces N-1 empty-string entries between them under the
 *     un-quantified regex (one split point per character) instead of a
 *     single split point under the quantified one — but `tokenize()`
 *     immediately `.filter(Boolean)`s the result, which removes every one
 *     of those empty strings either way. For any input, the NON-EMPTY
 *     tokens produced are identical regardless of whether a separator run
 *     is treated as one boundary or many, since `.filter(Boolean)` fully
 *     absorbs the difference. No test can observe a divergence here.
 *   - 106:17-106:47 ConditionalExpression (`typeof args.limit === "number"`
 *     forced to `true`, in `typeof args.limit === "number" &&
 *     Number.isFinite(args.limit) ? ... : DEFAULT_LIMIT`). Per the
 *     ECMAScript spec, `Number.isFinite()` (unlike the global `isFinite()`)
 *     never coerces its argument — it returns `false` immediately for any
 *     value that isn't already of type `number`. So there is no input for
 *     which `typeof args.limit !== "number"` (the real check failing) while
 *     `Number.isFinite(args.limit)` is `true` — the second half of the `&&`
 *     already independently rejects every non-number value the first half
 *     would. Forcing the first half to `true` therefore never changes the
 *     overall result: verified by testing a string limit ("5") specifically
 *     BECAUSE `Number.isFinite("5")` is `false` regardless of the first
 *     check's outcome.
 *   - 70:7-70:21 ConditionalExpression (`q.length === 0` forced to `false`,
 *     the FIRST half of `q.length === 0 || tokens.length === 0`). This
 *     direction is unreachable for the mirror-image reason to the
 *     `tokens.length === 0` case already killed above:
 *     `query.trim().toLowerCase()` (producing `q`) and `tokenize()`'s
 *     `/[^a-z0-9]+/` split both classify the ENTIRE standard-whitespace set
 *     (and every other non-alphanumeric character) as "not real content" —
 *     `.trim()` only ever strips whitespace, and any character that
 *     survives trimming (i.e. isn't whitespace) is by definition NOT
 *     matched by `.trim()`, but a non-whitespace, non-`[a-z0-9]` character
 *     (e.g. an accented letter or a non-ASCII digit) is still classified
 *     as a separator by `tokenize()`'s regex — meaning it contributes
 *     to neither `q` being empty NOR any token existing. There is no
 *     character class that `.trim()` removes (making `q` empty) that
 *     `tokenize()`'s separator regex does NOT ALSO treat as a separator
 *     (making tokens empty too) — so `q.length === 0` and
 *     `tokens.length === 0` are always simultaneously true or
 *     simultaneously false for any real input; forcing either half of the
 *     `||` independently can never change the overall result.
 */
import { describe, test, expect } from "bun:test";
import { searchToolDefinition, rankTools, runSearchTool, type AdvertisedTool } from "../../mcp/tool-search.js";

// ===========================================================================
// searchToolDefinition — the static schema literal (L28-47).
// ===========================================================================

describe("searchToolDefinition", () => {
  // 33:7-33:111 StringLiteral (the description text emptied), 38:17-38:25
  // StringLiteral (query param's "type": "string" emptied), 41:16-41:118
  // ObjectLiteral (the whole limit param schema emptied), 41:24-41:32
  // StringLiteral ("number" emptied), 44:29-44:34 BooleanLiteral
  // (additionalProperties: false -> true) [all Survived]. One exact toEqual
  // against the full hand-transcribed schema kills every static-literal
  // mutant in this object at once — the bulk-schema-toEqual technique used
  // throughout this series for declarative-literal catalogs.
  test("returns the exact, complete tool definition", () => {
    expect(searchToolDefinition()).toEqual({
      name: "search_tools",
      description:
        "Search the tools available on this endpoint by keyword. Returns the best-matching tool names and " +
        "descriptions ranked by relevance — call this first to find the exact tool to use, then call that tool.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Keywords describing the capability you need (e.g. 'create github issue').",
          },
          limit: { type: "number", description: "Max results to return (default 10, max 50)." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    });
  });
});

// ===========================================================================
// rankTools — description fallback + scoring + tie-break sort (L67-94).
// ===========================================================================

const NAME_ONLY: AdvertisedTool[] = [{ name: "alpha_widget", description: "unrelated text entirely", inputSchema: {} }];

describe("rankTools — query normalization", () => {
  // 68:13-68:25 MethodExpression [Survived] "query" (real:
  // "query.trim()" — the ".trim()" call removed, keeping only
  // ".toLowerCase()"). NOTE: checking mere inclusion/name here is NOT
  // enough — tokenize() re-derives its own tokens straight from the raw
  // `query` parameter (not from `q`), so per-token scoring works
  // identically whether `q` itself is trimmed or not, and a query that's
  // already lowercase-and-padded-with-spaces still produces a positive
  // score via tokens alone either way. The part that ACTUALLY depends on
  // `q` being trimmed is the whole-query-substring BOOST
  // (`name.includes(q)`, L82): an untrimmed `q` (with padding spaces)
  // will never literally match a name that has no such padding, so the
  // boost silently fails to fire under the mutant. Assert the exact
  // SCORE (which the boost adds +3 to), not just presence/name.
  test("leading/trailing whitespace around the query does not prevent the whole-query-substring boost", () => {
    const ranked = rankTools("  alpha  ", NAME_ONLY, 10);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.name).toBe("alpha_widget");
    // Real: token "alpha" matches the name (+2) AND the trimmed "alpha"
    // is a literal substring of "alpha_widget" (+3 boost) = 5. Under the
    // mutant, the untrimmed "  alpha  " is never a literal substring of
    // "alpha_widget", so the boost never fires, leaving just 2.
    expect(ranked[0]!.score).toBe(5);
  });

  // 70:25-70:44 ConditionalExpression [Survived] "false" — specifically
  // the "tokens.length === 0" half of "q.length === 0 || tokens.length
  // === 0", forced permanently false. A query that is NON-empty after
  // trimming but tokenizes to ZERO tokens (e.g. punctuation-only, since
  // tokenize() splits on non-alphanumeric characters and filters out the
  // empty results) must still trigger the early "no results" return —
  // otherwise the per-tool scoring loop below still runs with an empty
  // tokens array, and the INDEPENDENT whole-query-substring boost check
  // (which is not gated by tokens.length at all) could still fire for any
  // tool whose name happens to literally contain the punctuation.
  test("a punctuation-only query (non-empty but zero real tokens) returns nothing, even for a name containing that exact punctuation", () => {
    const tools: AdvertisedTool[] = [{ name: "cool!!!thing", description: "", inputSchema: {} }];
    expect(rankTools("!!!", tools, 10)).toEqual([]);
  });
});

describe("rankTools — description fallback", () => {
  // 75:39-75:41 StringLiteral [Survived] ('"Stryker was here!"' instead of
  // ""), on "(tool.description ?? \"\").toLowerCase()" used for SCORING. A
  // tool with no description at all (undefined at runtime, bypassing the
  // AdvertisedTool type via a cast — a real caller could still hand this
  // in) must score based on its NAME only; if the fallback were a non-empty
  // placeholder string, a query matching THAT placeholder text would
  // wrongly score via the description path even though the real tool has
  // no description whatsoever.
  test("a tool with no description at all is not matched via a fallback placeholder string", () => {
    const noDesc = [{ name: "zeta_tool", inputSchema: {} }] as unknown as AdvertisedTool[];
    // "here" would match a "Stryker was here!" placeholder but appears
    // nowhere in "zeta_tool" itself.
    expect(rankTools("here", noDesc, 10)).toEqual([]);
  });

  // 86:22-86:76 MethodExpression / 86:23-86:45 LogicalOperator / 86:43-86:45
  // StringLiteral [all Survived] — the SAME "?? \"\"" fallback, but for the
  // STORED result description (not the scoring copy). A tool with no
  // description that still scores (via a name match) must come back with
  // description: "", not undefined or a placeholder string.
  test("a tool with no description that scores via its name returns description: ''", () => {
    const noDesc = [{ name: "zeta_tool", inputSchema: {} }] as unknown as AdvertisedTool[];
    const ranked = rankTools("zeta", noDesc, 10);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.description).toBe("");
  });

  test("a long description is truncated to the 200-char snippet limit", () => {
    const long = "x".repeat(500);
    const tools: AdvertisedTool[] = [{ name: "snippet_tool", description: long, inputSchema: {} }];
    const ranked = rankTools("snippet", tools, 10);
    expect(ranked[0]!.description).toBe("x".repeat(200));
    expect(ranked[0]!.description.length).toBe(200);
  });
});

describe("rankTools — per-token scoring", () => {
  // 78:11-78:29 ConditionalExpression [Survived] "false" ("if
  // (name.includes(tok)) score += 2;" never fires). A query matching ONLY
  // the name (not the description at all) must still produce a positive
  // score and be included in the results. IMPORTANT: a single-word query
  // that is itself a literal substring of the name (e.g. "alpha" against
  // "alpha_widget") does NOT isolate this mutant — the separate
  // whole-query-substring BOOST (L82, a different code path entirely)
  // would independently score it too, masking the per-token check being
  // disabled. Use a MULTI-token query where only one token matches the
  // name and the full (untokenized) query phrase is never a literal
  // substring of it, so the boost cannot fire and the only possible
  // positive score comes from the per-token name check.
  test("a name-only match (no description overlap) still scores and is included", () => {
    const ranked = rankTools("gamma alpha", NAME_ONLY, 10);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.name).toBe("alpha_widget");
  });

  // 82:9-82:25 ConditionalExpression [Survived] "false" ("if
  // (name.includes(q)) score += 3;" — the whole-query-substring boost —
  // never fires). The existing sibling test for this boost
  // ("create_issue" against SAMPLE) does NOT actually distinguish it: the
  // winning tool already leads on per-token scoring alone, so disabling
  // the +3 boost doesn't change the ranking outcome. This test constructs
  // two tools with an EQUAL per-token score (4 each, verified by hand
  // below) where only ONE tool's name contains the query's exact phrase
  // ("red blue") as a contiguous substring, and that tool is deliberately
  // named ALPHABETICALLY AFTER the other — so under the real +3 boost it
  // wins outright, but under the mutant (boost disabled) the two tie
  // exactly and the secondary alphabetical comparator would rank the
  // OTHER tool first instead.
  test("the whole-query-substring boost outranks an alphabetically-earlier tool with an equal per-token score", () => {
    const tools: AdvertisedTool[] = [
      // Per-token score: name "red" (+2) + "blue" (+2) = 4. Plus the
      // literal-phrase boost (+3) since the name contains "red blue"
      // verbatim = 7 total.
      { name: "zzz red blue zzz", description: "", inputSchema: {} },
      // Per-token score: token "red" -> name.includes (+2) AND
      // desc.includes (+1) = 3; token "blue" -> name.includes false (0)
      // AND desc.includes (+1) = 1. Total = 4 — matching the OTHER tool's
      // PRE-boost score exactly. Name does not contain "red blue" as a
      // substring at all, so no boost applies; alphabetically "aaa..." <
      // "zzz...".
      { name: "aaa_red_widget", description: "red foo blue bar", inputSchema: {} },
    ];
    const ranked = rankTools("red blue", tools, 10);
    expect(ranked.map((r) => r.name)).toEqual(["zzz red blue zzz", "aaa_red_widget"]);
  });
});

describe("rankTools — tie-break sort", () => {
  // 92:25-92:74 ConditionalExpression [Survived] "true" (forces the
  // secondary "a.name.localeCompare(b.name)" comparator branch to always
  // run) and 92:25-92:42 ArithmeticOperator [Survived] ("b.score - a.score"
  // -> "b.score + a.score", which would sort ascending-by-sum instead of
  // descending-by-score). Two tools with an EQUAL score, registered in
  // reverse-alphabetical input order, must come back alphabetically
  // sorted — proving the primary comparator is a real score-descending
  // sort (not the mutant's nonsensical sum) and the secondary comparator
  // (name) is what breaks the tie.
  test("equal-scoring tools are tie-broken alphabetically by name", () => {
    const tools: AdvertisedTool[] = [
      { name: "zzz_match", description: "irrelevant", inputSchema: {} },
      { name: "aaa_match", description: "irrelevant", inputSchema: {} },
    ];
    const ranked = rankTools("match", tools, 10);
    expect(ranked.map((r) => r.name)).toEqual(["aaa_match", "zzz_match"]);
  });

  test("a genuinely higher-scoring tool still outranks a lower one, proving score is descending not ascending", () => {
    const tools: AdvertisedTool[] = [
      { name: "low_score", description: "match", inputSchema: {} },
      { name: "match_match", description: "match match match", inputSchema: {} },
    ];
    const ranked = rankTools("match", tools, 10);
    expect(ranked[0]!.name).toBe("match_match");
  });
});

// ===========================================================================
// runSearchTool — query/limit argument coercion (L101-110).
// ===========================================================================

describe("runSearchTool — query coercion", () => {
  // 103:8-103:20 MethodExpression [Survived] "query" (real: "query.trim()"
  // — the ".trim()" call removed from the emptiness check). The existing
  // sibling test only covers a MISSING query key (empty string via the
  // ternary's own default) — a WHITESPACE-ONLY query is a truthy,
  // non-empty raw string that only becomes "empty" after trimming.
  test("a whitespace-only query is treated as empty and errors", () => {
    const res = runSearchTool({ query: "   " }, NAME_ONLY);
    expect(res.isError).toBe(true);
  });

  // 104:23-104:74 StringLiteral [Survived] (the error message text
  // emptied). The existing sibling test only checks isError === true, not
  // the actual message content.
  test("the missing-query error has the exact message text", () => {
    const res = runSearchTool({}, NAME_ONLY);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe("search_tools requires a non-empty 'query' string.");
  });
});

describe("runSearchTool — limit coercion", () => {
  // 106:17-106:78 ConditionalExpression / LogicalOperator [Survived]
  // ("&&" -> "||") and 106:39-106:47 StringLiteral [Survived] ("number" ->
  // "") on "typeof args.limit === \"number\" && Number.isFinite(args.limit)
  // ? Math.floor(args.limit) : DEFAULT_LIMIT". Three cases the type/
  // finiteness guard must independently reject, each falling back to the
  // real DEFAULT_LIMIT (10), plus the success path's Math.floor.
  const manyTools: AdvertisedTool[] = Array.from({ length: 20 }, (_, i) => ({
    name: `tool_${i}`,
    description: "match",
    inputSchema: {},
  }));

  test("a non-number limit (string) falls back to the default of 10, not NaN/uncapped", () => {
    const res = runSearchTool({ query: "match", limit: "5" }, manyTools);
    const parsed = JSON.parse(res.content[0]!.text ?? "") as { matches: unknown[] };
    expect(parsed.matches).toHaveLength(10);
  });

  test("a non-finite limit (Infinity) falls back to the default of 10", () => {
    const res = runSearchTool({ query: "match", limit: Infinity }, manyTools);
    const parsed = JSON.parse(res.content[0]!.text ?? "") as { matches: unknown[] };
    expect(parsed.matches).toHaveLength(10);
  });

  test("a real finite number limit is floored and honored, not replaced by the default", () => {
    const res = runSearchTool({ query: "match", limit: 3.7 }, manyTools);
    const parsed = JSON.parse(res.content[0]!.text ?? "") as { matches: unknown[] };
    expect(parsed.matches).toHaveLength(3);
  });
});
