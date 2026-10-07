import { lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { openDockTab, registerDockTab } from "../../platform/dock";
import { registerOverlay } from "../../platform/overlay";
import { registerStatusItem } from "../../platform/statusbar";
import { inboxBadgeVisible, inboxView, ntReady } from "../../store/happyNt";
import { Inbox } from "../../ui-kit";
import { markAllRead } from "./actions";
import Gate from "./Gate";

/**
 * Notifications inbox ((design notes: integrations-plan) E3): an unread badge in the status bar, an Inbox dock tab, and toasts for
 * what arrives. Heavy parts are lazy chunks, fetched only once the provider is on.
 */
export function register(): void {
  registerStatusItem({ id: "happy-inbox", align: "right", order: 7, component: lazy(() => import("./InboxItem")), when: inboxBadgeVisible });
  registerDockTab({ id: "inbox", get title() { return t("hn.name"); }, icon: Inbox, component: lazy(() => import("./InboxTab")) });
  registerOverlay({ id: "happy-inbox-toasts", component: Gate });
  registerCommand({ id: "inbox.show", get title() { return t("hn.cmd.show"); }, get group() { return t("hn.name"); }, keywords: ["notifications", "bell", "unread", "mentions"], when: () => ntReady("notifications"), run: () => openDockTab("inbox") });
  registerCommand({
    id: "inbox.markAllRead",
    get title() { return t("hn.cmd.markAll"); },
    get group() { return t("hn.name"); },
    keywords: ["notifications", "clear", "unread"],
    when: () => ntReady("notifications") && inboxView().unread > 0,
    run: () => void markAllRead(),
  });
}
