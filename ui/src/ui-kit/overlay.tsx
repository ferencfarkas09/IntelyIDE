import { createSignal, onMount, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";

/** Overlays mount inside the nearest themed ancestor so tokens (and the gallery's per-theme scopes) apply. */
export function overlayMount(from: Element | null | undefined): HTMLElement {
  const scope = from?.closest<HTMLElement>("[data-theme]");
  return scope && scope !== document.documentElement ? scope : document.body;
}

export function OverlayPortal(props: { anchor?: () => Element | null | undefined; children: JSX.Element }) {
  let marker!: HTMLSpanElement;
  const [mount, setMount] = createSignal<HTMLElement>();
  onMount(() => setMount(overlayMount(props.anchor?.() ?? marker)));
  return (
    <>
      <span hidden ref={marker} />
      <Show when={mount()}>{(m) => <Portal mount={m()}>{props.children}</Portal>}</Show>
    </>
  );
}
