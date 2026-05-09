---
id: pattern_7ce21ad1eea03f01
kind: pattern
source_path: structured metadata spread
title: "Structured Metadata Spread"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.869Z
---

# Structured Metadata Spread

**Path:** `structured metadata spread`  
**Kind:** `pattern`

> Spreading meta onto the root JSON object (rather than nesting under a 'meta' key) keeps log entries flat, improving query ergonomics in tools like Loki or Elasticsearch.

Spreading meta onto the root JSON object (rather than nesting under a 'meta' key) keeps log entries flat, improving query ergonomics in tools like Loki or Elasticsearch.



