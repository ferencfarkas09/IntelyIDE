import { createMemo, For, Show } from "solid-js";
import { t } from "../../../i18n";
import type { WidgetProps } from "../../../platform/widgets";
import { AtSign, Badge, Button, KpiTile, MessageSquare } from "../../../ui-kit";
import { chatSummary, openChat } from "../../happy-chat/state";
import { CardEmpty, CardLoading } from "../parts";

/** Team & chat pulse: unread messages and mentions of the team chat, the busiest channels first. Only while chat is set up. */
export default function ChatPulse(props: WidgetProps) {
  const busy = createMemo(() =>
    (chatSummary()?.channels ?? [])
      .filter((c) => c.unreadCount > 0)
      .sort((a, b) => b.mentionCount - a.mentionCount || b.unreadCount - a.unreadCount)
      .slice(0, props.size === "s" ? 2 : 4),
  );
  return (
    <Show when={chatSummary()} fallback={<CardLoading />}>
      {(s) => (
        <>
          <div class="dash-kpis" data-size={props.size}>
            <KpiTile label={t("dash.chat.unread")} value={String(s().unreadTotal)} />
            <KpiTile label={t("dash.chat.mentions")} value={String(s().mentionTotal)} class={s().mentionTotal > 0 ? "dash-kpi--warn" : undefined} />
          </div>
          <Show when={busy().length > 0} fallback={<CardEmpty icon={MessageSquare} title={t("dash.chat.allRead")} why={t("dash.chat.allReadWhy")} />}>
            <ul class="dash-list">
              <For each={busy()}>
                {(c) => (
                  <li>
                    <button type="button" class="dash-row" onClick={() => openChat(c.id)}>
                      <span class="dash-row__main">
                        <span class="dash-row__title">
                          <span class="ui-truncate">#{c.name}</span>
                        </span>
                      </span>
                      <Show when={c.mentionCount > 0}>
                        <Badge size="sm" tone="danger" icon={AtSign} numeric>
                          {c.mentionCount}
                        </Badge>
                      </Show>
                      <Badge size="sm" numeric>
                        {c.unreadCount}
                      </Badge>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <div class="dash-actions">
            <Button size="sm" variant="ghost" onClick={() => openChat()}>
              {t("dash.chat.open")}
            </Button>
          </div>
        </>
      )}
    </Show>
  );
}
