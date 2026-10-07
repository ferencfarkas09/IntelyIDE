import { createEffect, createSignal, on } from "solid-js";
import { t } from "../../i18n";
import type { ChatPerson } from "../../ipc/happy";
import { Button, Dialog } from "../../ui-kit";
import "./chat-dialogs.css";
import { MAX_GROUP_PEOPLE } from "./dialogs-logic";
import { PeoplePicker } from "./PeoplePicker";
import { openDirect } from "./state";

export interface NewMessageDialogProps {
  open: boolean;
  onClose: () => void;
}

/** Pick one person (direct message) or 2 to 7 (group conversation). The server reuses an existing conversation. */
export function NewMessageDialog(props: NewMessageDialogProps) {
  const [people, setPeople] = createSignal<ChatPerson[]>([]);
  const [pending, setPending] = createSignal(false);
  createEffect(on(() => props.open, (open) => open && (setPeople([]), setPending(false))));

  async function start() {
    if (!people().length || pending()) return;
    setPending(true);
    const channel = await openDirect(people().map((p) => p.id));
    setPending(false);
    if (channel) props.onClose();
  }

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={t("hc.dlg.msg.title")}
      description={t("hc.dlg.msg.desc")}
      class="hcd-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>{t("hc.dlg.cancel")}</Button>
          <Button variant="primary" loading={pending()} disabled={!people().length} onClick={start}>
            {people().length > 1 ? t("hc.dlg.msg.startGroup") : t("hc.dlg.msg.start")}
          </Button>
        </>
      }
    >
      <div class="hcd-form" onKeyDown={(e) => e.key === "Enter" && e.ctrlKey && void start()}>
        <PeoplePicker label={t("hc.dlg.msg.people")} selected={people()} onChange={setPeople} max={MAX_GROUP_PEOPLE} autofocus disabled={pending()} />
        <p class="hcd-hint">{t("hc.dlg.msg.groupHint")}</p>
      </div>
    </Dialog>
  );
}
