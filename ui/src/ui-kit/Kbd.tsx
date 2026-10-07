import { For, type JSX } from "solid-js";

export interface KbdProps {
  /** One chip per key, e.g. ["⌘", "⇧", "K"]. */
  keys?: string[];
  /** A single chip when `keys` is not given. */
  children?: JSX.Element;
  class?: string;
}

export function Kbd(props: KbdProps) {
  return (
    <span class={props.class ? `ui-kbd-group ${props.class}` : "ui-kbd-group"}>
      {props.keys ? <For each={props.keys}>{(k) => <kbd class="ui-kbd">{k}</kbd>}</For> : <kbd class="ui-kbd">{props.children}</kbd>}
    </span>
  );
}
