import { createEffect, createSignal, onCleanup, Show, type JSX } from "solid-js";

export interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: JSX.Element;
}

/** Mobile sheet: slides up from the bottom, closes on the backdrop, Esc or a downward drag of the handle. Safe-area aware. */
export function BottomSheet(props: BottomSheetProps) {
  const [drag, setDrag] = createSignal(0);
  let startY = 0;
  let panel: HTMLDivElement | undefined;

  createEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    document.addEventListener("keydown", onKey);
    queueMicrotask(() => panel?.focus());
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

  const down = (e: PointerEvent) => {
    startY = e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    if (startY) setDrag(Math.max(0, e.clientY - startY));
  };
  const up = () => {
    const dy = drag();
    startY = 0;
    setDrag(0);
    if (dy > 90) props.onClose();
  };

  return (
    <Show when={props.open}>
      <div class="sheet-backdrop" onClick={() => props.onClose()}>
        <div ref={panel} class="sheet" role="dialog" aria-modal="true" aria-label={props.title} tabindex="-1" style={{ transform: drag() ? `translateY(${drag()}px)` : undefined }} onClick={(e) => e.stopPropagation()}>
          <div class="sheet__grab" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
            <span />
          </div>
          <h2 class="sheet__title">{props.title}</h2>
          <div class="sheet__body">{props.children}</div>
        </div>
      </div>
    </Show>
  );
}
