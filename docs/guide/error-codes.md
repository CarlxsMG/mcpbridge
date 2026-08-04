<!-- GENERATED FILE — DO NOT EDIT. Written by scripts/generate.ts from src/routes/error-codes.ts. -->

# Error codes

Every error this gateway returns carries a stable, machine-readable `code`. Match on the code, not on the message: messages are written for humans, carry request-specific detail, and are free to change. Codes are part of the API contract.

## The envelope

Errors share one shape across the admin API, the MCP planes and the WebSocket proxy. `request_id` is repeated in the `X-Request-ID` response header and in the audit log, so an operator can tie a message a user is looking at to the exact request that produced it.

```json
{
  "error": {
    "code": "CLIENT_NOT_FOUND",
    "message": "Client not found",
    "request_id": "01J8Z5X9WQ4H0T6C3N2K7M1P8R"
  }
}
```

## Codes

| Code                              | Meaning                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| `ALERT_NOT_FOUND`                 | No alert rule with that id.                                                            |
| `ALREADY_EXISTS`                  | An entity with that name already exists.                                               |
| `ALREADY_REVOKED`                 | The API key was revoked already.                                                       |
| `APPROVAL_NOT_FOUND`              | No approval request with that id.                                                      |
| `BACKUP_FAILED`                   | The database backup could not be created.                                              |
| `BACKUP_STREAM_FAILED`            | The backup was created but failed while streaming to the client.                       |
| `BAD_REQUEST`                     | Generic 4xx fallback for a request the gateway could not process.                      |
| `BUNDLE_NOT_FOUND`                | No bundle by that name.                                                                |
| `CATALOG_ENTRY_NOT_FOUND`         | No catalog entry with that slug.                                                       |
| `CLIENT_NOT_FOUND`                | No registered client by that name — also returned when another team owns it.           |
| `COMPOSITE_NOT_FOUND`             | No composite (macro) tool by that name.                                                |
| `CONSUMER_EXISTS`                 | A consumer with that name already exists.                                              |
| `CONSUMER_NOT_FOUND`              | No consumer with that id — also returned when another team owns it.                    |
| `CSRF_VALIDATION_FAILED`          | A session-authenticated mutation arrived without a matching X-CSRF-Token header.       |
| `DISCOVERY_ERROR`                 | Tool discovery against the backend returned nothing usable.                            |
| `EMPTY_BUNDLE`                    | The bundle has no tools, so no install link can be minted for it.                      |
| `EXAMPLE_NOT_FOUND`               | No saved example with that id for this tool.                                           |
| `FORBIDDEN`                       | The caller is authenticated but lacks the role this action requires.                   |
| `IMMUTABLE_ENTRY`                 | Built-in catalog entries cannot be edited or deleted at runtime.                       |
| `IMPORT_ERROR`                    | A config import failed to parse or apply; the message carries the reason.              |
| `INSTALL_LINK_NOT_FOUND`          | The install link does not exist, or has expired.                                       |
| `INTERNAL_ERROR`                  | An unhandled server-side failure; details are in the logs under this request id.       |
| `INVALID_ARGS`                    | A saved example's arguments do not match the tool's input schema.                      |
| `INVALID_CREDENTIALS`             | The username/password pair was rejected at login.                                      |
| `INVALID_CRON`                    | A schedule's cron expression could not be parsed.                                      |
| `INVALID_INTERVAL`                | A monitor's polling interval is outside the accepted range.                            |
| `INVALID_MODE`                    | An unrecognized canary mode was supplied.                                              |
| `INVALID_NAME`                    | A name field breaks the naming rules for its entity.                                   |
| `INVALID_SCHEMA`                  | A supplied JSON Schema is not a valid object schema.                                   |
| `INVALID_SESSION_ID`              | The Mcp-Session-Id header is not a UUID v4.                                            |
| `INVALID_SLUG`                    | A catalog slug does not match the required lowercase/dash format.                      |
| `INVALID_STEPS`                   | A composite tool's step list is empty or otherwise unusable.                           |
| `INVALID_STRATEGY`                | An unrecognized load-balancing strategy was supplied.                                  |
| `INVALID_TARGET`                  | A schedule or monitor names a target that does not fit its kind.                       |
| `INVALID_URL`                     | A supplied URL is malformed, uses a rejected scheme, or resolves to a blocked address. |
| `INVALID_WEIGHT`                  | A load-balancer or canary weight is outside the accepted range.                        |
| `JSON_TOO_DEEP`                   | The JSON body nests deeper than the configured limit (a parser-exhaustion guard).      |
| `LAST_ADMIN_PROTECTED`            | The change would leave the instance with no admin user, so it was refused.             |
| `LAST_SUPERADMIN_PROTECTED`       | The change would leave the instance with no teamless super-admin, so it was refused.   |
| `MCP_KEY_NOT_FOUND`               | No managed MCP API key with that id.                                                   |
| `NAME_COLLISION`                  | The name is already taken by a different kind of entity in the same namespace.         |
| `NOT_CONFIGURED`                  | The feature being addressed has no configuration on this client yet.                   |
| `NOT_FOUND`                       | Generic 404 for a resource with no more specific code.                                 |
| `NOT_PENDING`                     | The approval is no longer pending, so it can't be approved or rejected.                |
| `NOT_REST`                        | The operation only applies to REST clients, and this client is not one.                |
| `ORIGIN_NOT_ALLOWED`              | The browser Origin header is missing or is not in the configured allowlist.            |
| `POLICY_EXISTS`                   | A guard policy with that name already exists.                                          |
| `POLICY_NOT_FOUND`                | No guard policy by that name.                                                          |
| `RATE_LIMITED`                    | The caller exceeded a rate limit; retry after the interval in the response.            |
| `SCHEDULE_NOT_FOUND`              | No maintenance schedule with that id.                                                  |
| `SCHEMA_UNAVAILABLE`              | The backend's OpenAPI/GraphQL schema could not be fetched or parsed.                   |
| `SECRETS_PROVIDER_ERROR`          | The external secrets provider (e.g. Vault) rejected or could not serve the request.    |
| `SECRETS_PROVIDER_UNCONFIGURED`   | The operation needs an external secrets provider and none is configured.               |
| `SECRET_BOX_NOT_CONFIGURED`       | SECRET_ENCRYPTION_KEY is unset, so the gateway refuses to store or mint a secret.      |
| `SESSION_NOT_FOUND`               | No MCP session with that id.                                                           |
| `SNAPSHOT_NOT_FOUND`              | No config snapshot with that id.                                                       |
| `SSO_DISCOVERY_FAILED`            | The OIDC provider's discovery document could not be fetched.                           |
| `SSO_NOT_CONFIGURED`              | An SSO endpoint was called while OIDC is not configured.                               |
| `TARGET_NOT_FOUND`                | No load-balancer upstream target with that id.                                         |
| `TEAM_NOT_FOUND`                  | No team with that id.                                                                  |
| `TOOL_ALIAS_CONFLICT`             | The alias is already in use by another tool.                                           |
| `TOOL_ALIAS_INVALID`              | A tool alias breaks the alias naming rules.                                            |
| `TOOL_NOT_FOUND`                  | The client exists but exposes no tool by that name.                                    |
| `TOOL_NOT_LIVE`                   | The tool is catalogued but not currently live in the registry.                         |
| `TRACE_NOT_FOUND`                 | No trace with that id.                                                                 |
| `TRAFFIC_NOT_FOUND`               | No traffic record with that id.                                                        |
| `UNAUTHORIZED`                    | No valid credentials were presented, or the session has expired.                       |
| `UNKNOWN_TOOL`                    | A bundle or composite references a tool that does not exist.                           |
| `UPSTREAM_AUTH_VAULT_UNSUPPORTED` | This upstream-auth mode cannot be stored in the configured Vault provider.             |
| `USER_EXISTS`                     | An admin user with that username already exists.                                       |
| `USER_NOT_FOUND`                  | No admin user with that id.                                                            |
| `VALIDATION_ERROR`                | The request body or query string failed validation; the message names the field.       |
| `WS_PROXY_TARGET_NOT_FOUND`       | No WebSocket proxy target by that name.                                                |

The HTTP status is deliberately not listed: several codes are emitted at more than one status. `CLIENT_NOT_FOUND`, for instance, is the 404 for a client that does not exist **and** — by design — the identical 404 for one that belongs to another team, so a scoped caller cannot probe for its existence.
