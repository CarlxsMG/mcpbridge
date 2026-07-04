import { describe, test, expect, vi, afterEach } from "vitest";
import { downloadTextFile } from "../download";

describe("downloadTextFile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("creates an object URL, drives a temporary anchor click, then revokes the URL", () => {
    const createSpy = vi.spyOn(URL, "createObjectURL");
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL");
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    downloadTextFile("audit-log.json", '{"a":1}', "application/json");

    expect(createSpy).toHaveBeenCalledTimes(1);
    const blobArg = createSpy.mock.calls[0][0] as Blob;
    expect(blobArg).toBeInstanceOf(Blob);
    expect(blobArg.type).toBe("application/json");

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeSpy).toHaveBeenCalledTimes(1);
    expect(revokeSpy).toHaveBeenCalledWith(createSpy.mock.results[0].value);
  });

  test("sets the anchor's download attribute to the given filename", () => {
    vi.spyOn(URL, "createObjectURL");
    vi.spyOn(URL, "revokeObjectURL");
    let capturedDownload: string | undefined;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      capturedDownload = this.download;
    });

    downloadTextFile("mcp-bridge-config.yaml", "key: value", "application/yaml");

    expect(capturedDownload).toBe("mcp-bridge-config.yaml");
  });

  test("defaults the mime type to application/json when not given", () => {
    const createSpy = vi.spyOn(URL, "createObjectURL");
    vi.spyOn(URL, "revokeObjectURL");
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    downloadTextFile("plain.txt", "hello");

    const blobArg = createSpy.mock.calls[0][0] as Blob;
    expect(blobArg.type).toBe("application/json");
  });
});
