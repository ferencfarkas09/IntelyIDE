// The two small dialogs of the channel header menu: edit name / description / topic, and the leave confirmation.
import { createEffect, createSignal, createUniqueId, on, Show } from "solid-js";
import { t } from "../../i18n";
import type { ChatChannel } from "../../ipc/happy";
import { Button, Dialog, Hash, Icon, Input, Lock, TextArea } from "../../ui-kit";
import "./chat-dialogs.css";
import { cleanChannelName, MAX_CHANNEL_NAME, MAX_DESCRIPTION, nameFieldError } from "./dialogs-logic";
import { ChatActionError, leaveChannel, updateChannelInfo } from "./state";

interface ChannelDialogProps {
  open: boolean;
  channel: ChatChannel;
  onClose: () => void;
}

export function EditChannelDialog(props: ChannelDialogProps) {
  const id = createUniqueId();
  const [name, setName] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [topic, setTopic] = createSignal("");
  const [pending, setPending] = createSignal(false);
  const [nameError, setNameError] = createSignal<string>();
  const [formError, setFormError] = createSignal<string>();

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        setName(props.channel.name);
        setDescription(props.channel.description);
        setTopic(props.channel.topic);
        setPending(false);
        setNameError(undefined);
        setFormError(undefined);
      },
    ),
  );

  async function save() {
    if (pending()) return;
    const next = cleanChannelName(name());
    if (!next) return setNameError(t("hc.err.NAME_REQUIRED"));
    const c = props.channel;
    const patch: { name?: string; description?: string; topic?: string } = {};
    if (next !== c.name) patch.name = next;
    if (description().trim() !== c.description) patch.description = description().trim();
    if (topic().trim() !== c.topic) patch.topic = topic().trim();
    if (!Object.keys(patch).length) return props.onClose();
    setPending(true);
    setNameError(undefined);
    setFormError(undefined);
    try {
      await updateChannelInfo(c.id, patch);
      props.onClose();
    } catch (e) {
      const code = e instanceof ChatActionError ? e.code : "";
      const text = e instanceof ChatActionError ? e.message : t("hc.err.generic");
      if (code === "MANAGE_FORBIDDEN") setFormError(t("hc.dlg.edit.forbidden"));
      else if (nameFieldError(code)) setNameError(text);
      else setFormError(text);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={t("hc.dlg.edit.title")}
      class="hcd-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>{t("hc.dlg.cancel")}</Button>
          <Button variant="primary" loading={pending()} disabled={!cleanChannelName(name())} onClick={save}>{t("hc.dlg.edit.save")}</Button>
        </>
      }
    >
      <div class="hcd-form">
        <div class="hcd-field">
          <label class="hcd-label" for={`${id}-name`}>{t("hc.dlg.new.name")}</label>
          <Input
            id={`${id}-name`}
            data-autofocus
            leading={<Icon icon={props.channel.kind === "private" ? Lock : Hash} size={14} />}
            maxLength={MAX_CHANNEL_NAME}
            invalid={!!nameError()}
            disabled={pending()}
            value={name()}
            onInput={(e) => (setName(e.currentTarget.value), setNameError(undefined))}
            onKeyDown={(e) => e.key === "Enter" && !e.isComposing && (e.preventDefault(), void save())}
          />
          <Show when={nameError()}>
            <p class="hcd-error" role="alert">{nameError()}</p>
          </Show>
        </div>
        <div class="hcd-field">
          <label class="hcd-label" for={`${id}-topic`}>{t("hc.dlg.edit.topic")}</label>
          <Input id={`${id}-topic`} maxLength={MAX_DESCRIPTION} placeholder={t("hc.dlg.edit.topicPlaceholder")} disabled={pending()} value={topic()} onInput={(e) => setTopic(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && !e.isComposing && (e.preventDefault(), void save())} />
        </div>
        <div class="hcd-field">
          <label class="hcd-label" for={`${id}-desc`}>{t("hc.dlg.new.description")}</label>
          <TextArea id={`${id}-desc`} minRows={2} maxRows={5} maxLength={MAX_DESCRIPTION} disabled={pending()} value={description()} onInput={(e) => setDescription(e.currentTarget.value)} />
        </div>
        <Show when={formError()}>
          <p class="hcd-error hcd-error--form" role="alert">{formError()}</p>
        </Show>
      </div>
    </Dialog>
  );
}

export function LeaveChannelDialog(props: ChannelDialogProps) {
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string>();
  createEffect(on(() => props.open, (open) => open && (setPending(false), setError(undefined))));

  async function leave() {
    setPending(true);
    setError(undefined);
    try {
      await leaveChannel(props.channel.id);
      props.onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  const label = () => (props.channel.kind === "channel" ? `#${props.channel.name}` : props.channel.name);
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      role="alertdialog"
      size="sm"
      title={t("hc.dlg.leave.title", { name: label() })}
      description={props.channel.kind === "private" ? t("hc.dlg.leave.private") : t("hc.dlg.leave.public")}
      class="hcd-dialog"
      initialFocus={() => document.querySelector<HTMLElement>("[data-hcd-cancel]")}
      footer={
        <>
          <Button variant="ghost" data-hcd-cancel onClick={props.onClose}>{t("hc.dlg.cancel")}</Button>
          <Button variant="danger" loading={pending()} onClick={leave}>{t("hc.dlg.leave.confirm")}</Button>
        </>
      }
    >
      <Show when={error()}>
        <p class="hcd-error hcd-error--form" role="alert">{error()}</p>
      </Show>
    </Dialog>
  );
}
