import { createSignal } from "solid-js";

/** `pr.create` bumps this; the open (or just opened) tab shows the Create PR dialog when it changes. */
export const [createRequests, setCreateRequests] = createSignal(0);
