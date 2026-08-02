/**
 * The e2e-only OpenAPI document, served at `/openapi-extended.json`.
 *
 * Deliberately NOT an addition to `fixtures/simple-openapi.json`: that file is
 * shared with the backend unit suite, where at least one test asserts on its
 * exact discovered-tool set, so growing it breaks tests unrelated to e2e. This
 * document is a superset — it keeps `list-users` / `create-user` byte-compatible
 * with the shared fixture so a spec can register against either doc and see the
 * same two tools, then adds the endpoints the newer specs drive:
 *
 *   - `get-secret`  -> a body containing credential-shaped strings, to prove the
 *                      response sanitizer redacts them before they reach a client.
 *   - `flaky`       -> 200 normally, 500 once the control channel puts it "down",
 *                      so a spec can trip a per-client circuit breaker on demand.
 *   - `slow`        -> sleeps, for per-tool timeout guards.
 *   - `echo`        -> reflects the request headers/query the bridge actually sent
 *                      upstream (Host pinning, injected auth, forwarded params).
 */
export const EXTENDED_OPENAPI = {
  openapi: "3.1.0",
  info: { title: "Test API (e2e extended)", version: "1.0.0" },
  servers: [{ url: "/api/v1" }],
  paths: {
    "/users": {
      get: {
        operationId: "list-users",
        summary: "List all users",
        parameters: [
          {
            name: "limit",
            in: "query",
            schema: { type: "integer" },
            description: "Maximum results",
          },
        ],
        responses: { "200": { description: "Success" } },
      },
      post: {
        operationId: "create-user",
        summary: "Create a user",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  email: { type: "string" },
                },
                required: ["name", "email"],
              },
            },
          },
        },
        responses: { "201": { description: "Created" } },
      },
    },
    "/secret": {
      get: {
        operationId: "get-secret",
        summary: "Return a payload containing credential-shaped strings",
        responses: { "200": { description: "Success" } },
      },
    },
    "/flaky": {
      get: {
        operationId: "flaky",
        summary: "Succeeds until the control channel marks it down, then 500s",
        responses: { "200": { description: "Success" } },
      },
    },
    "/slow": {
      get: {
        operationId: "slow",
        summary: "Responds after a delay",
        parameters: [
          {
            name: "ms",
            in: "query",
            schema: { type: "integer" },
            description: "How long to wait before responding",
          },
        ],
        responses: { "200": { description: "Success" } },
      },
    },
    "/echo": {
      get: {
        operationId: "echo",
        summary: "Reflects the request the bridge actually sent upstream",
        responses: { "200": { description: "Success" } },
      },
    },
  },
} as const;
