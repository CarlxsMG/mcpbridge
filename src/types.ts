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
  status: "healthy" | "unreachable";
}

export interface ResolvedTool {
  client: RegisteredClient;
  tool: RestToolDefinition;
}
