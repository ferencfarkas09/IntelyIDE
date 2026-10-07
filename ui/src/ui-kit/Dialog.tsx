import { t } from "../i18n";
import { createEffect, createUniqueId, on, onCleanup, Show, type JSX } from "solid-js";
import { tabbables, trapTab } from "./focus";
import { X } from "./icons";
import { IconButton } from "./IconButton";
import { OverlayPortal } from "./overlay";
import { createPresence } from "./presence";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: JSX.Element;
  description?: JSX.Element;
  size?: "sm" | "md" | "lg" | "xl";
  /** Action row; right-aligned. */
  footer?: JSX.Element;
  /** Element to focus first. Defaults to [data-autofocus], then the first tabbable. */
  initialFocus?: () => HTMLElement | null | undefined;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  /** Use for confirmations that need an explicit answer. */
  role?: "dialog" | "alertdialog";
  hideClose?: boolean;
  class?: string;
  children?: JSX.Element;
}

const stack: symbol[] = [];

export function Dialog(props: DialogProps) {
  const { mounted, state } = createPresence(() => props.open, 140);
  const titleId = createUniqueId();
  const descId = createUniqueId();
  const token = Symbol("dialog");
  let panel: HTMLDivElement | undefined;
  let returnFocus: HTMLElement | null = null;
  let downOnBackdrop = false;

  const onDocKey = (e: KeyboardEvent) => {
    // A popover inside the dialog (menu, editor) handles Escape first and marks the event; the dialog closes on the next one.
    if (e.key === "Escape" && !e.defaultPrevented && props.closeOnEscape !== false && stack[stack.length - 1] === token) {
      e.stopPropagation();
      props.onClose();
    }
  };

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        stack.push(token);
        document.addEventListener("keydown", onDocKey);
        // Wait for the portal to render before moving focus.
        queueMicrotask(() => {
          if (!panel) return;
          (props.initialFocus?.() ?? panel.querySelector<HTMLElement>("[data-autofocus]") ?? tabbables(panel).find((el) => !el.hasAttribute("data-dialog-close")) ?? panel).focus();
        });
        onCleanup(() => {
          document.removeEventListener("keydown", onDocKey);
          const i = stack.indexOf(token);
          if (i >= 0) stack.splice(i, 1);
          if (returnFocus?.isConnected) returnFocus.focus();
        });
      },
    ),
  );

  return (
    <Show when={mounted()}>
      <OverlayPortal>
        <div
          class="ui-dialog-backdrop"
          data-state={state()}
          onPointerDown={(e) => (downOnBackdrop = e.target === e.currentTarget)}
          onClick={(e) => {
            if (downOnBackdrop && e.target === e.currentTarget && props.closeOnBackdrop !== false) props.onClose();
            downOnBackdrop = false;
          }}
        >
          <div
            ref={panel}
            class={props.class ? `ui-dialog ${props.class}` : "ui-dialog"}
            data-size={props.size ?? "md"}
            data-state={state()}
            role={props.role ?? "dialog"}
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={props.description ? descId : undefined}
            tabIndex={-1}
            onKeyDown={(e) => panel && trapTab(e, panel)}
          >
            <header class="ui-dialog__header">
              <h2 class="ui-dialog__title" id={titleId}>
                {props.title}
              </h2>
              <Show when={!props.hideClose}>
                <IconButton icon={X} label={t("kit.close")} shortcut={["Esc"]} size="sm" data-dialog-close onClick={props.onClose} />
              </Show>
            </header>
            <Show when={props.description}>
              <p class="ui-dialog__desc" id={descId}>
                {props.description}
              </p>
            </Show>
            <div class="ui-dialog__body">{props.children}</div>
            <Show when={props.footer}>
              <footer class="ui-dialog__footer">{props.footer}</footer>
            </Show>
          </div>
        </div>
      </OverlayPortal>
    </Show>
  );
}
