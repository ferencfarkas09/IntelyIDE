import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js";

export interface TitleBarProps {
  left?: JSX.Element;
  center?: JSX.Element;
  right?: JSX.Element;
  /** Reserve room for the macOS traffic lights (overlay title bar). Default true. */
  trafficLights?: boolean;
  class?: string;
}

/**
 * Unified overlay title bar. Only elements carrying data-tauri-drag-region
 * start a window drag, so interactive children stay clickable.
 */
export function TitleBar(props: TitleBarProps) {
  // In native full screen the traffic lights are gone and the webview covers the whole screen: close up the gap.
  const [fullscreen, setFullscreen] = createSignal(false);
  const measure = () => setFullscreen(window.innerWidth === screen.width && window.innerHeight === screen.height);
  onMount(() => {
    measure();
    window.addEventListener("resize", measure);
    onCleanup(() => window.removeEventListener("resize", measure));
  });
  return (
    <header class={props.class ? `ui-titlebar ${props.class}` : "ui-titlebar"} data-fullscreen={fullscreen() ? "" : undefined} data-tauri-drag-region>
      <Show when={props.trafficLights !== false}>
        <div class="ui-titlebar__spacer" data-tauri-drag-region />
      </Show>
      <div class="ui-titlebar__slot" data-slot="left" data-tauri-drag-region>
        {props.left}
      </div>
      <div class="ui-titlebar__slot" data-slot="center" data-tauri-drag-region>
        {props.center}
      </div>
      <div class="ui-titlebar__slot" data-slot="right" data-tauri-drag-region>
        {props.right}
      </div>
    </header>
  );
}
