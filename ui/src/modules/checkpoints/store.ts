// What the checkpoint dialogs show, shared by the header buttons, the timeline and the palette commands (the dialogs live in one
// overlay), and a counter that tells every open timeline to read the list again after a save point or a restore.
import { createSignal } from "solid-js";

export interface RestoreRequest {
  runId: string;
  seq: number;
  /** "undo": opened by Undo last step (the title says so). */
  mode: "undo" | "pick";
}

const [restoreReq, setRestoreReq] = createSignal<RestoreRequest | undefined>(undefined);
const [saveFor, setSaveFor] = createSignal<string | undefined>(undefined);
const [version, setVersion] = createSignal(0);

export const restoreRequest = restoreReq;
export const savePointFor = saveFor;
/** Read inside an effect to refetch after a change. */
export const checkpointsVersion = version;

export const openRestore = (req: RestoreRequest): void => void setRestoreReq(req);
export const closeRestore = (): void => void setRestoreReq(undefined);
export const openSavePoint = (runId: string): void => void setSaveFor(runId);
export const closeSavePoint = (): void => void setSaveFor(undefined);
export const checkpointsChanged = (): void => void setVersion((v) => v + 1);
