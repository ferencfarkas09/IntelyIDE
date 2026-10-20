import { lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { registerDockTab } from "../../platform/dock";
import { registerAgentPanel } from "../../platform/mode";
import { registerRailItem } from "../../platform/rail";
import { registerOverlay } from "../../platform/overlay";
import { registerStatusItem } from "../../platform/statusbar";
import { MessageSquare } from "../../ui-kit";
import { chatBadgeCount } from "./logic";
import { chatItemVisible, chatLive, chatSummary, chatTabShown, focusChatSearch, showChat, toggleChat } from "./state";

/**
 * Team chat ((design notes: integrations-plan) 2.2): the Chat dock tab, the status-bar bubble with the unread count, and toasts for
 * mentions and direct messages. Everything heavy is a lazy chunk; the watcher subscribes to events only while chat is up.
 *
 * Hook for other modules: `platform/chatComposer.ts` (registerChatComposerExtension) lets the attachments module add a button,
 * chips and files to a message later.
 */
export function register(): void {
  registerOverlay({ id: "happy-chat-watch", component: lazy(() => import("./ChatWatcher")) });
  registerStatusItem({ id: "happy-chat", align: "right", order: 4, component: lazy(() => import("./ChatItem")), when: chatItemVisible });
  // The rail entry is the "when to open it" signal: a badge with the unread total, danger-toned while someone mentioned you.
  const unread = () => chatBadgeCount(chatSummary());
  const mentions = () => chatSummary()?.mentionTotal ?? 0;
  registerRailItem({
    id: "chat",
    icon: MessageSquare,
    get title() { return t("hc.rail.title"); },
    order: 65,
    position: "left",
    when: chatLive,
    badge: unread,
    badgeMax: 99,
    badgeUrgent: () => mentions() > 0,
    label: () => t("hc.status.label", { unread: unread(), mentions: mentions(), offline: "no" }),
    pressed: chatTabShown,
    run: toggleChat,
  });
  registerDockTab({ id: "chat", get title() { return t("hc.name"); }, icon: MessageSquare, component: lazy(() => import("./ChatTab")) });
  // In Agent mode the editor area (and its dock) is not on screen: the chat sits in a column beside the run instead.
  registerAgentPanel({ id: "chat", get title() { return t("hc.name"); }, component: lazy(() => import("./ChatTab")), when: chatLive });
  registerCommand({ id: "chat.show", get title() { return t("hc.cmd.show"); }, get group() { return t("hc.name"); }, keywords: ["messages", "team", "conversation", "csapatchat"], when: chatLive, run: showChat });
  registerCommand({ id: "chat.goto", get title() { return t("hc.cmd.goto"); }, get group() { return t("hc.name"); }, keywords: ["dm", "direct", "channel", "switch", "search"], when: chatLive, run: focusChatSearch });
}
