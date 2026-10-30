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

import type { StyleHint } from "./protocol";

export interface StyleInfo {
  hint: StyleHint;
  /** The preview tab's repository: where the CSS is searched. */
  repoId: string | undefined;
}

const [styleInfo, setStyleInfo] = createSignal<StyleInfo | undefined>(undefined);
/** The element Alt-clicked last, for the small style panel; undefined once the panel is closed. */
export { styleInfo, setStyleInfo };
