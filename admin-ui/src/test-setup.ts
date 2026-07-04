// Test-only environment shims. jsdom doesn't implement ResizeObserver, but
// TimeSeriesChart uses one to track its container width — stub it so mounting
// the component in tests doesn't throw "ResizeObserver is not defined".
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

// jsdom implements Blob but not URL.createObjectURL/revokeObjectURL (throws
// "Not implemented"), which utils/download.ts relies on — stub with an
// in-memory blob: URL registry so tests can call the real download code path.
if (typeof URL.createObjectURL === "undefined") {
  const objectUrls = new Map<string, Blob>();
  let nextId = 0;
  URL.createObjectURL = ((blob: Blob) => {
    const url = `blob:mock/${nextId++}`;
    objectUrls.set(url, blob);
    return url;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => {
    objectUrls.delete(url);
  }) as typeof URL.revokeObjectURL;
}
