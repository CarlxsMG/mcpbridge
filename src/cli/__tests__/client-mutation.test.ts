/**
 * Stryker mutation-testing backstop for src/cli/client.ts — domain 10.
 *
 * No prior coverage existed anywhere for makeClient/clientExists/CliApiError/
 * saveCliCredentials/loadCliCredentials. This file is the ONLY test file for
 * client.ts.
 *
 * client.ts computes CONFIG_DIR/CONFIG_PATH once at module-load time from the
 * REAL `os.homedir()` — there is no injection point for an alternate HOME, so
 * rather than mocking `os`, this file mocks the `fs/promises` primitives
 * (`mkdir`/`readFile`/`writeFile`) themselves via `spyOn` on the module
 * namespace object, exactly as `src/routes/__tests__/routes-backup-mutation.test.ts`
 * already does for the same named-import-from-a-builtin pattern. This means
 * no test in this file ever touches the real user's home directory on disk.
 * CONFIG_DIR/CONFIG_PATH are recomputed here with the same real `homedir()`
 * call purely so assertions can match the exact literal strings/options
 * client.ts passes to fs — the value itself is never read from or written to.
 */
import { describe, test, expect, spyOn } from "bun:test";
import { homedir } from "os";
import { join } from "path";
import * as fsPromisesMod from "fs/promises";
import {
  saveCliCredentials,
  loadCliCredentials,
  makeClient,
  clientExists,
  CliApiError,
  type CliClient,
} from "../client.js";

const CONFIG_DIR = join(homedir(), ".mcpbridge");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const originalFetch = globalThis.fetch;

interface FetchCall {
  url: string;
  init: RequestInit;
}

/** Replaces globalThis.fetch with a recorder that always answers `response`. */
function stubFetch(response: Response): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response;
  }) as unknown as typeof fetch;
  return calls;
}

/** Mocks readFile to resolve with the given raw string (used to feed loadCliCredentials). */
function stubReadFile(resolveWith: string | Error): ReturnType<typeof spyOn> {
  const spy = spyOn(fsPromisesMod, "readFile");
  if (resolveWith instanceof Error) {
    spy.mockRejectedValue(resolveWith);
  } else {
    spy.mockResolvedValue(resolveWith);
  }
  return spy;
}

