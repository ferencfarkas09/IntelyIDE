import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Keeps an element mounted for `exitMs` after `open` turns false so a CSS exit
 * animation can play. `state` drives `data-state` on the element.
 */
export function createPresence(open: Accessor<boolean>, exitMs = 120) {
  const [mounted, setMounted] = createSignal(open());
  const [state, setState] = createSignal<"open" | "closed">(open() ? "open" : "closed");
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    clearTimeout(timer);
    if (open()) {
      setMounted(true);
      setState("open");
    } else if (mounted()) {
      setState("closed");
      timer = setTimeout(() => setMounted(false), prefersReducedMotion() ? 0 : exitMs);
    }
  });
  onCleanup(() => clearTimeout(timer));
  return { mounted, state };
}
