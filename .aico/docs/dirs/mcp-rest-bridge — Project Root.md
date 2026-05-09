---
id: dir_9d1ae5a6cdbe837d
kind: dir
source_path: 
title: "mcp-rest-bridge — Project Root"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.617Z
---

# mcp-rest-bridge — Project Root

**Kind:** `dir`  
**Model:** `sonnet`

> `mcp-rest-bridge` is a production-grade Bun/TypeScript service bridging REST APIs to Model Context Protocol (MCP) tool surfaces for LLM agents. A multi-stage Alpine Docker image runs the app unprivileged on port 3000. The Express 5 HTTP layer hosts dual MCP transports (Streamable HTTP + legacy SSE) with TTL session management. A singleton Registry supports manual or OpenAPI auto-discovery tool registration via `@scalar/openapi-parser`. A circuit-breaking proxy adds exponential-backoff retry and DNS-pinned SSRF defenses. Security spans Bearer auth, sliding-window rate limiting, origin validation, and prompt-injection sanitization. Structured logging, request-ID tracing, Swagger UI, and a `/metrics` endpoint provide full observability. All behavior is environment-driven.

# mcp-rest-bridge — Project Root

## Overview
`mcp-rest-bridge` (v1.0.0) is a production-grade Bun/TypeScript service that acts as a protocol bridge, translating REST API surfaces into Model Context Protocol (MCP) tool calls consumable by LLM agents. The project root contains all configuration artifacts (`package.json`, `tsconfig.json`, `Dockerfile`) and the full application source under `src/`.

## Runtime & Build
- **Runtime**: [Bun](https://bun.sh/) — ESNext modules, `bundler` module resolution, strict TypeScript 5.7.
- **Containerization**: Multi-stage Alpine Docker build (`oven/bun:1-alpine`). A dedicated `deps` stage isolates production-only dependency installation; the final image copies only compiled artifacts and `src/`, runs as the unprivileged `bun` user, and exposes port 3000 (overridable via `PORT`).
- **Scripts**: `dev` (hot-reload), `start` (production), `test` (Bun test runner), `typecheck` (tsc no-emit).

## Core Architecture (`src/`)
The application is an Express 5 HTTP server with four primary subsystems:

| Subsystem | Responsibility |
|---|---|
| **Transport Layer** | Dual MCP transports — Streamable HTTP (primary) and legacy SSE (compatibility); TTL-based session lifecycle management. |
| **Tool Registry** | Singleton registry for MCP tool registration; supports both manual registration and automatic OpenAPI spec ingestion via `@scalar/openapi-parser`. |
| **Proxy Engine** | Circuit-breaking HTTP proxy to upstream REST backends; exponential-backoff retry, DNS-pinned IP resolution to prevent SSRF rebinding. |
| **Health Monitor** | Periodic health-check loop against registered backends; auto-evicts unhealthy tools from the registry. |

## Key Dependencies
| Package | Role |
|---|---|
| `@modelcontextprotocol/sdk` | MCP protocol implementation (server, transports, tool schema) |
| `@scalar/openapi-parser` | OpenAPI/YAML spec parsing for auto-discovery |
| `express` (v5) | HTTP routing and middleware layer |
| `swagger-ui-express` | Serves interactive Swagger UI for registered API specs |
| `bun-types` | Bun runtime global type injection |

## Security Model
- **SSRF defenses**: DNS pinning + blocklisted private IP ranges on all outbound proxy requests.
- **Authentication**: Timing-safe Bearer token validation on protected endpoints.
- **Rate limiting**: Sliding-window per-client request throttling.
- **Input sanitization**: Prompt-injection sanitization on tool call arguments.
- **Network**: CORS policy enforcement and origin validation on inbound connections.

## Observability
- Structured JSON logging with request-ID tracing across the full request lifecycle.
- `/metrics` endpoint exposing runtime counters (requests, errors, circuit-breaker state).
- Swagger UI served for registered OpenAPI specs, enabling interactive exploration of bridged tools.

## Configuration
All runtime behaviour (port, auth tokens, backend URLs, rate-limit parameters, TTLs, log level) is driven entirely by environment variables — no hardcoded configuration.
## Domains

- `mcp`
- `rest-bridge`
- `bun`
- `typescript`
- `docker`
- `express`
- `openapi`
- `security`
- `observability`
- `llm-tooling`


---

## Backlinks

### child_of
- [Dockerfile — Multi-Stage Bun/Alpine Production Container](../files/Dockerfile.md)
- [package.json — mcp-rest-bridge Project Manifest](../files/package.json.md)
- [TypeScript Compiler Configuration](../files/tsconfig.json.md)




