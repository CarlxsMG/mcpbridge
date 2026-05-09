---
id: file_8829d00a784676d5
kind: file
source_path: src/sanitize.ts
title: "sanitize.ts — Tool Description Sanitization & Prompt Injection Defense"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.789Z
---

# sanitize.ts — Tool Description Sanitization & Prompt Injection Defense

**Path:** `src/sanitize.ts`  
**Kind:** `file`  
**Model:** `sonnet`  
**Generated:** `sonnet@item-doc/v1`

> Exports `sanitizeToolDescription`, a security-focused utility that scrubs untrusted tool description strings before they are exposed to an LLM. It defends against prompt-injection attacks via three layers: Unicode normalization (NFC + NFD diacritic stripping) to defeat homoglyph bypasses, regex-based removal of known injection phrases (e.g. "ignore previous", "act as", "SYSTEM:"), and markdown code-block stripping. The result is collapsed, trimmed, and hard-truncated at 500 characters. A structured warning is emitted via the logger whenever any mutation occurs.

# `src/sanitize.ts`

## Purpose

Provides a single exported function, `sanitizeToolDescription`, that sanitizes arbitrary tool description strings before they are presented to an LLM. The primary threat model is **prompt injection via malicious MCP tool descriptions**: an attacker-controlled tool could embed instructions that hijack the agent's behaviour. This module neutralizes those attempts through layered scrubbing.

---

## Exports

### `sanitizeToolDescription(description: string): string`

Applies the following pipeline in order:

1. **Unicode normalization** — calls `String.normalize("NFC")` then strips combining diacritics (`̀–ͯ`) from the Latin Extended block (`À–ÿ`). This collapses homoglyphs such as `ÏMPÖRTANT` → `IMPORTANT` so they are caught by later pattern matching.

2. **Markdown code-block stripping** — removes all fenced code blocks matched by ` ```…``` ` (greedy, dotAll). Prevents embedding of hidden instructions inside rendered-invisible blocks.

3. **Suspicious-pattern removal** — iterates `SUSPICIOUS_PATTERNS` (12 case-insensitive regexes) and replaces each match with an empty string. Targeted phrases include injection starters (`IMPORTANT:`, `SYSTEM:`, `INSTRUCTION:`), override verbs (`ignore previous`, `ignore all`, `forget your/all`), coercion phrases (`you must`, `do not tell the user`, `do not reveal`), and persona-shift phrases (`act as`, `pretend to/you`).

4. **Whitespace collapse** — replaces runs of two or more spaces with a single space and trims.

5. **Hard truncation** — clips output to 500 characters (constant `MAX_DESCRIPTION_LENGTH`), appending `"..."` on overflow.

If any step mutated the input, a `"warn"`-level structured log entry is emitted via [[logger.ts]] with the original and sanitized lengths.

---

## Key Constants

| Identifier | Value | Role |
|---|---|---|
| `SUSPICIOUS_PATTERNS` | 12-element `RegExp[]` | Prompt-injection phrase blocklist |
| `MARKDOWN_CODE_BLOCK` | `` /```[\s\S]*?```/g `` | Fenced code block detector |
| `MAX_DESCRIPTION_LENGTH` | `500` | Hard character cap on output |

---

## Edge Cases & Gotchas

- **Homoglyph coverage is partial**: only the Latin-1 Supplement block (`À–ÿ`) is normalised. Characters outside this range (e.g. Cyrillic lookalikes) are not stripped, leaving a potential bypass surface.
- **Lazy vs greedy code-block regex**: the regex uses `[\s\S]*?` (lazy), so two separate fenced blocks are removed independently rather than one giant span being consumed. This is correct behaviour.
- **Pattern ordering matters**: patterns are applied sequentially with independent `replace` calls, so a prior replacement could theoretically split a phrase and allow it to survive a later pattern. Concatenated adversarial strings may partially survive.
- **Truncation occurs after all removals**: a description that expands due to space collapse will still be truncated. This means the logged `sanitized_length` always reflects the final output length.
- **`wasSanitized` flag is cumulative**: once set to `true` by any step, it is never reset; a single warning covers all mutations.
- **No return of metadata**: callers cannot distinguish which specific pattern triggered sanitization without reading logs.

---

## References

### has_failure_mode
- [Novel Injection Phrase Not Blocked](../knowledge/failure-modes/novel-injection-phrase-not-blocked.md)
- [Phrase Fragmentation Bypass](../knowledge/failure-modes/phrase-fragmentation-bypass.md)
- [Partial Homoglyph Bypass](../knowledge/failure-modes/partial-homoglyph-bypass.md)
- [Silent Truncation Data Loss](../knowledge/failure-modes/silent-truncation-data-loss.md)
- [Greedy Code Block Over-removal](../knowledge/failure-modes/greedy-code-block-over-removal.md)

### has_pattern
- [Layered Defense / Defense in Depth](../knowledge/patterns/layered-defense-defense-in-depth.md)
- [Mutation Flag with Lazy Logging](../knowledge/patterns/mutation-flag-with-lazy-logging.md)
- [Hard Output Truncation](../knowledge/patterns/hard-output-truncation.md)

### references
- [MAX_DESCRIPTION_LENGTH](../knowledge/concepts/max-description-length.md)
- [SUSPICIOUS_PATTERNS](../knowledge/concepts/suspicious-patterns.md)

### uses_concept
- [sanitizeToolDescription](../knowledge/concepts/sanitizetooldescription.md)
- [MAX_DESCRIPTION_LENGTH](../knowledge/concepts/max-description-length.md)
- [Unicode Normalization](../knowledge/concepts/unicode-normalization.md)
- [Homoglyph Attack](../knowledge/concepts/homoglyph-attack.md)
- [Prompt Injection](../knowledge/concepts/prompt-injection.md)
- [SUSPICIOUS_PATTERNS](../knowledge/concepts/suspicious-patterns.md)
- [Markdown Code Block Stripping](../knowledge/concepts/markdown-code-block-stripping.md)

## Backlinks

### references
- [Registry — MCP Client & Tool Registration Manager](src--registry.ts.md)

### parent_of
- [src — MCP REST Bridge: Full Application Root](../dirs/src.md)




