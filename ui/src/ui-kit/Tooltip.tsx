import { createSignal, createUniqueId, onCleanup, Show, type JSX } from "solid-js";
import { createFloating } from "./floating";
import { Kbd } from "./Kbd";
import { OverlayPortal } from "./overlay";
import { createPresence } from "./presence";
import type { Placement } from "./position";

export interface TooltipProps {
  label: JSX.Element;
  /** Shortcut chips shown after the label, e.g. ["⌘", "⇧", "K"]. */
  shortcut?: string[];
  placement?: Placement;
  /** Hover delay in ms; skipped when another tooltip just closed. */
  delay?: number;
  disabled?: boolean;
  /** Exactly one element. Its focus and hover trigger the tooltip. */
  children: JSX.Element;
}

let lastClosedAt = 0;
const GRACE_MS = 350;
let mutedUntil = 0;

/** Keeps tooltips from opening on focus for a moment, e.g. while a closing popover hands focus back to its trigger. */
export function muteTooltipFocus(ms = 200): void {
  mutedUntil = Date.now() + ms;
}

export function Tooltip(props: TooltipProps) {
  const id = createUniqueId();
  const [anchor, setAnchor] = createSignal<HTMLElement>();
  const [open, setOpen] = createSignal(false);
  const { mounted, state } = createPresence(open, 90);
  const floating = createFloating({ anchor, open: mounted, placement: () => props.placement ?? "top", gap: 6 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wrapper!: HTMLSpanElement;

  const target = () => wrapper.firstElementChild as HTMLElement | null;
  const show = (immediate: boolean) => {
    if (props.disabled) return;
    clearTimeout(timer);
    const wait = immediate || Date.now() - lastClosedAt < GRACE_MS ? 0 : (props.delay ?? 450);
    timer = setTimeout(() => {
      const t = target();
      if (!t) return;
      setAnchor(t);
      t.setAttribute("aria-describedby", id);
      setOpen(true);
    }, wait);
  };
  const hide = () => {
    clearTimeout(timer);
    if (open()) lastClosedAt = Date.now();
    target()?.removeAttribute("aria-describedby");
    setOpen(false);
  };
  onCleanup(() => clearTimeout(timer));

  const leaving = (e: PointerEvent | FocusEvent) => !(e.relatedTarget instanceof Node && wrapper.contains(e.relatedTarget));

  return (
    <>
      <span
        ref={wrapper}
        class="ui-tooltip-anchor"
        onPointerOver={(e) => {
          if (e.pointerType === "mouse" && !(e.relatedTarget instanceof Node && wrapper.contains(e.relatedTarget))) show(false);
        }}
        onPointerOut={(e) => leaving(e) && hide()}
        onPointerDown={hide}
        onFocusIn={(e) => e.target instanceof HTMLElement && e.target.matches(":focus-visible") && Date.now() > mutedUntil && show(true)}
        onFocusOut={(e) => leaving(e) && hide()}
        onKeyDown={(e) => e.key === "Escape" && open() && hide()}
      >
        {props.children}
      </span>
      <Show when={mounted()}>
        <OverlayPortal anchor={anchor}>
          <div ref={floating.ref} id={id} role="tooltip" class="ui-tooltip" data-state={state()} data-placement={floating.placement()}>
            <span class="ui-tooltip__label">{props.label}</span>
            <Show when={props.shortcut?.length}>
              <Kbd keys={props.shortcut} />
            </Show>
          </div>
        </OverlayPortal>
      </Show>
    </>
  );
}
