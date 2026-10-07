// The chat's modal dialogs and the members panel are driven by these signals; `ChatDialogs` (mounted once in ChatTab) renders them.
import { createSignal } from "solid-js";
import { closeThread } from "./state";

export type ChatDialogKind = "newChannel" | "browse" | "newMessage" | "search";

const [dialog, setDialog] = createSignal<{ kind: ChatDialogKind; channelId?: string } | undefined>();
const [members, setMembers] = createSignal(false);

/** Which dialog is open (read by the `ChatDialogs` host). */
export const chatDialog = dialog;
export const closeChatDialog = (): void => {
  setDialog(undefined);
};

export const openNewChannel = (): void => {
  setDialog({ kind: "newChannel" });
};
export const openBrowseChannels = (): void => {
  setDialog({ kind: "browse" });
};
export const openNewMessage = (): void => {
  setDialog({ kind: "newMessage" });
};
/** Opens the search; with a channel id the search starts limited to that channel. */
export const openSearch = (channelId?: string): void => {
  setDialog({ kind: "search", channelId });
};

export const membersPanelOpen = (): boolean => members();
/** Opens the members panel; it replaces the thread panel. */
export function openMembers(): void {
  closeThread();
  setMembers(true);
}
export const closeMembers = (): void => {
  setMembers(false);
};
