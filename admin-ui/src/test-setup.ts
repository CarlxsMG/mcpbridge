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
