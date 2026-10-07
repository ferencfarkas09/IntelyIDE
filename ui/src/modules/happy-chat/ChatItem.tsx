import { Show } from "solid-js";
import { t } from "../../i18n";
import { Icon, MessageSquare, StatusDot, Tooltip } from "../../ui-kit";
import { chatBadgeCount } from "./logic";
import { chatSummary, openChat } from "./state";
import "./chat.css";

export { chatBadgeCount };

/** Status bar: the chat bubble with the unread count, an accent dot while someone mentioned you. Click opens the Chat tab. */
export default function ChatItem() {
  const unread = () => chatSummary()?.unreadTotal ?? 0;
  const threads = () => chatSummary()?.threadUnread ?? 0;
  const shown = () => chatBadgeCount(chatSummary());
  const mentions = () => chatSummary()?.mentionTotal ?? 0;
  const offline = () => chatSummary()?.link === "reconnecting" || !!chatSummary()?.stale;
  const label = () => t("hc.status.label", { unread: unread(), mentions: mentions(), offline: offline() ? "yes" : "no" }) + (threads() > 0 ? t("hc.badge.threads", { threads: threads() }) : "");
  return (
    <Tooltip label={label()}>
      <button type="button" class="sb__item sb__attention hc-sb" data-unread={shown() ? "" : undefined} data-mention={mentions() ? "" : undefined} data-offline={offline() ? "" : undefined} aria-label={label()} onClick={() => openChat()}>
        <Icon icon={MessageSquare} size={12} />
        <Show when={shown() > 0}>
          <span class="hc-sb__count ui-tnum">{shown() > 99 ? "99+" : shown()}</span>
        </Show>
        <Show when={mentions() > 0}>
          <StatusDot tone="accent" size={6} label={t("hc.mentioned")} />
        </Show>
      </button>
    </Tooltip>
  );
}
