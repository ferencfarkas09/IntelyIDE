import { For } from "solid-js";
import { Dynamic } from "solid-js/web";
import { runSlots, type RunSlot } from "../platform/runSlots";
import type { AgentRow } from "../store/agents";

/** Renders the slots modules registered for one place of a run (see `platform/runSlots.ts`). */
export function RunSlots(props: { place: RunSlot["place"]; agent: AgentRow }) {
  return <For each={runSlots(props.place)}>{(s) => <Dynamic component={s.component} agent={props.agent} />}</For>;
}
