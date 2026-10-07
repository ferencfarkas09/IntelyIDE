import { createSignal } from "solid-js";
import type { Candidate } from "./nameLookup";

export interface PickerState {
  name: string;
  candidates: Candidate[];
  note?: string;
}

const [inspecting, setInspecting] = createSignal(false);
const [picker, setPicker] = createSignal<PickerState | undefined>(undefined);

/** Inspect mode is on: every click in a preview frame maps to source (Alt/Cmd+click always does). */
export { inspecting, setInspecting, picker, setPicker };
