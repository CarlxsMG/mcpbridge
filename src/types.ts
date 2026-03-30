export interface RegistrationPayload {
  name: string;
  tools: RestToolDefinition[];
  health_url: string;
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
  status: "healthy" | "unreachable";
}

export interface ResolvedTool {
  client: RegisteredClient;
  tool: RestToolDefinition;
}
