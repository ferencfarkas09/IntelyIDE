import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import { computePosition, type Placement } from "./position";

export interface FloatingOptions {
  anchor: Accessor<Element | undefined | null>;
  open: Accessor<boolean>;
  placement: Accessor<Placement>;
  gap?: number;
  /** Give the floating element at least the anchor's width (menus, selects). */
  matchWidth?: boolean;
}

/** Positions a `position: fixed` element next to an anchor and keeps it there on scroll/resize. */
export function createFloating(opts: FloatingOptions) {
  const [el, setEl] = createSignal<HTMLElement>();
  const [actual, setActual] = createSignal<Placement>("bottom");
  createEffect(() => {
    const f = el();
    const a = opts.anchor();
    if (!f || !a || !opts.open()) return;
    const update = () => {
      const r = a.getBoundingClientRect();
      if (opts.matchWidth) f.style.minWidth = `${Math.round(r.width)}px`;
      const pos = computePosition(
        { left: r.left, top: r.top, width: r.width, height: r.height },
        { width: f.offsetWidth, height: f.offsetHeight },
        opts.placement(),
        opts.gap ?? 6,
        { width: window.innerWidth, height: window.innerHeight },
      );
      f.style.left = `${pos.x}px`;
      f.style.top = `${pos.y}px`;
      setActual(pos.placement);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(f);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    onCleanup(() => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    });
  });
  return { ref: setEl, placement: actual };
}
