import { createComponent, lazy as solidLazy, type Component, type ComponentProps } from "solid-js";

/**
 * Solid's `lazy`, but the loaded component is kept for good.
 *
 * Solid forgets it as soon as the instance that first asked for it is disposed (`onCleanup(() => comp = undefined)` inside its
 * `lazy`), and the next instance then suspends again. In a virtual list that is every other scroll step: the row that loaded the
 * component leaves the window, the next row suspends, and the nearest `<Suspense>` swaps its whole panel for the spinner. The
 * panel comes back as a new scroller at the top, which is the "scrolling keeps jumping back" bug. A component that is already
 * loaded renders at once here, whatever happened to the instances before it.
 *
 * Use it wherever a lazy component can be mounted more than once (rows, badges, cards). The first load still suspends, so put a
 * `<Suspense>` of its own around a lazy component that sits inside a scrolling list.
 */
export function lazy<T extends Component<any>>(load: () => Promise<{ default: T }>): Component<ComponentProps<T>> {
  let loaded: T | undefined;
  const pending = solidLazy(() =>
    load().then((module) => {
      loaded = module.default;
      return module;
    }),
  );
  return (props) => (loaded ? createComponent(loaded, props) : pending(props));
}
