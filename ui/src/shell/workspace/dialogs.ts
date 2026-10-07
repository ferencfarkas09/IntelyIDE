import { createSignal } from "solid-js";
import type { Picked } from "../../ipc/picker";

/*
 * Open/closed state of the workspace dialogs and the switcher menu. Commands, Welcome and the title bar set it; the
 * components in this folder read it. Plain signals: nothing here knows how a dialog looks.
 */

export type ManageAction = "rename" | "recolor" | "remove";
export interface ManageRequest {
  /** Select this workspace and start the action on it. */
  id?: string;
  action?: ManageAction;
}

const [manageRequest, setManageRequest] = createSignal<ManageRequest | null>(null);
export const manageOpen = manageRequest;
export const openManage = (req: ManageRequest = {}): void => void setManageRequest(req);
export const closeManage = (): void => void setManageRequest(null);

export interface NewWorkspaceRequest {
  /** Folders to start with (a multi-folder drop, or the picks of a scan). */
  prefill?: Picked[];
}
const [newRequest, setNewRequest] = createSignal<NewWorkspaceRequest | null>(null);
export const newWorkspaceOpen = newRequest;
export const openNewWorkspace = (req: NewWorkspaceRequest = {}): void => void setNewRequest(req);
export const closeNewWorkspace = (): void => void setNewRequest(null);

/**
 * `target`: where the ticked repositories go. `pick` returns them to the caller (New workspace) through `onPick`.
 * `root`: a folder to scan right away (the "Scan this folder" offer of Open folder).
 */
export interface ScanRequest {
  target?: "new" | "current" | "pick";
  root?: string;
  onPick?: (picked: Picked[]) => void;
}
const [scanRequest, setScanRequest] = createSignal<ScanRequest | null>(null);
export const scanOpen = scanRequest;
export const openScan = (req: ScanRequest = {}): void => void setScanRequest(req);
export const closeScan = (): void => void setScanRequest(null);

const [switcher, setSwitcher] = createSignal(false);
export const switcherOpen = switcher;
export const setSwitcherOpen = setSwitcher;

export function resetWorkspaceDialogs(): void {
  setManageRequest(null);
  setNewRequest(null);
  setScanRequest(null);
  setSwitcher(false);
}