describe("saveCliCredentials", () => {
  test("creates the config dir (recursive) and writes 0600 JSON to the exact config path", async () => {
    const mkdirSpy = spyOn(fsPromisesMod, "mkdir").mockResolvedValue(undefined);
    const writeSpy = spyOn(fsPromisesMod, "writeFile").mockResolvedValue(undefined);
    try {
      await saveCliCredentials({ url: "http://gw.example.com", token: "tok-1" });

      expect(mkdirSpy).toHaveBeenCalledTimes(1);
      expect(mkdirSpy).toHaveBeenCalledWith(CONFIG_DIR, { recursive: true });

      expect(writeSpy).toHaveBeenCalledTimes(1);
      const [path, content, opts] = writeSpy.mock.calls[0] as [string, string, { mode: number }];
      expect(path).toBe(CONFIG_PATH);
      expect(JSON.parse(content)).toEqual({ url: "http://gw.example.com", token: "tok-1" });
      // Pretty-printed with a 2-space indent, not minified.
      expect(content).toContain("\n  ");
      expect(opts).toEqual({ mode: 0o600 });
    } finally {
      mkdirSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });
});

describe("loadCliCredentials", () => {
  test("returns the exact url/token when the config file holds valid credentials", async () => {
    const spy = stubReadFile(JSON.stringify({ url: "http://gw.example.com", token: "tok-xyz" }));
    try {
      const creds = await loadCliCredentials();
      expect(creds).toEqual({ url: "http://gw.example.com", token: "tok-xyz" });
      expect(spy).toHaveBeenCalledWith(CONFIG_PATH, "utf-8");
    } finally {
      spy.mockRestore();
    }
  });

  test("missing config file (readFile rejects) -> the exact 'not logged in' message", async () => {
    const spy = stubReadFile(new Error("ENOENT"));
    try {
      await expect(loadCliCredentials()).rejects.toThrow(
        `Not logged in — run "gateway login --url <gateway-url> --token <admin-api-key>" first.`,
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("url present but wrong type (a truthy number, not just absent) is rejected as corrupt", async () => {
    const spy = stubReadFile(JSON.stringify({ url: 12345, token: "tok-xyz" }));
    try {
      await expect(loadCliCredentials()).rejects.toThrow(
        `Corrupt credentials at ${CONFIG_PATH} — re-run "gateway login".`,
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("token present but wrong type (a truthy number) is rejected as corrupt — independent of the url clause", async () => {
    const spy = stubReadFile(JSON.stringify({ url: "http://gw.example.com", token: 999 }));
    try {
      await expect(loadCliCredentials()).rejects.toThrow(
        `Corrupt credentials at ${CONFIG_PATH} — re-run "gateway login".`,
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("both fields missing entirely is rejected as corrupt", async () => {
    const spy = stubReadFile(JSON.stringify({}));
    try {
      await expect(loadCliCredentials()).rejects.toThrow(
        `Corrupt credentials at ${CONFIG_PATH} — re-run "gateway login".`,
      );
    } finally {
      spy.mockRestore();
    }
  });
});

describe("CliApiError", () => {
  test("is a real Error carrying a numeric status alongside the message", () => {
    const err = new CliApiError(404, "not found");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CliApiError);
    expect(err.status).toBe(404);
    expect(err.message).toBe("not found");
  });
});

describe("makeClient / get / post (doFetch behavior)", () => {
  test("get(): strips ALL trailing slashes from the base url, hits base+path, default (GET) method, Bearer + JSON headers, returns parsed body", async () => {
    const readSpy = stubReadFile(JSON.stringify({ url: "http://gw.example.com///", token: "tok-abc123" }));
    const calls = stubFetch(new Response(JSON.stringify({ hello: "world" }), { status: 200 }));
    try {
      const client = await makeClient();
      const result = await client.get<{ hello: string }>("/admin-api/clients");

      expect(result).toEqual({ hello: "world" });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("http://gw.example.com/admin-api/clients");
      expect(calls[0]!.init.method).toBeUndefined();
      const headers = calls[0]!.init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer tok-abc123");
      expect(headers["Content-Type"]).toBe("application/json");
    } finally {
      readSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  test("get(): a url with no trailing slash is left untouched (identity — not over-stripped)", async () => {
    const readSpy = stubReadFile(JSON.stringify({ url: "http://gw.example.com", token: "tok-abc123" }));
    const calls = stubFetch(new Response("{}", { status: 200 }));
    try {
      const client = await makeClient();
      await client.get("/x");
      expect(calls[0]!.url).toBe("http://gw.example.com/x");
    } finally {
      readSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  test("post(): sends method POST with a JSON-stringified body and the same auth headers", async () => {
    const readSpy = stubReadFile(JSON.stringify({ url: "http://gw.example.com", token: "tok-def456" }));
    const calls = stubFetch(new Response(JSON.stringify({ created: true }), { status: 201 }));
    try {
      const client = await makeClient();
      const result = await client.post<{ created: boolean }>("/admin-api/clients", { name: "svc-a" });

      expect(result).toEqual({ created: true });
      expect(calls[0]!.init.method).toBe("POST");
      expect(calls[0]!.init.body).toBe(JSON.stringify({ name: "svc-a" }));
      const headers = calls[0]!.init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer tok-def456");
      expect(headers["Content-Type"]).toBe("application/json");
    } finally {
      readSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  test("an empty response body resolves to undefined, not a JSON.parse('') crash", async () => {
    const readSpy = stubReadFile(JSON.stringify({ url: "http://gw.example.com", token: "tok" }));
    stubFetch(new Response("", { status: 200 }));
    try {
      const client = await makeClient();
      const result = await client.get("/x");
      expect(result).toBeUndefined();
    } finally {
      readSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  test("non-ok response with a JSON error body throws CliApiError carrying that exact status + message", async () => {
    const readSpy = stubReadFile(JSON.stringify({ url: "http://gw.example.com", token: "tok" }));
    stubFetch(new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 }));
    try {
      const client = await makeClient();
      let caught: unknown;
      try {
        await client.get("/x");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(CliApiError);
      expect((caught as CliApiError).status).toBe(400);
      expect((caught as CliApiError).message).toBe("bad request");
    } finally {
      readSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  test("non-ok response with NO body at all falls back to `HTTP <status>` (proves the outer `body?.` optional chain, not a body.error crash)", async () => {
    const readSpy = stubReadFile(JSON.stringify({ url: "http://gw.example.com", token: "tok" }));
    stubFetch(new Response("", { status: 503 }));
    try {
      const client = await makeClient();
      await expect(client.get("/x")).rejects.toThrow("HTTP 503");
    } finally {
      readSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  test("non-ok response with a body but no `error` key falls back to `HTTP <status>` (the inner `error?.` optional chain)", async () => {
    const readSpy = stubReadFile(JSON.stringify({ url: "http://gw.example.com", token: "tok" }));
    stubFetch(new Response(JSON.stringify({}), { status: 502 }));
    try {
      const client = await makeClient();
      await expect(client.get("/x")).rejects.toThrow("HTTP 502");
    } finally {
      readSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  test("a non-JSON body (e.g. an HTML error page from a wrong --url/reverse proxy) throws a clean CliApiError instead of a bare JSON.parse SyntaxError", async () => {
    const readSpy = stubReadFile(JSON.stringify({ url: "http://gw.example.com", token: "tok" }));
    stubFetch(new Response("<html><body>502 Bad Gateway</body></html>", { status: 502 }));
    try {
      const client = await makeClient();
      let caught: unknown;
      try {
        await client.get("/x");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(CliApiError);
      expect(caught).not.toBeInstanceOf(SyntaxError);
      expect((caught as CliApiError).status).toBe(502);
      expect((caught as CliApiError).message).toContain("502 Bad Gateway");
    } finally {
      readSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  test("a non-JSON body on an OK (2xx) response also throws a CliApiError, not a bare JSON.parse SyntaxError", async () => {
    const readSpy = stubReadFile(JSON.stringify({ url: "http://gw.example.com", token: "tok" }));
    stubFetch(new Response("not json", { status: 200 }));
    try {
      const client = await makeClient();
      let caught: unknown;
      try {
        await client.get("/x");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(CliApiError);
      expect((caught as CliApiError).status).toBe(200);
      expect((caught as CliApiError).message).toBe("not json");
    } finally {
      readSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  test("an empty-string error message is preserved as-is — proves `??` (not `||`) is used for the fallback", async () => {
    const readSpy = stubReadFile(JSON.stringify({ url: "http://gw.example.com", token: "tok" }));
    stubFetch(new Response(JSON.stringify({ error: { message: "" } }), { status: 500 }));
    try {
      const client = await makeClient();
      let caught: unknown;
      try {
        await client.get("/x");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(CliApiError);
      // With `||` this would have been "HTTP 500"; with the real `??` it must
      // stay "" since "" is defined (not null/undefined).
      expect((caught as CliApiError).message).toBe("");
    } finally {
      readSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });
});

describe("clientExists", () => {
  function fakeClient(getImpl: (path: string) => Promise<unknown>): CliClient {
    return {
      get: getImpl as CliClient["get"],
      post: () => Promise.reject(new Error("post() not expected in clientExists tests")),
    };
  }

  test("resolving get() -> true, and the path is built with encodeURIComponent over the name", async () => {
    const calls: string[] = [];
    const client = fakeClient(async (path) => {
      calls.push(path);
      return { ok: true };
    });
    const exists = await clientExists(client, "foo bar/baz");
    expect(exists).toBe(true);
    expect(calls).toEqual([`/admin-api/clients/${encodeURIComponent("foo bar/baz")}`]);
    expect(calls[0]).toBe("/admin-api/clients/foo%20bar%2Fbaz");
  });

  test("a 404 CliApiError -> false (treated as 'absent', not rethrown)", async () => {
    const client = fakeClient(async () => {
      throw new CliApiError(404, "not found");
    });
    expect(await clientExists(client, "ghost")).toBe(false);
  });

  test("a non-404 CliApiError (e.g. 500) propagates rather than being treated as absent", async () => {
    const boom = new CliApiError(500, "server error");
    const client = fakeClient(async () => {
      throw boom;
    });
    await expect(clientExists(client, "svc")).rejects.toBe(boom);
  });

  test("a non-CliApiError error also propagates (the `instanceof CliApiError` clause is load-bearing on its own)", async () => {
    const boom = new Error("network down");
    const client = fakeClient(async () => {
      throw boom;
    });
    await expect(clientExists(client, "svc")).rejects.toBe(boom);
  });
});
