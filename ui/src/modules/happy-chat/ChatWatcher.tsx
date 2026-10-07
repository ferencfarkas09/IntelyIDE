import { createEffect, onCleanup } from "solid-js";
import { ipc } from "../../ipc";
import { chatLive, chatTabShown, startChat, viewingChannel } from "./state";

/** Mounted once under the shell. Subscribes to the chat events and reads the summary only while Team chat is up; leaving that state frees everything. */
export default function ChatWatcher() {
  createEffect(() => {
    if (!chatLive()) return;
    onCleanup(startChat());
  });
  // What the user is looking at: Rust polls the open conversation only while the tab is on screen and skips its toasts.
  createEffect(() => {
    if (!chatLive()) return;
    const open = chatTabShown();
    const channel = open ? (viewingChannel() ?? null) : null;
    void ipc.happy.chat.setActive(open, channel).catch(() => {});
  });
  return null;
}
