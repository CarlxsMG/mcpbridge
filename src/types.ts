/** Canonical status values for a registered client. */
export type ClientStatus = "healthy" | "degraded" | "unreachable";

export interface RegistrationPayload {
  name: string;
  health_url: string;
  base_url?: string;
  // Manual mode
  tools?: RestToolDefinition[];
  // OpenAPI auto-discovery mode
  openapi_url?: string;
  include_tags?: string[];
  exclude_operations?: string[];
}

export interface RestToolDefinition {
  name: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  endpoint: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface RegisteredClient {
  name: string;
  ip: string;
  tools: RestToolDefinition[];
  health_url: string;
  base_url: string;
  resolved_ip: string;
  status: ClientStatus;
  consecutive_failures: number;
  /** When true, DELETE and PUT are retried on failure (same as GET/HEAD/OPTIONS). Default: false. */
  retry_non_safe_methods?: boolean;
}

export interface ResolvedTool {
  client: RegisteredClient;
  tool: RestToolDefinition;
}
