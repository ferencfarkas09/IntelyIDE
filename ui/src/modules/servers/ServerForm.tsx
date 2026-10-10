import { createSignal, Show } from "solid-js";
import { t } from "../../i18n";
import type { ServerCfg } from "../../ipc/servers";
import { Button, Dialog, FormRow, Input, Switch } from "../../ui-kit";
import { emptyForm, FIELD_OF_CODE, formFromCfg, toDraft, validateForm, type FormErrorKey, type FormField, type ServerFormValues } from "./logic";
import { messageOf, saveServer, servers } from "./store";

/** Add or edit a server. The checks run here first; the backend's own message is shown when it still refuses. */
export function ServerForm(props: { cfg?: ServerCfg; onClose: () => void; onSaved?: (cfg: ServerCfg) => void }) {
  const [f, setF] = createSignal<ServerFormValues>(props.cfg ? formFromCfg(props.cfg) : emptyForm());
  const [errors, setErrors] = createSignal<Partial<Record<FormField, string>>>({});
  const [general, setGeneral] = createSignal<string | undefined>(undefined);
  const [busy, setBusy] = createSignal(false);
  const set = (patch: Partial<ServerFormValues>) => setF({ ...f(), ...patch });
  const key = (k: FormErrorKey) => t(k);

  const submit = async (ev?: Event) => {
    ev?.preventDefault();
    if (busy()) return;
    const local = validateForm(f(), servers().map((s) => s.cfg));
    const keys = Object.keys(local) as FormField[];
    setGeneral(undefined);
    if (keys.length > 0) return setErrors(Object.fromEntries(keys.map((k) => [k, key(local[k]!)])));
    setErrors({});
    setBusy(true);
    try {
      const saved = await saveServer(toDraft(f()));
      props.onSaved?.(saved);
      props.onClose();
    } catch (e) {
      const field = FIELD_OF_CODE[(e as { code?: string } | null)?.code ?? ""];
      if (field) setErrors({ [field]: messageOf(e) });
      else setGeneral(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const hint = (field: FormField, text: string) => (errors()[field] ? <span class="srv-err" role="alert">{errors()[field]}</span> : text);
  const id = (n: string) => `srv-form-${n}`;

  return (
    <Dialog
      open
      onClose={props.onClose}
      title={props.cfg ? t("servers.form.editTitle") : t("servers.form.addTitle")}
      description={t("servers.form.desc")}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>{t("servers.form.cancel")}</Button>
          <Button variant="primary" loading={busy()} onClick={() => void submit()}>{props.cfg ? t("servers.form.save") : t("servers.form.add")}</Button>
        </>
      }
    >
      <form onSubmit={(e) => void submit(e)} noValidate>
        <FormRow label={t("servers.form.name")} labelFor={id("name")} description={hint("name", t("servers.form.nameHint"))}>
          <Input id={id("name")} data-autofocus size="sm" value={f().name} invalid={!!errors().name} placeholder="Build server" onInput={(e) => set({ name: e.currentTarget.value })} />
        </FormRow>
        <FormRow label={t("servers.form.destination")} labelFor={id("dest")} description={hint("destination", t("servers.form.destinationHint"))}>
          <Input id={id("dest")} size="sm" value={f().destination} invalid={!!errors().destination} placeholder="build1" autocomplete="off" autocapitalize="off" spellcheck={false} onInput={(e) => set({ destination: e.currentTarget.value })} />
        </FormRow>
        <FormRow label={t("servers.form.port")} labelFor={id("port")} description={hint("port", t("servers.form.portHint"))}>
          <Input id={id("port")} size="sm" inputmode="numeric" value={f().port} invalid={!!errors().port} placeholder="22" onInput={(e) => set({ port: e.currentTarget.value })} />
        </FormRow>
        <FormRow label={t("servers.form.root")} labelFor={id("root")} description={hint("root", t("servers.form.rootHint"))}>
          <Input id={id("root")} size="sm" value={f().root} invalid={!!errors().root} spellcheck={false} onInput={(e) => set({ root: e.currentTarget.value })} />
        </FormRow>
        <FormRow label={t("servers.form.maxAgents")} labelFor={id("max")} description={hint("maxAgents", t("servers.form.maxAgentsHint"))}>
          <Input id={id("max")} size="sm" inputmode="numeric" value={f().maxAgents} invalid={!!errors().maxAgents} onInput={(e) => set({ maxAgents: e.currentTarget.value })} />
        </FormRow>
        <FormRow label={t("servers.form.enabled")} description={t("servers.form.enabledHint")}>
          <Switch checked={f().enabled} onChange={(enabled) => set({ enabled })} aria-label={t("servers.form.enabled")} />
        </FormRow>
        <Show when={general()}>{(m) => <p class="srv-form__error" role="alert">{m()}</p>}</Show>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
