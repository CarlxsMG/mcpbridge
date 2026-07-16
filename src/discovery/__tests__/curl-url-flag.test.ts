/**
 * Regression for Finding #13: `curl --url <URL>` failed to import because --url
 * was treated as an unknown value-taking flag, so the catch-all skip consumed
 * the URL token itself. --url (and the --url=<URL> long-option form) now supply
 * the request URL.
 */
import { describe, test, expect } from "bun:test";
import { parseCurlCommand } from "../../discovery/curl-postman-discovery.js";

describe("parseCurlCommand — --url flag", () => {
  test("curl --url <URL> imports with the correct endpoint", () => {
    const tools = parseCurlCommand("curl --url https://api.example.com/things");
    expect(tools).toHaveLength(1);
    expect(tools[0]!.endpoint).toBe("/things");
    expect(tools[0]!.method).toBe("GET");
  });

  test("curl --url=<URL> long-option form imports with the correct endpoint", () => {
    const tools = parseCurlCommand("curl --url=https://api.example.com/widgets");
    expect(tools).toHaveLength(1);
    expect(tools[0]!.endpoint).toBe("/widgets");
  });

  test("--url alongside -X POST keeps both the method and the URL", () => {
    const tools = parseCurlCommand("curl -X POST --url https://api.example.com/orders");
    expect(tools).toHaveLength(1);
    expect(tools[0]!.method).toBe("POST");
    expect(tools[0]!.endpoint).toBe("/orders");
  });
});
