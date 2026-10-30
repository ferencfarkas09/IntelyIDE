import { createSignal, onMount, Show } from "solid-js";
import { t, type MessageKey } from "../../i18n";
import { ipc } from "../../ipc";
import type { PermissionMode } from "../../store/agent-types";
import { FormGroup, FormRow, SegmentedControl, Switch, toast } from "../../ui-kit";
import { effectiveStartMode, modeOf, presetOf, PRESETS, type PresetId } from "./logic";
import { SecretGuardOffer, secretGuardOn } from "./SecretGuardOffer";
import { presetsEnabled, setPresetsEnabled, syncPresetsEnabled } from "./toggle";
import "./presets.css";

/**
 * Settings > Agents: how much a new run may do on its own. The preset picked here is the mode every New Run dialog starts
 * with (`runs.defaultMode`); without one the dialog starts with the mode of the last run. Plan and Bypass stay on the cards.
 */
export default function AgentsSection() {
  const [mode, setMode] = createSignal<PermissionMode | undefined>();
  onMount(() => {
    void syncPresetsEnabled();
    void ipc.settings.get("runs").then((v) => setMode(effectiveStartMode(v)), () => {});
  });
  const pick = (id: PresetId | "custom") => {
    if (id === "custom") return;
    const next = modeOf(id);
    setMode(next);
    void ipc.settings.set("runs", { defaultMode: next }).catch((e) => toast.error(t("presets.saveFailed"), String((e as { message?: string }).message ?? e)));
  };
  return (
    <>
      <FormGroup title={t("presets.section.title")} description={t("presets.section.desc")}>
        <FormRow label={t("presets.section.default")} description={presetOf(mode()) ? t(`presets.${presetOf(mode())}.desc` as MessageKey) : t("presets.section.defaultOther")} stacked>
          <SegmentedControl<PresetId | "custom"> size="sm" aria-label={t("presets.section.default")} options={PRESETS.map((p) => ({ value: p.id, label: t(`presets.${p.id}` as MessageKey) }))} value={presetOf(mode()) ?? "custom"} onChange={pick} />
        </FormRow>
        <FormRow label={t("presets.section.enable")} description={t("presets.section.enableDesc")}>
          <Switch checked={presetsEnabled()} onChange={setPresetsEnabled} aria-label={t("presets.section.enable")} />
        </FormRow>
        <p class="presets__desc">{t("presets.section.hardStopsDesc")}</p>
      </FormGroup>
      <FormGroup title={t("presets.section.secretTitle")} description={t("presets.section.secretDesc")}>
        <Show when={secretGuardOn()} fallback={<SecretGuardOffer />}>
          <p class="presets__desc" role="status">{t("presets.secretIsOn")}</p>
        </Show>
      </FormGroup>
    </>
  );
}
