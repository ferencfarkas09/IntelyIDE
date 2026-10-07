import { createSignal } from "solid-js";

/** Contract between the About card (opens) and the open-source licenses view (renders): see (design notes: licensing-spec) 8.4. */
export interface OpenLicensesOptions {
  /** "project" = the pinned IntelyIDE entry; any other string = a component id. */
  select?: "project" | string;
}

const [state, setState] = createSignal<{ open: boolean; ever: boolean; select?: string }>({ open: false, ever: false });

export const licensesState = state;
export const openLicenses = (opts: OpenLicensesOptions = {}) => setState({ open: true, ever: true, select: opts.select });
export const closeLicenses = () => setState((s) => ({ ...s, open: false }));
