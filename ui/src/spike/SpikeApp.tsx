import { Show } from "solid-js";
import { Empty } from "./modes/Empty";
import { Rich } from "./modes/Rich";

export function SpikeApp(props: { mode: "empty" | "rich" }) {
  return (
    <div class="shell">
      <header class="titlebar">IntelySwitchIDE - {props.mode}</header>
      <Show when={props.mode === "rich"} fallback={<Empty />}>
        <Rich />
      </Show>
    </div>
  );
}
