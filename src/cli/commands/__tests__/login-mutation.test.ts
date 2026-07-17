import { describe, test, expect, spyOn } from "bun:test";
import { loginCommand, USAGE as LOGIN_USAGE } from "../login.js";
import * as clientMod from "../../client.js";

describe("loginCommand — help", () => {
  test("--help prints usage to stdout, returns 0, and never saves credentials", async () => {
    const saveSpy = spyOn(clientMod, "saveCliCredentials").mockResolvedValue(undefined);
    const logSpy = spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const code = await loginCommand(["--help"]);

      expect(code).toBe(0);
      expect(saveSpy).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls[0]![0]).toBe(LOGIN_USAGE);
    } finally {
      saveSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  // `-h` is left as a positional by parseFlags (single dash), so this proves
  // help detection scans the raw argv rather than relying on flags.help.
  test("-h behaves the same as --help", async () => {
    const saveSpy = spyOn(clientMod, "saveCliCredentials").mockResolvedValue(undefined);
    const logSpy = spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const code = await loginCommand(["-h"]);

      expect(code).toBe(0);
      expect(saveSpy).not.toHaveBeenCalled();
      expect(logSpy.mock.calls[0]![0]).toBe(LOGIN_USAGE);
    } finally {
      saveSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

describe("loginCommand", () => {
  test("valid --url and --token saves credentials and returns 0", async () => {
    const saveSpy = spyOn(clientMod, "saveCliCredentials").mockResolvedValue(undefined);
    const logSpy = spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const code = await loginCommand(["--url", "https://gw.example.com", "--token", "abc123"]);

      expect(code).toBe(0);
      expect(saveSpy).toHaveBeenCalledTimes(1);
      // Exact object shape — kills an ObjectLiteral mutant that would pass `{}`
      // instead of the real `{ url, token }` pair.
      expect(saveSpy.mock.calls[0]![0]).toEqual({ url: "https://gw.example.com", token: "abc123" });
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls[0]![0]).toBe("Logged in to https://gw.example.com");
    } finally {
      saveSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  test("missing --url (token present) prints the usage message, returns 1, never saves", async () => {
    const saveSpy = spyOn(clientMod, "saveCliCredentials").mockResolvedValue(undefined);
    const errSpy = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const code = await loginCommand(["--token", "abc123"]);

      expect(code).toBe(1);
      expect(saveSpy).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(errSpy.mock.calls[0]![0]).toBe("Usage: gateway login --url <gateway-url> --token <admin-api-key>");
    } finally {
      saveSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  test("missing --token (url present) prints the usage message, returns 1, never saves", async () => {
    const saveSpy = spyOn(clientMod, "saveCliCredentials").mockResolvedValue(undefined);
    const errSpy = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const code = await loginCommand(["--url", "https://gw.example.com"]);

      expect(code).toBe(1);
      expect(saveSpy).not.toHaveBeenCalled();
    } finally {
      saveSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  test("no flags at all: both missing, returns 1, never saves", async () => {
    const saveSpy = spyOn(clientMod, "saveCliCredentials").mockResolvedValue(undefined);
    const errSpy = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const code = await loginCommand([]);

      expect(code).toBe(1);
      expect(saveSpy).not.toHaveBeenCalled();
    } finally {
      saveSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  // `--url` as the very last token with nothing after it is parsed by
  // parseFlags as the boolean `true` (truthy, but not a string) rather than
  // absent — distinct from "undefined". The `typeof flags.url === "string"`
  // guard must reject this, not just an absent flag.
  test("--url given as a bare boolean flag (truthy, non-string) is treated as invalid", async () => {
    const saveSpy = spyOn(clientMod, "saveCliCredentials").mockResolvedValue(undefined);
    const errSpy = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const code = await loginCommand(["--token", "abc123", "--url"]);

      expect(code).toBe(1);
      expect(saveSpy).not.toHaveBeenCalled();
    } finally {
      saveSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  // Same as above but for `--token`, with a genuinely valid `--url` alongside
  // it — isolates the token guard specifically.
  test("--token given as a bare boolean flag (truthy, non-string) is treated as invalid", async () => {
    const saveSpy = spyOn(clientMod, "saveCliCredentials").mockResolvedValue(undefined);
    const errSpy = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const code = await loginCommand(["--url", "https://gw.example.com", "--token"]);

      expect(code).toBe(1);
      expect(saveSpy).not.toHaveBeenCalled();
    } finally {
      saveSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
