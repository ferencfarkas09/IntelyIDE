import { createSignal } from "solid-js";
import { setToolWindow } from "../../platform/rail";

export interface RebaseRequest {
  repoId?: string;
  onto?: string;
}

const [request, setRequest] = createSignal<RebaseRequest | null>(null);

/** Non-null while the rebase dialog is open; the Log panel hosts the dialog. */
export const rebaseRequest = request;
export const closeRebase = (): void => void setRequest(null);

/** Opens the interactive rebase dialog (and the Log panel that hosts it). */
export function openRebase(repoId?: string, onto?: string): void {
  setToolWindow("bottom", "graph");
  setRequest({ repoId, onto });
}
