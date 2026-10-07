import { createSignal } from "solid-js";
import type { RollbackTarget } from "./logic";

/** The repo whose branch popup is open (the title bar pills read it), or null. */
export const [popupRepo, setPopupRepo] = createSignal<string | null>(null);

export type BranchDialog =
  | { kind: "newBranch"; repoId: string; from?: string }
  | { kind: "delete"; repoId: string; name: string; live: boolean; needsForce: boolean }
  | { kind: "switchAll"; name?: string }
  | { kind: "rollback"; targets: RollbackTarget[] }
  | { kind: "stashDrop"; repoId: string; index: number; message: string };

const [dialog, setDialog] = createSignal<BranchDialog | null>(null);
const [dialogsRequested, setRequested] = createSignal(false);
export { dialog, dialogsRequested };

/** Opens a dialog; the shell mounts the lazy dialog host the first time one is requested. */
export function openDialog(next: BranchDialog): void {
  setRequested(true);
  setDialog(next);
}
export const closeDialog = (): void => void setDialog(null);

/** Bumped after every branch or stash change, so open lists load again. */
const [rev, setRev] = createSignal(0);
export const branchesRev = rev;
export const bumpBranches = (): void => void setRev((n) => n + 1);
