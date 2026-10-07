import { createEffect, createSignal, createUniqueId, on, Show } from "solid-js";
import { t } from "../../i18n";
import type { ChatPerson } from "../../ipc/happy";
import { Button, Dialog, Hash, Icon, Input, Lock, TextArea } from "../../ui-kit";
import "./chat-dialogs.css";
import { cleanChannelName, MAX_CHANNEL_NAME, MAX_DESCRIPTION, nameFieldError } from "./dialogs-logic";
import { PeoplePicker } from "./PeoplePicker";
import { ChatActionError, createChannel } from "./state";

export interface NewChannelDialogProps {
  open: boolean;
  onClose: () => void;
}

export function NewChannelDialog(props: NewChannelDialogProps) {
  const id = createUniqueId();
  const [priv, setPriv] = createSignal(false);
  const [name, setName] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [members, setMembers] = createSignal<ChatPerson[]>([]);
  const [pending, setPending] = createSignal(false);
  const [nameError, setNameError] = createSignal<string>();
  const [formError, setFormError] = createSignal<string>();

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        setPriv(false);
        setName("");
        setDescription("");
        setMembers([]);
        setPending(false);
        setNameError(undefined);
        setFormError(undefined);
      },
    ),
  );

  const clean = () => cleanChannelName(name());

  async function submit() {
    if (pending()) return;
    if (!clean()) {
      setNameError(t("hc.err.NAME_REQUIRED"));
      return;
    }
    setPending(true);
    setNameError(undefined);
    setFormError(undefined);
    try {
      await createChannel({ name: clean(), description: description().trim() || undefined, private: priv(), memberIds: members().map((m) => m.id) });
      props.onClose();
    } catch (e) {
      const code = e instanceof ChatActionError ? e.code : "";
      const text = e instanceof ChatActionError ? e.message : t("hc.err.generic");
      if (code === "CREATE_FORBIDDEN") setFormError(t("hc.dlg.new.forbidden"));
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
      title={t("hc.dlg.new.title")}
      description={t("hc.dlg.new.desc")}
      size="md"
      class="hcd-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>{t("hc.dlg.cancel")}</Button>
          <Button variant="primary" loading={pending()} disabled={!clean()} onClick={submit}>{t("hc.dlg.new.create")}</Button>
        </>
      }
    >
      <div class="hcd-form">
        <div class="hcd-field" role="radiogroup" aria-label={t("hc.dlg.new.type")}>
          <label class="hcd-choice" data-checked={!priv() ? "" : undefined}>
            <input type="radio" name={`${id}-type`} class="hcd-choice__input" checked={!priv()} disabled={pending()} onChange={() => setPriv(false)} />
            <Icon icon={Hash} size={16} />
            <span class="hcd-choice__text">
              <span class="hcd-choice__title">{t("hc.dlg.new.public")}</span>
              <span class="hcd-choice__help">{t("hc.dlg.new.publicHelp")}</span>
            </span>
          </label>
          <label class="hcd-choice" data-checked={priv() ? "" : undefined}>
            <input type="radio" name={`${id}-type`} class="hcd-choice__input" checked={priv()} disabled={pending()} onChange={() => setPriv(true)} />
            <Icon icon={Lock} size={16} />
            <span class="hcd-choice__text">
              <span class="hcd-choice__title">{t("hc.dlg.new.private")}</span>
              <span class="hcd-choice__help">{t("hc.dlg.new.privateHelp")}</span>
            </span>
          </label>
        </div>

        <div class="hcd-field">
          <label class="hcd-label" for={`${id}-name`}>{t("hc.dlg.new.name")}</label>
          <Input
            id={`${id}-name`}
            data-autofocus
            leading={<Icon icon={priv() ? Lock : Hash} size={14} />}
            placeholder={t("hc.dlg.new.namePlaceholder")}
            maxLength={MAX_CHANNEL_NAME}
            invalid={!!nameError()}
            aria-describedby={nameError() ? `${id}-nameerr` : undefined}
            disabled={pending()}
            value={name()}
            onInput={(e) => {
              setName(e.currentTarget.value);
              setNameError(undefined);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.isComposing) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <Show when={nameError()}>
            <p class="hcd-error" id={`${id}-nameerr`} role="alert">{nameError()}</p>
          </Show>
        </div>

        <div class="hcd-field">
          <label class="hcd-label" for={`${id}-desc`}>
            {t("hc.dlg.new.description")} <span class="hcd-optional">{t("hc.dlg.optional")}</span>
          </label>
          <TextArea id={`${id}-desc`} minRows={2} maxRows={4} maxLength={MAX_DESCRIPTION} placeholder={t("hc.dlg.new.descriptionPlaceholder")} disabled={pending()} value={description()} onInput={(e) => setDescription(e.currentTarget.value)} />
        </div>

        <div class="hcd-field">
          <span class="hcd-label">
            {t("hc.dlg.new.members")} <span class="hcd-optional">{t("hc.dlg.optional")}</span>
          </span>
          <PeoplePicker label={t("hc.dlg.new.members")} selected={members()} onChange={setMembers} disabled={pending()} />
        </div>

        <Show when={formError()}>
          <p class="hcd-error hcd-error--form" role="alert">{formError()}</p>
        </Show>
      </div>
    </Dialog>
  );
}
