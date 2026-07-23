# Support

Thanks for using MCP REST Bridge. This page is a router: it points you at the
fastest path for each kind of question, so nothing gets lost in the wrong queue.

## Start with the docs

Most questions are answered on the [documentation site](https://carlxsmg.github.io/mcpbridge/):

- **[Getting started](https://carlxsmg.github.io/mcpbridge/guide/getting-started)** —
  install, boot the gateway, register a first backend.
- **[Registering backends](https://carlxsmg.github.io/mcpbridge/guide/registering-backends)** —
  REST/OpenAPI, GraphQL, and MCP upstreams, with the payload for each.
- **[Configuration](https://carlxsmg.github.io/mcpbridge/guide/configuration)** —
  every environment variable, with defaults.
- **[Troubleshooting](https://carlxsmg.github.io/mcpbridge/guide/troubleshooting)** —
  the common failure modes and how to read them.
- **[FAQ](https://carlxsmg.github.io/mcpbridge/guide/faq)** — the short answers.

The docs are also available in Spanish / también en español:
[documentación](https://carlxsmg.github.io/mcpbridge/es/guide/getting-started).

## Where to ask

| Your situation                             | Where to go                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| "How do I…?", ideas, open-ended discussion | [Discussions](https://github.com/CarlxsMG/mcpbridge/discussions)                                 |
| Something is broken and reproducible       | [Bug report](https://github.com/CarlxsMG/mcpbridge/issues/new?template=bug_report.yml)           |
| You want a capability that doesn't exist   | [Feature request](https://github.com/CarlxsMG/mcpbridge/issues/new?template=feature_request.yml) |
| You found a security vulnerability         | **Not an issue** — see below                                                                     |
| You want to contribute code                | [CONTRIBUTING.md](CONTRIBUTING.md)                                                               |

## Security issues

**Never report a vulnerability in a public issue or discussion.** Use
[private vulnerability reporting](https://github.com/CarlxsMG/mcpbridge/security/advisories/new)
so the details stay between you and the maintainers until a fix ships. The full
policy, including what to include and what to expect, is in [SECURITY.md](SECURITY.md).

## Writing a good bug report

This is a proxy/gateway, so the details that actually narrow a bug down are:

- The **version or commit** you're running, and how you're running it (Bun, Docker, Helm).
- Which **endpoint** the call went through — `/mcp`, `/mcp/:clientName`, or
  `/mcp-custom/:bundleName` — since each applies a different filter before dispatch.
- The **backend kind** involved: REST/OpenAPI, GraphQL, or an MCP upstream.
- A **request/response trace**, with credentials redacted.
- Relevant **gateway logs**, ideally with `LOG_LEVEL=debug`.

Please redact API keys, bearer tokens, and internal hostnames before posting.

## Support expectations

This is an open-source project maintained on a best-effort basis — there is no SLA
and no commercial support offering. Issues and discussions are answered when time
allows. Well-scoped bug reports with a reproduction, and PRs, get attention first.
