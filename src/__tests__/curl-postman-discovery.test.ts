/**
 * Unit tests for parseCurlCommand / parsePostmanCollection — the pure parsers
 * that back the "paste a cURL command" and "upload/paste a Postman
 * Collection" alternate discovery modes (see curl-postman-discovery.ts).
 * These are plain functions with no DB/network dependency, so no
 * __resetDbForTesting() or app bootstrap is needed here.
 */
import { describe, test, expect } from "bun:test";
import { parseCurlCommand, parsePostmanCollection } from "../curl-postman-discovery.js";

describe("parseCurlCommand", () => {
  test("parses method, endpoint, and multiple headers (folded into description, not persisted as values)", () => {
    const cmd = [
      "curl -X POST https://api.example.com/users \\",
      '  -H "Content-Type: application/json" \\',
      '  -H "X-Api-Key: secret123" \\',
      "  -d '{\"name\":\"Jane\"}'",
    ].join("\n");

    const tools = parseCurlCommand(cmd);
    expect(tools).toHaveLength(1);
    const [tool] = tools;
    expect(tool.method).toBe("POST");
    expect(tool.endpoint).toBe("/users");
    // Header names are surfaced for operator awareness...
    expect(tool.description).toContain("Content-Type");
    expect(tool.description).toContain("X-Api-Key");
    // ...but never their values (a tool description is visible to any MCP client).
    expect(tool.description).not.toContain("secret123");
    expect(tool.description).not.toContain("application/json");
  });

  test("handles quoted args with embedded spaces (header value and JSON body)", () => {
    const cmd = `curl -X PUT "https://api.example.com/orders/42" -H "X-Reason: customer requested change" -d '{"status": "shipped", "note": "left at front door"}'`;

    const [tool] = parseCurlCommand(cmd);
    expect(tool.method).toBe("PUT");
    expect(tool.endpoint).toBe("/orders/42");
    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {
        status: { type: "string" },
        note: { type: "string" },
      },
    });
    expect(tool.description).toContain("X-Reason");
  });

  test("-d without -X implies POST", () => {
    const [tool] = parseCurlCommand(`curl https://api.example.com/users -d '{"email":"a@b.com"}'`);
    expect(tool.method).toBe("POST");
    expect(tool.inputSchema.properties).toMatchObject({ email: { type: "string" } });
  });

  test("no -d and no -X defaults to GET, and query-string keys populate the schema", () => {
    const [tool] = parseCurlCommand(`curl "https://api.example.com/search?q=widgets&limit=10"`);
    expect(tool.method).toBe("GET");
    expect(tool.endpoint).toBe("/search");
    expect(tool.inputSchema.properties).toMatchObject({
      q: { type: "string" },
      limit: { type: "string" },
    });
  });

  test("parses a multi-request cURL paste (blank-line separated, one using line continuations)", () => {
    const paste = `
# list_users
curl https://api.example.com/users

curl -X POST https://api.example.com/users \\
  -H "Content-Type: application/json" \\
  -d '{"name":"Jane"}'
`;
    const tools = parseCurlCommand(paste);
    expect(tools).toHaveLength(2);

    const list = tools.find((t) => t.method === "GET")!;
    const create = tools.find((t) => t.method === "POST")!;
    expect(list.name).toBe("list_users"); // explicit "# list_users" comment name
    expect(list.endpoint).toBe("/users");
    expect(create.name).not.toBe(list.name); // distinct inferred name
    expect(create.endpoint).toBe("/users");
    expect(create.inputSchema.properties).toMatchObject({ name: { type: "string" } });
  });

  test("infers a slugified name from method+path when no comment name is given", () => {
    const [tool] = parseCurlCommand(`curl -X DELETE https://api.example.com/orders/42`);
    expect(tool.name).toBe("delete_orders_42");
  });

  test("disambiguates repeated inferred names across multiple commands in one paste", () => {
    const paste = `curl https://api.example.com/ping\ncurl https://api.example.com/ping`;
    const tools = parseCurlCommand(paste);
    expect(tools).toHaveLength(2);
    expect(new Set(tools.map((t) => t.name)).size).toBe(2);
  });

  test("-u/--user is recognized as implying an Authorization header without leaking the credential", () => {
    const [tool] = parseCurlCommand(`curl -u admin:hunter2 https://api.example.com/secure`);
    expect(tool.description).toContain("Authorization");
    expect(tool.description).not.toContain("hunter2");
    expect(tool.description).not.toContain("admin:hunter2");
  });

  test("-XPOST combined short-flag form is recognized", () => {
    const [tool] = parseCurlCommand(`curl -XPOST https://api.example.com/events`);
    expect(tool.method).toBe("POST");
  });

  test("skips a HEAD/OPTIONS request (not a registrable tool method) rather than crashing", () => {
    const paste = `curl -X HEAD https://api.example.com/ping\ncurl https://api.example.com/status`;
    const tools = parseCurlCommand(paste);
    expect(tools).toHaveLength(1);
    expect(tools[0].endpoint).toBe("/status");
  });

  test("throws when given empty input", () => {
    expect(() => parseCurlCommand("")).toThrow();
    expect(() => parseCurlCommand("   \n  ")).toThrow();
  });

  test("throws when no valid command can be found", () => {
    expect(() => parseCurlCommand("# just a comment, no command")).toThrow();
  });

  test("urlencoded --data-urlencode style body contributes its keys", () => {
    const [tool] = parseCurlCommand(`curl https://api.example.com/login -d 'user=alice' -d 'pass=hunter2'`);
    expect(tool.method).toBe("POST");
    expect(Object.keys(tool.inputSchema.properties as object)).toEqual(
      expect.arrayContaining(["user", "pass"]),
    );
  });
});

