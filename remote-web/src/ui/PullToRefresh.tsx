import { createSignal, type JSX } from "solid-js";
import { Icon } from "@ui/ui-kit/Icon";
import { RefreshCw } from "@ui/ui-kit/icons";

export const PULL_THRESHOLD = 72;

/** Distance the indicator follows the finger (rubber band). */
export const pullDistance = (dy: number): number => Math.min(110, dy * 0.5);
export const shouldRefresh = (dy: number): boolean => pullDistance(dy) >= PULL_THRESHOLD * 0.5 + 8;

/** A scroll container with pull-to-refresh from the top. Touch only; there is also a visible Refresh action in the header. */
export function PullToRefresh(props: { onRefresh: () => void | Promise<void>; children: JSX.Element; class?: string }) {
  const [pull, setPull] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  let startY = 0;
  let el: HTMLDivElement | undefined;

  return (
    <div
      ref={el}
      class={`scroller ${props.class ?? ""}`}
      onTouchStart={(e) => {
        startY = el && el.scrollTop <= 0 ? e.touches[0]!.clientY : 0;
      }}
      onTouchMove={(e) => {
        if (!startY || busy()) return;
        const dy = e.touches[0]!.clientY - startY;
        if (dy > 0) setPull(pullDistance(dy));
      }}
      onTouchEnd={async () => {
        const go = startY !== 0 && pull() >= PULL_THRESHOLD * 0.5 + 8;
        startY = 0;
        if (go) {
          setBusy(true);
          setPull(40);
          try {
            await props.onRefresh();
          } finally {
            await new Promise((r) => setTimeout(r, 400));
            setBusy(false);
          }
        }
        setPull(0);
      }}
    >
      <div class="ptr" data-busy={busy() ? "" : undefined} style={{ height: `${pull()}px` }} aria-hidden="true">
        <Icon icon={RefreshCw} size={16} />
      </div>
      {props.children}
    </div>
  );
}
