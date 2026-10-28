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
  // virtual-core 3.19 measures a viewport with clientWidth/clientHeight instead of offsetWidth/offsetHeight.
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 900 });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 400 });
  Element.prototype.scrollIntoView = () => {};
}