describe("parsePostmanCollection", () => {
  function fixture() {
    return {
      info: {
        name: "Demo API",
        schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      },
      item: [
        {
          name: "Users",
          item: [
            {
              name: "Get",
              request: {
                method: "GET",
                header: [{ key: "Accept", value: "application/json" }],
                url: {
                  raw: "https://api.example.com/users?active=true",
                  host: ["api", "example", "com"],
                  path: ["users"],
                  query: [{ key: "active", value: "true" }],
                },
              },
            },
            {
              name: "Create",
              request: {
                method: "POST",
                header: [{ key: "Content-Type", value: "application/json" }],
                url: { raw: "https://api.example.com/users", path: ["users"] },
                body: { mode: "raw", raw: JSON.stringify({ name: "", email: "" }) },
              },
            },
          ],
        },
        {
          name: "Admin",
          item: [
            {
              name: "Get",
              request: {
                method: "GET",
                url: { raw: "https://api.example.com/admin/stats", path: ["admin", "stats"] },
              },
            },
          ],
        },
      ],
    };
  }

  test("flattens a nested-folder collection into folder-prefixed tool names", () => {
    const tools = parsePostmanCollection(fixture());
    expect(tools).toHaveLength(3);
    const names = tools.map((t) => t.name).sort();
    // Two leaf items are both literally named "Get" in different folders —
    // folder-path prefixing (Users/Get, Admin/Get) keeps them distinct
    // instead of colliding into "get" / "get_2".
    expect(names).toEqual(["admin_get", "users_create", "users_get"]);
  });

  test("uses structured url.query for the GET tool's schema", () => {
    const tools = parsePostmanCollection(fixture());
    const usersGet = tools.find((t) => t.name === "users_get")!;
    expect(usersGet.method).toBe("GET");
    expect(usersGet.endpoint).toBe("/users");
    expect(usersGet.inputSchema.properties).toMatchObject({ active: { type: "string" } });
  });

  test("uses raw JSON body keys for the POST tool's schema", () => {
    const tools = parsePostmanCollection(fixture());
    const usersCreate = tools.find((t) => t.name === "users_create")!;
    expect(usersCreate.method).toBe("POST");
    expect(usersCreate.inputSchema.properties).toMatchObject({
      name: { type: "string" },
      email: { type: "string" },
    });
    expect(usersCreate.description).toContain("Content-Type");
  });

  test("admin folder's request resolves independently of the users folder", () => {
    const tools = parsePostmanCollection(fixture());
    const adminGet = tools.find((t) => t.name === "admin_get")!;
    expect(adminGet.endpoint).toBe("/admin/stats");
  });

  test("throws on a non-object input", () => {
    expect(() => parsePostmanCollection("not json")).toThrow();
    expect(() => parsePostmanCollection(null)).toThrow();
  });

  test("throws when 'item' array is missing", () => {
    expect(() => parsePostmanCollection({ info: { name: "x" } })).toThrow();
  });

  test("throws when the collection has no usable requests", () => {
    expect(() => parsePostmanCollection({ item: [{ name: "empty folder", item: [] }] })).toThrow();
  });

  test("urlencoded body mode contributes its keys", () => {
    const collection = {
      item: [
        {
          name: "Login",
          request: {
            method: "POST",
            url: "https://api.example.com/login",
            body: {
              mode: "urlencoded",
              urlencoded: [
                { key: "user", value: "alice" },
                { key: "pass", value: "hunter2", disabled: false },
                { key: "ignored", value: "x", disabled: true },
              ],
            },
          },
        },
      ],
    };
    const [tool] = parsePostmanCollection(collection);
    expect(Object.keys(tool.inputSchema.properties as object).sort()).toEqual(["pass", "user"]);
  });

  test("a plain string url (no structured host/path/query) still resolves via fallback parsing", () => {
    const collection = {
      item: [{ name: "Ping", request: { method: "GET", url: "https://api.example.com/ping?verbose=true" } }],
    };
    const [tool] = parsePostmanCollection(collection);
    expect(tool.endpoint).toBe("/ping");
    expect(tool.inputSchema.properties).toMatchObject({ verbose: { type: "string" } });
  });
});
