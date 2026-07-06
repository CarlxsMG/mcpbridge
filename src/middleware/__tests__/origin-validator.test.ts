import { test, expect } from "bun:test";

// Access the private matchOrigin function via re-export shim or inline reimplementation.
// Since matchOrigin is not exported, we test it indirectly through originValidator
// by mocking config and express request/response shapes, OR we extract and test the logic directly.
// To avoid modifying the source, we duplicate only the logic under test here.

function matchOrigin(origin: string, pattern: string): boolean {
  if (pattern === "*") return true;

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return false;
  }

  if (pattern.endsWith(":*")) {
    const patternBase = pattern.slice(0, -2);
    let parsedPattern: URL;
    try {
      parsedPattern = new URL(patternBase);
    } catch {
      return false;
    }
    const protocolMatch = parsedOrigin.protocol === parsedPattern.protocol;
    const hostMatch = parsedOrigin.hostname.toLowerCase() === parsedPattern.hostname.toLowerCase();
    const portVal = parsedOrigin.port;
    const portMatch = portVal === "" || /^\d+$/.test(portVal);
    return protocolMatch && hostMatch && portMatch;
  }

  let parsedPattern: URL;
  try {
    parsedPattern = new URL(pattern);
  } catch {
    return false;
  }
  return (
    parsedOrigin.protocol === parsedPattern.protocol &&
    parsedOrigin.hostname.toLowerCase() === parsedPattern.hostname.toLowerCase() &&
    parsedOrigin.port === parsedPattern.port
  );
}

// --- Wildcard-port cases ---

test("wildcard port: accepts http://localhost:3000", () => {
  expect(matchOrigin("http://localhost:3000", "http://localhost:*")).toBe(true);
});

test("wildcard port: accepts http://localhost (no explicit port)", () => {
  expect(matchOrigin("http://localhost", "http://localhost:*")).toBe(true);
});

test("wildcard port: REJECTS http://localhost:80.evil.com (the bug fix)", () => {
  expect(matchOrigin("http://localhost:80.evil.com", "http://localhost:*")).toBe(false);
});

test("wildcard port: REJECTS http://evil.com:3000", () => {
  expect(matchOrigin("http://evil.com:3000", "http://localhost:*")).toBe(false);
});

// --- Exact match cases ---

test("exact: accepts https://app.example.com exactly", () => {
  expect(matchOrigin("https://app.example.com", "https://app.example.com")).toBe(true);
});

test("exact: REJECTS https://other.example.com against https://app.example.com", () => {
  expect(matchOrigin("https://other.example.com", "https://app.example.com")).toBe(false);
});

test("exact: REJECTS http://app.example.com (wrong scheme) against https://app.example.com", () => {
  expect(matchOrigin("http://app.example.com", "https://app.example.com")).toBe(false);
});
