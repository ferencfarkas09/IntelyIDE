import { createEffect, createSignal, createUniqueId, on, onCleanup, Show, type JSX } from "solid-js";
import { createFloating } from "./floating";
import { tabbables } from "./focus";
import { OverlayPortal } from "./overlay";
import { muteTooltipFocus } from "./Tooltip";
import { createPresence } from "./presence";
import type { Placement } from "./position";

export interface PopoverTriggerProps {
  ref: (el: HTMLElement) => void;
  onClick: (e: MouseEvent) => void;
  onKeyDown: (e: KeyboardEvent) => void;
  "aria-haspopup": "dialog" | "menu";
  "aria-expanded": boolean;
  "aria-controls": string | undefined;
}

export interface PopoverApi {
  close: () => void;
  /** True when it was opened from the keyboard (menus focus their first item then). */
  viaKeyboard: () => boolean;
}

export interface PopoverProps {
  trigger: (props: PopoverTriggerProps) => JSX.Element;
  children: JSX.Element | ((api: PopoverApi) => JSX.Element);
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  placement?: Placement;
  gap?: number;
  matchWidth?: boolean;
  /** "menu" gives the panel menu semantics and arrow-key opening on the trigger. */
  kind?: "dialog" | "menu";
  "aria-label"?: string;
  class?: string;
}

/** Anchored, dismissible panel. Esc / outside press close it and focus returns to the trigger. */
export function Popover(props: PopoverProps) {
  const id = createUniqueId();
  const [inner, setInner] = createSignal(false);
  const [trigger, setTrigger] = createSignal<HTMLElement>();
  const [viaKeyboard, setViaKeyboard] = createSignal(false);
  const open = () => props.open ?? inner();
  const setOpen = (v: boolean) => {
    if (props.open === undefined) setInner(v);
    props.onOpenChange?.(v);
  };
  const { mounted, state } = createPresence(open, 110);
  const floating = createFloating({ anchor: trigger, open: mounted, placement: () => props.placement ?? "bottom-start", gap: props.gap ?? 6, matchWidth: props.matchWidth });
  let panel: HTMLDivElement | undefined;
  const close = () => setOpen(false);
  const kind = () => props.kind ?? "dialog";

  createEffect(
    on(open, (isOpen) => {
      if (!isOpen) return;
      const onDown = (e: PointerEvent) => {
        const t = e.target as Node;
        if (!panel?.contains(t) && !trigger()?.contains(t)) close();
      };
      const onFocusIn = (e: FocusEvent) => {
        const t = e.target as Node;
        if (panel && !panel.contains(t) && !trigger()?.contains(t)) close();
      };
      document.addEventListener("pointerdown", onDown, true);
      document.addEventListener("focusin", onFocusIn);
      queueMicrotask(() => {
        if (!panel || kind() === "menu") return;
        (tabbables(panel)[0] ?? panel).focus();
      });
      onCleanup(() => {
        document.removeEventListener("pointerdown", onDown, true);
        document.removeEventListener("focusin", onFocusIn);
        // Return focus only if it was inside the popover (an outside click moved it on purpose).
        if (!document.activeElement || document.activeElement === document.body || panel?.contains(document.activeElement)) {
          muteTooltipFocus();
          trigger()?.focus();
        }
      });
    }),
  );

  const triggerProps: PopoverTriggerProps = {
    ref: setTrigger,
    onClick: (e) => {
      setViaKeyboard(e.detail === 0);
      setOpen(!open());
    },
    onKeyDown: (e) => {
      if (kind() === "menu" && (e.key === "ArrowDown" || e.key === "ArrowUp") && !open()) {
        e.preventDefault();
        setViaKeyboard(true);
        setOpen(true);
      }
    },
    get "aria-haspopup"() {
      return kind();
    },
    get "aria-expanded"() {
      return open();
    },
    get "aria-controls"() {
      return mounted() ? id : undefined;
    },
  };

  return (
    <>
      {props.trigger(triggerProps)}
      <Show when={mounted()}>
        <OverlayPortal anchor={trigger}>
          <div
            ref={(el) => {
              panel = el;
              floating.ref(el);
            }}
            id={id}
            class={props.class ? `ui-popover ${props.class}` : "ui-popover"}
            data-kind={kind()}
            data-state={state()}
            data-placement={floating.placement()}
            role={kind() === "menu" ? "menu" : "dialog"}
            aria-label={props["aria-label"]}
            tabIndex={-1}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                close();
              }
            }}
          >
            {typeof props.children === "function" ? props.children({ close, viaKeyboard }) : props.children}
          </div>
        </OverlayPortal>
      </Show>
    </>
  );
}
