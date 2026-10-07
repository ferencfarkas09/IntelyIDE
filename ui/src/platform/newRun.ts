import { createSignal } from "solid-js";
import { execute } from "./commands";

/** What a module hands the New Run dialog: text for the prompt box and the repositories to start with. */
export interface NewRunPrefill {
  prompt: string;
  /** Workspace repo ids; empty or missing leaves the role's default scope. */
  repoIds?: string[];
}

const [pending, setPending] = createSignal<NewRunPrefill>();

/** The request waiting for the dialog (reactive, so an already open dialog can pick it up). */
export const newRunPrefill = pending;

/**
 * Opens the New Run dialog prefilled. It only fills the form: nothing runs until the user presses Start run, and the role
 * stays their choice. Resolves false when the dialog could not be opened (the `runs.new` command is not registered).
 */
export async function requestNewRun(prefill: NewRunPrefill): Promise<boolean> {
  setPending(prefill);
  const opened = await execute("runs.new");
  if (!opened) setPending(undefined);
  return opened;
}

/** The dialog calls this when it opens; the prefill is used once. */
export function takeNewRunPrefill(): NewRunPrefill | undefined {
  const p = pending();
  setPending(undefined);
  return p;
}
