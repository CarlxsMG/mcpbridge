# Why MCP REST Bridge

The [Model Context Protocol](https://modelcontextprotocol.io) ecosystem is moving fast, and
the gateway/aggregator space is crowded. Here's where MCP REST Bridge fits and why you might
pick it.

> **Who this is for:** teams exposing REST APIs or aggregating MCP servers for AI agents, who
> want an admin UI and governance (RBAC, guardrails, audit) without standing up Kubernetes or
> a database. See "When it's a good fit" further down for the full picture, or the
> [FAQ →](/guide/faq) for specific questions.

## The problem

As soon as you have more than one MCP server — or a REST API you want an AI agent to use —
you hit the same questions:

- How do I expose a REST/OpenAPI API to MCP clients **without hand-writing a server**?
- How do I put **many backends behind one endpoint** and hand each client only the tools it
  needs?
- How do I stop a tool call from hitting my **internal network** (SSRF), leaking **secrets**,
  or being steered by **prompt injection**?
- How do I get **rate limits, RBAC, audit and observability** — without standing up
  Kubernetes and a database?

## The approach

MCP REST Bridge is a single, self-hosted gateway that does all of the above and is **managed
from a real admin UI, or as version-controlled YAML via the `gateway` CLI** — not by scripting
a bare admin API by hand.

- **Bidirectional.** REST/OpenAPI → MCP **and** MCP → MCP, in one process.
- **Secure by default.** SSRF/DNS-rebinding protection, IP pinning, prompt-injection
  sanitizing and secret detection are always on.
- **Batteries included.** Per-tool guardrails, RBAC, teams, canary/failover, config
  versioning, OpenTelemetry tracing and a hash-chained audit log.
- **Tested rigorously.** A 330+-file backend suite, Vitest for the admin UI, Playwright
  end-to-end, and Stryker mutation testing that verifies the tests actually catch injected bugs.
- **Lightweight.** Bun + SQLite. No external DB, no Kubernetes.

## How it compares

Most tools in this space fall into three buckets:

|                                              | OpenAPI→MCP CLIs | Heavy gateways (k8s) | **MCP REST Bridge** |
| -------------------------------------------- | :--------------: | :------------------: | :-----------------: |
| REST / GraphQL / OpenAPI → MCP               |        ✅        |       partial        |         ✅          |
| MCP → MCP gateway                            |        ❌        |          ✅          |         ✅          |
| Admin UI                                     |        ❌        |         some         |     ✅ Vue SPA      |
| Built-in security (SSRF, injection, secrets) |        ❌        |         some         |         ✅          |
| RBAC + audit + teams                         |        ❌        |          ✅          |         ✅          |
| Runs without Kubernetes                      |        ✅        |          ❌          |         ✅          |
| No external database                         |        ✅        |          ❌          |  ✅ (Bun + SQLite)  |

- **OpenAPI→MCP converters/CLIs** are great for a one-shot translation, but they don't manage
  a running fleet — no UI, no per-tool policy, no audit.
- **Heavy/enterprise gateways** are powerful but assume containers, Kubernetes and often a
  database and cloud identity provider.

MCP REST Bridge aims for the middle: **the governance of an enterprise gateway with the
footprint of a single binary**, plus a UI you'd actually hand to a teammate.

_Capabilities of other projects vary and evolve quickly — this is general positioning, not a
scorecard of any specific tool. Check each project for its current feature set._

## When it's a good fit

- You want to expose internal REST APIs to AI agents **safely and quickly**.
- You're aggregating several MCP servers and need **one governed endpoint** with access
  control.
- You want **self-hosted** control and an audit trail, without operating heavy infra.

## When it might not be

- You need managed SaaS with an SLA (this is self-hosted, MIT-licensed open source).
- You require Kubernetes-native, multi-cluster routing as a hard requirement today.

Ready? **[Get started →](/guide/getting-started)**
