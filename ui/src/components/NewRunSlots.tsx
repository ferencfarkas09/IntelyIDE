import { For, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { newRunSlots, type NewRunSlot, type NewRunSlotContext } from "../platform/newRunSlots";

/** Mounts the controls other modules registered for one place of the New Run dialog; nothing when there are none. */
export function NewRunSlots(props: { place: NewRunSlot["place"]; ctx: NewRunSlotContext }) {
  return (
    <Show when={newRunSlots(props.place).length > 0}>
      <div class={`newrun__slots newrun__slots--${props.place}`}>
        <For each={newRunSlots(props.place)}>{(s) => <Dynamic component={s.component} ctx={props.ctx} />}</For>
      </div>
    </Show>
  );
}
