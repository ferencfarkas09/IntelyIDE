/**
 * Calls `use(el)` once `el` is in the document. A virtualiser measures the element it is given: one that is not connected yet
 * (a panel mounted again after a rail switch is inserted a moment after its refs run) reports a 0x0 box and no row ever appears.
 * Gives up quietly after about 650 ms (the element was never inserted).
 */
export function whenConnected<T extends Element>(el: T, use: (el: T) => void, tries = 40): void {
  queueMicrotask(() => {
    if (el.isConnected) use(el);
    else if (tries > 0) setTimeout(() => whenConnected(el, use, tries - 1), 16);
  });
}
