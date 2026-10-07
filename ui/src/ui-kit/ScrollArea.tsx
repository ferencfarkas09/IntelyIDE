import { createSignal, onMount, onCleanup, type JSX } from "solid-js";

export interface ScrollAreaProps {
  orientation?: "vertical" | "horizontal" | "both";
  /** Hairline + soft shadow at the edges that have more content. Default on. */
  edges?: boolean;
  /** The scrolling element, for virtualisers and scroll-to. */
  ref?: (el: HTMLDivElement) => void;
  onScroll?: (e: Event) => void;
  class?: string;
  viewportClass?: string;
  tabIndex?: number;
  role?: JSX.HTMLAttributes<HTMLDivElement>["role"];
  "aria-label"?: string;
  /** `off` keeps a `log` role from announcing every mutation of a streaming list. */
  "aria-live"?: "off" | "polite" | "assertive";
  children?: JSX.Element;
}

export function ScrollArea(props: ScrollAreaProps) {
  let viewport!: HTMLDivElement;
  const [edge, setEdge] = createSignal({ top: false, bottom: false });
  const update = () => {
    const top = viewport.scrollTop > 1;
    const bottom = viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - 1;
    setEdge((e) => (e.top === top && e.bottom === bottom ? e : { top, bottom }));
  };
  onMount(() => {
    update();
    const ro = new ResizeObserver(update);
    ro.observe(viewport);
    if (viewport.firstElementChild) ro.observe(viewport.firstElementChild);
    onCleanup(() => ro.disconnect());
  });
  return (
    <div class={props.class ? `ui-scroll ${props.class}` : "ui-scroll"} data-orientation={props.orientation ?? "vertical"} data-edges={props.edges === false ? undefined : ""}>
      <div
        ref={(el) => {
          viewport = el;
          props.ref?.(el);
        }}
        class={props.viewportClass ? `ui-scroll__viewport ${props.viewportClass}` : "ui-scroll__viewport"}
        tabIndex={props.tabIndex}
        role={props.role}
        aria-label={props["aria-label"]}
        aria-live={props["aria-live"]}
        onScroll={(e) => {
          update();
          props.onScroll?.(e);
        }}
      >
        {props.children}
      </div>
      <span class="ui-scroll__edge" data-side="top" data-on={edge().top ? "" : undefined} aria-hidden="true" />
      <span class="ui-scroll__edge" data-side="bottom" data-on={edge().bottom ? "" : undefined} aria-hidden="true" />
    </div>
  );
}
