import { History, IconButton, Menu, type MenuEntry } from "../../ui-kit";
import { t } from "../../i18n";
import { subjectOf } from "./logic";
import { messageHistory } from "./messageState";

function entries(onPick: (message: string) => void): MenuEntry[] {
  const history = messageHistory();
  if (!history.length) return [{ type: "label", label: t("commit.history.none") }];
  return [
    { type: "label", label: t("commit.history.recent") },
    ...history.map((message): MenuEntry => {
      const extra = message.split("\n").length - 1;
      return { label: subjectOf(message), description: extra > 0 ? t("commit.history.more", { n: extra }) : undefined, onSelect: () => onPick(message) };
    }),
  ];
}

/** Menu with the last messages (newest first); picking one hands it to `onPick`. */
export function MessageHistory(props: { onPick: (message: string) => void; size?: "sm" | "md"; /** The field the picked message lands in; it gets the focus back from the menu button. */ field?: () => HTMLElement | null | undefined }) {
  const pick = (message: string) => {
    props.onPick(message);
    // The menu hands focus back to its button as it closes; this runs after that.
    setTimeout(() => props.field?.()?.focus(), 0);
  };
  return (
    <Menu
      aria-label={t("commit.history")}
      placement="top-end"
      class="msg-history"
      items={entries(pick)}
      trigger={(tr) => <IconButton {...tr} icon={History} label={t("commit.history")} size={props.size ?? "sm"} />}
    />
  );
}
