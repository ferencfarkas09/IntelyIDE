import { createSignal, For, Show } from "solid-js";
import { t } from "../../i18n";
import type { ChatMessage } from "../../ipc/happy";
import { Copy, Ellipsis, IconButton, Menu, MessageSquareReply, Pencil, Pin, PinOff, Popover, SmilePlus, toast, Trash2, type MenuEntry } from "../../ui-kit";
import { QUICK_REACTIONS } from "./logic";
import { chatErrorText, openThread, pinMessage, toggleReaction } from "./state";

/** A rejected action as a toast (the text is already translated; message bodies are never logged). */
export const actionFailed = (e: unknown): void => {
  toast.show({ title: t("hc.msg.failed"), description: chatErrorText(e), tone: "danger" });
};

export const react = (m: Pick<ChatMessage, "id">, emoji: string): void => {
  toggleReaction(m.id, emoji).catch(actionFailed);
};

/** Copies the text of a message; the clipboard may be unavailable, which is silent. */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(t("hc.msg.copied"));
  } catch {
    /* no clipboard permission: nothing to tell */
  }
}

/**
 * The hover / focus-within toolbar of a message: reply in thread (not inside a thread), react (emoji popover) and a menu with
 * Edit and Delete (own messages), Pin / Unpin and Copy. Always in the DOM so the keyboard reaches it.
 */
export function MessageActions(props: { msg: ChatMessage; inThread: boolean; onEdit: () => void; onDelete: () => void; onOpenChange: (open: boolean) => void }) {
  const m = () => props.msg;
  const [open, setOpen] = createSignal({ react: false, more: false });
  const change = (key: "react" | "more", v: boolean) => {
    setOpen((o) => ({ ...o, [key]: v }));
    props.onOpenChange(open().react || open().more);
  };
  const items = (): MenuEntry[] => [
    ...(m().mine ? ([{ label: t("hc.msg.edit"), icon: Pencil, onSelect: props.onEdit }] as MenuEntry[]) : []),
    { label: m().pinned ? t("hc.msg.unpin") : t("hc.msg.pin"), icon: m().pinned ? PinOff : Pin, onSelect: () => void pinMessage(m().id, !m().pinned).catch(actionFailed) },
    { label: t("hc.msg.copy"), icon: Copy, onSelect: () => void copyText(m().text) },
    ...(m().mine ? ([{ type: "separator" }, { label: t("hc.msg.delete"), icon: Trash2, danger: true, onSelect: props.onDelete }] as MenuEntry[]) : []),
  ];
  return (
    <div class="hc-msg__actions" role="toolbar" aria-label={t("hc.msg.actions")}>
      <Show when={!props.inThread}>
        <IconButton icon={MessageSquareReply} label={t("hc.msg.reply")} size="sm" onClick={() => void openThread(m().channelId, m().id)} />
      </Show>
      <Popover
        kind="dialog"
        placement="bottom-end"
        aria-label={t("hc.msg.pickReaction")}
        onOpenChange={(v) => change("react", v)}
        trigger={(tr) => <IconButton {...tr} icon={SmilePlus} label={t("hc.msg.react")} size="sm" />}
      >
        {(api) => (
          <div class="hc-emoji" role="group" aria-label={t("hc.msg.pickReaction")}>
            <For each={QUICK_REACTIONS}>
              {(emoji) => (
                <button
                  type="button"
                  class="hc-emoji__btn"
                  aria-label={emoji}
                  data-on={m().reactions.some((r) => r.emoji === emoji && r.mine) ? "" : undefined}
                  onClick={() => {
                    react(m(), emoji);
                    api.close();
                  }}
                >
                  {emoji}
                </button>
              )}
            </For>
          </div>
        )}
      </Popover>
      <Menu items={items()} placement="bottom-end" aria-label={t("hc.msg.more")} onOpenChange={(v) => change("more", v)} trigger={(tr) => <IconButton {...tr} icon={Ellipsis} label={t("hc.msg.more")} size="sm" />} />
    </div>
  );
}
