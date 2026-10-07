/** jsdom has no layout and no ResizeObserver: give viewports a size so the virtualiser renders rows. Test-only. */
export function installLayoutStubs(): void {
  class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 900 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 400 });
  Element.prototype.scrollIntoView = () => {};
}
