import { describe, test, expect, beforeEach } from "bun:test";

// Pins the `clients.kind` column against the two ways it used to go wrong:
//
//   1. GraphQL registrations run through persistRestRegistration (their
//      generated tools are ordinary POSTs), which never wrote `kind` and so
//      took the column's 'rest' DEFAULT. A GraphQL endpoint was then
//      indistinguishable from a REST one in the registry, the admin API and
//      the admin UI's KindBadge.
//   2. The INSERT's ON CONFLICT clause never updated `kind`, so re-registering
//      an existing name under a different kind left the previous value behind.

import { RegistryPersistence } from "../registry-persistence.js";
import { __resetDbForTesting, getDb } from "../../db/connection.js";
import type { RestToolDefinition } from "../types.js";

const persistence = new RegistryPersistence();

beforeEach(() => {
  __resetDbForTesting();
});

function tool(name = "a"): RestToolDefinition {
  return { name, method: "POST", endpoint: "/graphql", description: "d", inputSchema: { type: "object" } };
}

function persist(name: string, kind: "rest" | "graphql") {
  persistence.persistRestRegistration(
    name,
    [tool()],
    "http://example.com/health",
    "1.2.3.4",
    "http://example.com",
    "1.2.3.4",
    false,
    kind,
  );
}

function storedKind(name: string): string {
  return (getDb().query(`SELECT kind FROM clients WHERE name = ?`).get(name) as { kind: string }).kind;
}

describe("clients.kind is written explicitly by the REST persistence path", () => {
  test("a graphql registration persists kind='graphql', not the column default", () => {
    persist("gql-svc", "graphql");
    expect(storedKind("gql-svc")).toBe("graphql");
  });

  test("a rest registration still persists kind='rest'", () => {
    persist("rest-svc", "rest");
    expect(storedKind("rest-svc")).toBe("rest");
  });

  test("the hydrated client carries the persisted kind", () => {
    persist("gql-hydrate", "graphql");
    expect(persistence.buildPersistedClientFromDb("gql-hydrate")!.kind).toBe("graphql");
  });

  test("re-registering the same name under a different kind overwrites it", () => {
    persist("switcheroo", "graphql");
    persist("switcheroo", "rest");
    expect(storedKind("switcheroo")).toBe("rest");
  });

  test("re-registering an MCP upstream as graphql overwrites kind='mcp'", () => {
    persistence.persistMcpRegistration(
      "was-mcp",
      [{ name: "t", upstreamName: "t", description: "d", inputSchema: { type: "object" } }],
      "http://example.com/mcp",
      "streamable-http",
      "1.2.3.4",
      "1.2.3.4",
    );
    expect(storedKind("was-mcp")).toBe("mcp");

    persist("was-mcp", "graphql");
    expect(storedKind("was-mcp")).toBe("graphql");
  });
});
