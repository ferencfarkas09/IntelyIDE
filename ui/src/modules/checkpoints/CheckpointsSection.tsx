import { createResource, createSignal, For, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { FormGroup, FormRow, Switch, toast } from "../../ui-kit";
import { checkpointsApi } from "./api";
import { errorText } from "./logic";
import { checkpointsEnabled, setCheckpointsEnabled, syncCheckpointsEnabled } from "./toggle";

/** Settings section: the toggle of the extra and the opt-in protection of ignored config files (off by default). */
export default function CheckpointsSection() {
  onMount(() => void syncCheckpointsEnabled());
  const [settings, { mutate }] = createResource(() => checkpointsApi().settings());
  const [busy, setBusy] = createSignal(false);
  const setProtect = async (on: boolean) => {
    setBusy(true);
    try {
      mutate(await checkpointsApi().setProtectConfig(on));
    } catch (e) {
      toast.error(t("checkpoints.section.protectFailed"), errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormGroup title={t("checkpoints.section.title")} description={t("checkpoints.section.desc")}>
      <FormRow label={t("checkpoints.section.enable")} description={t("checkpoints.section.enableDesc")}>
        <Switch checked={checkpointsEnabled()} onChange={setCheckpointsEnabled} aria-label={t("checkpoints.section.enable")} />
      </FormRow>
      <FormRow label={t("checkpoints.section.protect")} description={t("checkpoints.section.protectDesc")}>
        <Switch checked={settings()?.protectConfig === true} disabled={!settings() || busy()} onChange={(on) => void setProtect(on)} aria-label={t("checkpoints.section.protect")} />
      </FormRow>
      <Show when={settings()}>
        {(s) => (
          <p class="cp-section__names ui-text-3">
            {t("checkpoints.section.names")}{" "}
            <For each={s().names}>{(n, i) => <>{i() > 0 ? ", " : ""}<code class="ui-mono">{n}</code></>}</For>
          </p>
        )}
      </Show>
    </FormGroup>
  );
}
