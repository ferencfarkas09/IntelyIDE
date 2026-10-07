import type { Component } from "solid-js";
import type { ChatSendExtras } from "../ipc/happy";
import { createRegistry } from "./registry";

/**
 * The hook for adding to a Team chat message (the attachments module uses it later; nothing registers yet).
 *
 * A module registers one extension. The Team chat composer then
 *  - renders `toolbar` next to the Send button, once per open conversation (give it a button that picks files, a chip row
 *    goes in `chips`); both receive the channel id and whether sending is currently disabled;
 *  - at send time calls `collect(channelId)` of every extension, in `order`, and passes the merged result as the fourth
 *    argument of `ipc.happy.chat.send` (`ChatSendExtras`; today only `attachmentIds`). Returning `{ block }` stops the send
 *    and shows that text under the composer (for example "May contain secrets, confirm first");
 *  - calls `clear(channelId)` once the message was accepted.
 *
 * Rust has to understand the extras (`attachmentIds` resolve to files the attachments module already copied into its
 * store); until then the composer only passes them on when an extension returned something.
 *
 *     registerChatComposerExtension({
 *       id: "attachments",
 *       toolbar: AttachButton,
 *       chips: AttachmentChips,
 *       collect: (channelId) => ({ attachmentIds: stagedIds(channelId) }),
 *       clear: (channelId) => unstage(channelId),
 *     });
 */
export interface ChatComposerProps {
  channelId: string;
  /** Sending is paused (no credits, offline sign-out): the extension should disable its controls. */
  disabled: boolean;
}

export interface ChatComposerExtension {
  id: string;
  /** Sort key; the first extension is the leftmost. */
  order?: number;
  toolbar?: Component<ChatComposerProps>;
  chips?: Component<ChatComposerProps>;
  /** Extras for the message about to be sent, or `{ block }` to stop it. May be async. */
  collect?: (channelId: string) => ChatSendExtras | { block: string } | undefined | Promise<ChatSendExtras | { block: string } | undefined>;
  clear?: (channelId: string) => void;
}

const registry = createRegistry<ChatComposerExtension>((e) => e.order ?? 0, "chatComposer");

export const registerChatComposerExtension = registry.register;
export const chatComposerExtensions = registry.items;
export const resetChatComposerExtensions = registry.clear;

/** Merges what the extensions collected. A `block` from any of them wins. */
export async function collectChatExtras(channelId: string): Promise<{ extras?: ChatSendExtras; block?: string }> {
  const ids: string[] = [];
  for (const ext of registry.items()) {
    const got = await ext.collect?.(channelId);
    if (!got) continue;
    if ("block" in got) return { block: got.block };
    ids.push(...(got.attachmentIds ?? []));
  }
  return ids.length ? { extras: { attachmentIds: ids } } : {};
}
