import { registry } from "./registry.js";

export async function proxyToolCall(
  mcpToolName: string,
  args: Record<string, unknown> = {}
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const resolved = registry.resolveTool(mcpToolName);

  if (resolved === undefined) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${mcpToolName}` }],
      isError: true,
    };
  }

  const { client, tool } = resolved;

  if (client.status === "unreachable") {
    return {
      content: [{ type: "text", text: `Client '${client.name}' is unreachable` }],
      isError: true,
    };
  }

  // Build URL with path param substitution
  const remainingArgs = { ...args };
  const resolvedPath = tool.endpoint.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, paramName) => {
    const value = remainingArgs[paramName];
    if (value !== undefined) {
      delete remainingArgs[paramName];
      return encodeURIComponent(String(value));
    }
    return `:${paramName}`;
  });

  let url = `http://${client.ip}${resolvedPath}`;

  const method = tool.method.toUpperCase();
  let body: string | undefined;
  let fetchOptions: RequestInit;

  if (method === "GET" || method === "DELETE") {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(remainingArgs)) {
      params.append(key, String(value));
    }
    const queryString = params.toString();
    if (queryString) {
      url = `${url}?${queryString}`;
    }
    fetchOptions = {
      method,
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000),
    };
  } else {
    body = JSON.stringify(remainingArgs);
    fetchOptions = {
      method,
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(30_000),
    };
  }

  try {
    const response = await fetch(url, fetchOptions);

    if (response.ok) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(await response.json(), null, 2),
          },
        ],
      };
    } else {
      return {
        content: [
          {
            type: "text",
            text: `REST API returned ${response.status}: ${await response.text()}`,
          },
        ],
        isError: true,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: `Failed to reach ${client.name}: ${message}`,
        },
      ],
      isError: true,
    };
  }
}
